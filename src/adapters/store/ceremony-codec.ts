// SPDX-License-Identifier: Apache-2.0
// Retrospective to record and back, over the one record grammar every file in the store
// shares. The grammar knows lines; this file knows the retrospective's field dictionary:
// which keys are single-line, that the two prose halves are H2 sections, how the action
// list is spelled, and the order a rendered record takes. It is the sprint codec's shape
// over a smaller dictionary.

import { CEREMONY_FIELDS, validateCeremony, type Ceremony } from '../../domain/index.ts'
import { storeFail, storeOk, type StoreResult } from '../../application/ports/store.ts'
import { unwritableBodyLine, type ParsedRecord, type Section } from './grammar.ts'

/** The single-line fields, in render order. `type` names the record kind for the grammar's resynchroniser. */
const FIELD_ORDER = ['type', 'state', 'filed_at', 'version', 'sprint_id', 'actions'] as const

const WELL_SECTION = 'Went well'
const BADLY_SECTION = 'Went badly'

/** `type: retro` is a constant line, as `type: sprint` is: the damaged-heading rule keys on it. */
const KIND = 'retro'

const KNOWN: ReadonlySet<string> = new Set([...CEREMONY_FIELDS, 'type'])

/** The section names, as the field they decode into. */
const SECTIONS = [[WELL_SECTION, 'well'], [BADLY_SECTION, 'badly']] as const

function refuse<T>(rule: string, reason: string, id: string): StoreResult<T> {
  return storeFail('VALIDATION', rule, reason, [id])
}

export function decodeCeremony(record: ParsedRecord): StoreResult<Ceremony> {
  const draft: Record<string, unknown> = { id: record.id, title: record.title }
  const extra = new Map<string, string>()

  for (const [key, value] of record.fields) {
    if (key === 'type') {
      if (value !== KIND) return refuse('S1', `${record.id}: a record in the ceremonies layout is type ${KIND}, not "${value}"`, record.id)
      continue
    }
    // `well` and `badly` are sections, so a field line spelling either is a newer writer's
    // key and is preserved verbatim rather than read as one of ours.
    if (!KNOWN.has(key) || key === 'extra' || key === 'id' || key === 'title' || key === 'well' || key === 'badly') {
      extra.set(key, value)
      continue
    }
    if (key === 'version') {
      if (!/^\d{1,15}$/.test(value)) return refuse('S1', `${record.id}: ${key} must be a whole number, not "${value}"`, record.id)
      draft[key] = Number(value)
      continue
    }
    if (key === 'actions') {
      draft[key] = value.split(', ')
      continue
    }
    draft[key] = value
  }
  if (!record.fields.has('type')) return refuse('S1', `${record.id}: a ceremony record carries type: ${KIND}`, record.id)

  for (const [name, field] of SECTIONS) {
    const section = record.sections.find((held) => held.name === name)
    if (section !== undefined) draft[field] = section.body
  }
  if (extra.size > 0) draft['extra'] = extra

  const valid = validateCeremony(draft as unknown as Ceremony)
  if (!valid.ok) {
    return storeFail('VALIDATION', valid.error.rule ?? 'V4', `${record.id}: ${valid.error.message}`, [record.id])
  }
  return storeOk(valid.value)
}

export type EncodedCeremony = {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
}

/**
 * One retrospective to one record. As with an item and a sprint, every field key and section
 * this tool does not know is carried over from the stored record unchanged (DR3), so an older
 * tool writing a newer ceremony file loses nothing it did not understand.
 */
export function encodeCeremony(ceremony: Ceremony, base?: ParsedRecord): StoreResult<EncodedCeremony> {
  const valid = validateCeremony(ceremony)
  if (!valid.ok) {
    return storeFail('VALIDATION', valid.error.rule ?? 'V4', `${ceremony.id}: ${valid.error.message}`, [ceremony.id])
  }

  const fields = new Map<string, string>()
  for (const key of FIELD_ORDER) {
    if (key === 'type') { fields.set(key, KIND); continue }
    const value = ceremony[key]
    if (value === undefined) continue
    fields.set(key, key === 'actions' ? (value as readonly string[]).join(', ') : String(value))
  }
  const carried = new Map<string, string>()
  if (base !== undefined) {
    for (const [key, value] of base.fields) {
      if (!KNOWN.has(key) && !fields.has(key)) carried.set(key, value)
    }
  }
  for (const [key, value] of ceremony.extra ?? new Map<string, string>()) carried.set(key, value)
  for (const [key, value] of carried) fields.set(key, value)

  const sections: Section[] = []
  for (const [name, field] of SECTIONS) {
    const body = ceremony[field]
    if (body === undefined) continue
    const bad = unwritableBodyLine(body)
    if (bad !== undefined) {
      return refuse('S1', `${ceremony.id}: ${field} has the line "${bad}", and a body line may not start with # at column 0`, ceremony.id)
    }
    sections.push({ name, body })
  }
  for (const section of base?.sections ?? []) {
    if (!SECTIONS.some(([name]) => name === section.name)) sections.push(section)
  }
  return storeOk({ id: ceremony.id, title: ceremony.title, fields, sections })
}
