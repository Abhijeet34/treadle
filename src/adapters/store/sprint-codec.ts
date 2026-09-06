// SPDX-License-Identifier: Apache-2.0
// Sprint to record and back, over the one record grammar every file in the store shares.
// The grammar knows lines; this file knows the sprint's field dictionary: which keys are
// single-line, that the goal is an H2 section, how the carried list is spelled, and the
// order a rendered sprint takes. It is the item codec's shape over a smaller dictionary.

import { SPRINT_FIELDS, validateSprint, type Sprint } from '../../domain/index.ts'
import { storeFail, storeOk, type StoreResult } from '../../application/ports/store.ts'
import { unwritableBodyLine, type ParsedRecord, type Section } from './grammar.ts'

/** The single-line fields, in render order. `type` names the record kind for the grammar's resynchroniser. */
const FIELD_ORDER = ['type', 'state', 'filed_at', 'version', 'start', 'end', 'closed_at', 'carried'] as const

const GOAL_SECTION = 'Goal'

/** `type: sprint` is a constant line: the grammar's damaged-heading rule keys on it, as it does on an item's. */
const KIND = 'sprint'

const KNOWN: ReadonlySet<string> = new Set([...SPRINT_FIELDS, 'type'])

function refuse<T>(rule: string, reason: string, id: string): StoreResult<T> {
  return storeFail('VALIDATION', rule, reason, [id])
}

export function decodeSprint(record: ParsedRecord): StoreResult<Sprint> {
  const draft: Record<string, unknown> = { id: record.id, title: record.title }
  const extra = new Map<string, string>()

  for (const [key, value] of record.fields) {
    if (key === 'type') {
      if (value !== KIND) return refuse('S1', `${record.id}: a record in the sprint file is type ${KIND}, not "${value}"`, record.id)
      continue
    }
    if (!KNOWN.has(key) || key === 'extra' || key === 'id' || key === 'title' || key === 'goal') {
      extra.set(key, value)
      continue
    }
    if (key === 'version') {
      if (!/^\d{1,15}$/.test(value)) return refuse('S1', `${record.id}: version must be a whole number, not "${value}"`, record.id)
      draft[key] = Number(value)
      continue
    }
    if (key === 'carried') {
      draft[key] = value.split(', ')
      continue
    }
    draft[key] = value
  }
  if (!record.fields.has('type')) return refuse('S1', `${record.id}: a sprint record carries type: ${KIND}`, record.id)

  const goal = record.sections.find((section) => section.name === GOAL_SECTION)
  if (goal !== undefined) draft['goal'] = goal.body
  if (extra.size > 0) draft['extra'] = extra

  const valid = validateSprint(draft as unknown as Sprint)
  if (!valid.ok) {
    return storeFail('VALIDATION', valid.error.rule ?? 'V4', `${record.id}: ${valid.error.message}`, [record.id])
  }
  return storeOk(valid.value)
}

export type EncodedSprint = {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
}

/**
 * One sprint to one record. As with an item, every field key and section this tool does not
 * know is carried over from the stored record unchanged (DR3), so an older tool writing a
 * newer sprint file loses nothing it did not understand.
 */
export function encodeSprint(sprint: Sprint, base?: ParsedRecord): StoreResult<EncodedSprint> {
  const valid = validateSprint(sprint)
  if (!valid.ok) {
    return storeFail('VALIDATION', valid.error.rule ?? 'V4', `${sprint.id}: ${valid.error.message}`, [sprint.id])
  }

  const fields = new Map<string, string>()
  for (const key of FIELD_ORDER) {
    if (key === 'type') { fields.set(key, KIND); continue }
    const value = sprint[key]
    if (value === undefined) continue
    fields.set(key, key === 'carried' ? (value as readonly string[]).join(', ') : String(value))
  }
  const carried = new Map<string, string>()
  if (base !== undefined) {
    for (const [key, value] of base.fields) {
      if (!KNOWN.has(key) && !fields.has(key)) carried.set(key, value)
    }
  }
  for (const [key, value] of sprint.extra ?? new Map<string, string>()) carried.set(key, value)
  for (const [key, value] of carried) fields.set(key, value)

  const sections: Section[] = []
  if (sprint.goal !== undefined) {
    const bad = unwritableBodyLine(sprint.goal)
    if (bad !== undefined) {
      return refuse('S1', `${sprint.id}: goal has the line "${bad}", and a body line may not start with # at column 0`, sprint.id)
    }
    sections.push({ name: GOAL_SECTION, body: sprint.goal })
  }
  for (const section of base?.sections ?? []) {
    if (section.name !== GOAL_SECTION) sections.push(section)
  }
  return storeOk({ id: sprint.id, title: sprint.title, fields, sections })
}
