// SPDX-License-Identifier: Apache-2.0
// WorkItem to record and back. The grammar knows lines; this file knows the field
// dictionary (2.14): which fields are single-line, which are H2 sections, how a list of
// slugs and a task list are spelled, and the canonical order a mutated record renders in.
//
// Nothing here infers a value from formatting or position (D1 obligation 1). `state` is the
// `state:` line and nothing else, so renaming a heading cannot move an item's lifecycle.

import {
  isKnownField,
  validateWorkItem,
  type AcceptanceCriterion,
  type EvidenceKind,
  type EvidencePointer,
  type WorkItem,
} from '../../domain/index.ts'
import { storeFail, storeOk, type StoreResult } from '../../application/ports/store.ts'
import { unwritableBodyLine, type ParsedRecord, type Section } from './grammar.ts'

/**
 * Load-time validation checks structure, not liveness. `hold_until` must be in the future
 * when a hold is *set*, which is the application layer's rule because it owns the clock; an
 * expired hold on disk is a doctor finding, not a reason to stop serving the record.
 */
const STRUCTURAL_NOW = '0001-01-01T00:00:00Z'

/**
 * Both directions of the round trip read and write what is already on disk, so the write
 * bound on `description` does not apply here; the store's own S5 section ceiling does.
 * See `ValidateOptions.storedProse`.
 */
const STORED = { now: STRUCTURAL_NOW, storedProse: true } as const

/** The single-line fields, in the order 2.14 lists them. Unknown keys render after these. */
const FIELD_ORDER = [
  'type', 'state', 'filed_at', 'version',
  'priority', 'points', 'hours_estimate', 'parent_id',
  'assignee', 'reporter', 'reviewer', 'component', 'labels', 'sprint_id',
  'hold_reason', 'hold_until', 'held_from', 'resolution', 'due',
  'severity', 'found_in', 'fix_confirmed', 'timebox_hours',
] as const

/**
 * A field this tool renamed, and the key it is read as now. This is the whole migration for
 * the epic-only `target_date` becoming the common `due` (report 3.3): a stored record is
 * read under the new key and the next write to it renders the new key, so no file is
 * rewritten to change a name. A retired key is never carried into `extra`, which is what
 * would otherwise leave one record saying the same date twice under two names.
 */
const RETIRED_FIELDS: ReadonlyMap<string, string> = new Map([['target_date', 'due']])

/** The H2 sections DR3 rule 4 names, in render order. */
const SECTION_FIELD: readonly (readonly [string, string])[] = [
  ['Description', 'description'],
  ['Outcome', 'outcome'],
  ['Acceptance criteria', 'acceptance_criteria'],
  ['Question', 'question'],
  ['Repro steps', 'repro_steps'],
  ['Expected', 'expected'],
  ['Actual', 'actual'],
  ['Findings', 'findings'],
  ['Evidence', 'evidence'],
]

const SECTION_BY_NAME = new Map(SECTION_FIELD)

const INT_FIELDS = ['version', 'priority', 'points', 'hours_estimate', 'timebox_hours'] as const
const TICKED = /^- \[([ x])\] (.+)$/
/**
 * One evidence pointer per line. Bounded and linear like every other pattern here: the ref
 * class excludes the space that separates it from the label, so nothing can backtrack.
 */
const EVIDENCE_LINE = /^- ([a-z]{2,10}) ([^ ]{1,200})(?: (.{1,120}))?$/

function refuse<T>(rule: string, reason: string, id: string): StoreResult<T> {
  return storeFail('VALIDATION', rule, reason, [id])
}

function parseInt10(value: string): number | undefined {
  return /^\d{1,15}$/.test(value) ? Number(value) : undefined
}

function criteriaFrom(body: string, id: string): StoreResult<readonly AcceptanceCriterion[]> {
  const out: AcceptanceCriterion[] = []
  for (const line of body.split('\n')) {
    if (line.length === 0) continue
    const match = TICKED.exec(line)
    if (match === null) {
      return refuse('S1', `${id}: acceptance criteria line "${line}" is not "- [ ] text" or "- [x] text"`, id)
    }
    out.push({ text: match[2] as string, ticked: match[1] === 'x' })
  }
  return storeOk(out)
}

function criteriaTo(criteria: readonly AcceptanceCriterion[]): string {
  return criteria.map((c) => `- [${c.ticked ? 'x' : ' '}] ${c.text}`).join('\n')
}

function evidenceFrom(body: string, id: string): StoreResult<readonly EvidencePointer[]> {
  const out: EvidencePointer[] = []
  for (const line of body.split('\n')) {
    if (line.length === 0) continue
    const match = EVIDENCE_LINE.exec(line)
    if (match === null) {
      return refuse('S1', `${id}: evidence line "${line}" is not "- <kind> <ref>" with an optional label`, id)
    }
    const label = match[3]
    out.push(label === undefined
      ? { kind: match[1] as EvidenceKind, ref: match[2] as string }
      : { kind: match[1] as EvidenceKind, ref: match[2] as string, label })
  }
  return storeOk(out)
}

function evidenceTo(entries: readonly EvidencePointer[]): string {
  return entries.map((e) => `- ${e.kind} ${e.ref}${e.label === undefined ? '' : ` ${e.label}`}`).join('\n')
}

/**
 * One parsed record to one validated work item, or a named refusal. Every unknown field key
 * lands in `extra` and travels with the item; unknown sections stay on the record, which is
 * what the write path carries forward.
 */
export function decodeItem(record: ParsedRecord): StoreResult<WorkItem> {
  const draft: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const extra = new Map<string, string>()

  draft['id'] = record.id
  draft['title'] = record.title

  for (const [key, value] of record.fields) {
    const renamed = RETIRED_FIELDS.get(key)
    if (renamed !== undefined) {
      if (!record.fields.has(renamed)) draft[renamed] = value
      continue
    }
    if (!isKnownField(key) || key === 'extra' || key === 'id' || key === 'title') {
      extra.set(key, value)
      continue
    }
    if ((INT_FIELDS as readonly string[]).includes(key)) {
      const parsed = parseInt10(value)
      if (parsed === undefined) return refuse('S1', `${record.id}: ${key} must be a whole number, not "${value}"`, record.id)
      draft[key] = parsed
      continue
    }
    if (key === 'fix_confirmed') {
      if (value !== 'true' && value !== 'false') {
        return refuse('S1', `${record.id}: fix_confirmed must be true or false, not "${value}"`, record.id)
      }
      draft[key] = value === 'true'
      continue
    }
    if (key === 'labels') {
      draft[key] = value.split(', ')
      continue
    }
    draft[key] = value
  }

  for (const section of record.sections) {
    const field = SECTION_BY_NAME.get(section.name)
    if (field === undefined) continue
    if (field === 'acceptance_criteria') {
      const criteria = criteriaFrom(section.body, record.id)
      if (!criteria.ok) return criteria
      draft[field] = criteria.value
      continue
    }
    if (field === 'evidence') {
      const evidence = evidenceFrom(section.body, record.id)
      if (!evidence.ok) return evidence
      draft[field] = evidence.value
      continue
    }
    draft[field] = section.body
  }

  if (extra.size > 0) draft['extra'] = extra

  const validated = validateWorkItem(draft as unknown as WorkItem, STORED)
  if (!validated.ok) {
    return storeFail('VALIDATION', validated.error.rule ?? 'V4', `${record.id}: ${validated.error.message}`, [record.id])
  }
  return storeOk(validated.value)
}

type Encoded = {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
}

function fieldText(key: string, value: unknown): string {
  if (key === 'labels') return (value as readonly string[]).join(', ')
  return typeof value === 'string' ? value : String(value)
}

/**
 * One work item to one record. `base` is the record as stored, and every field key and
 * section name this tool does not know is carried over from it unchanged, so an older tool
 * writing a newer file loses nothing it did not understand (DR3).
 */
export function encodeItem(item: WorkItem, base?: ParsedRecord): StoreResult<Encoded> {
  // Validate before rendering, not after. A record that fails the field dictionary would
  // render happily and then be quarantined on the next read, which is a write the store
  // reported as a success and cannot serve.
  const valid = validateWorkItem(item, STORED)
  if (!valid.ok) {
    return storeFail('VALIDATION', valid.error.rule ?? 'V4', `${item.id}: ${valid.error.message}`, [item.id])
  }

  const fields = new Map<string, string>()
  for (const key of FIELD_ORDER) {
    const value = item[key as keyof WorkItem]
    if (value === undefined) continue
    fields.set(key, fieldText(key, value))
  }

  const carried = new Map<string, string>()
  if (base !== undefined) {
    for (const [key, value] of base.fields) {
      if (!isKnownField(key) && !fields.has(key) && !RETIRED_FIELDS.has(key)) carried.set(key, value)
    }
  }
  for (const [key, value] of item.extra ?? new Map<string, string>()) carried.set(key, value)
  for (const [key, value] of carried) fields.set(key, value)

  const sections: Section[] = []
  for (const [name, field] of SECTION_FIELD) {
    const value = item[field as keyof WorkItem]
    if (value === undefined) continue
    const body = field === 'acceptance_criteria'
      ? criteriaTo(value as readonly AcceptanceCriterion[])
      : field === 'evidence'
        ? evidenceTo(value as readonly EvidencePointer[])
        : (value as string)
    const bad = unwritableBodyLine(body)
    if (bad !== undefined) {
      return refuse('S1', `${item.id}: ${field} has the line "${bad}", and a body line may not start with # at column 0`, item.id)
    }
    if (body.length > 0) sections.push({ name, body })
  }
  if (base !== undefined) {
    for (const section of base.sections) {
      if (!SECTION_BY_NAME.has(section.name)) sections.push(section)
    }
  }

  return storeOk({ id: item.id, title: item.title, fields, sections })
}

export type { Encoded }
export { STRUCTURAL_NOW }
