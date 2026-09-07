// SPDX-License-Identifier: Apache-2.0
// The field dictionary and the per-type required-field policy (domain model 2.1, 2.14).
// Creation-time rules live here; readiness and doneness rules live in gates.ts, because
// the model's own design is that the gate is what makes a type's fields bite.

import { fail, ok, type Failure, type Result } from './errors.ts'
import { validateFieldKeys } from './record.ts'
import { andList, findUnsafeCharacter, isSafeText, withArticle } from './text.ts'
import {
  BUG_SEVERITIES,
  DEFAULT_POINT_SCALE,
  EVIDENCE_KINDS,
  FOUND_IN_STAGES,
  RELATION_KINDS,
  RESOLUTIONS,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  type EvidencePointer,
  type Instant,
  type StoredRelation,
  type WorkItem,
  type WorkItemType,
} from './types.ts'

/**
 * The prose bounds, and the evidence list's. Each is argued in
 * docs/architecture/adr/0011-evidence-and-the-severity-audit.md; the short form is that a
 * value which lands whole in a committed shard is bounded by what a reviewer will read in a
 * diff, not by what the parser can hold. The store's own S5 ceiling of 128 KiB per section
 * is unchanged, so a record written before these bounds still reads.
 */
export const MAX_DESCRIPTION = 10_000
/**
 * The dictionary's single-line bound: a title, a name, an evidence ref. Nothing a caller
 * writes on one line of a record is longer, which is what makes it the bound a flag that
 * names an entity or filters on a field is held to before any of it can be printed back.
 */
export const MAX_LINE = 200
/** The same bound `hold_reason` already carries, which is the dictionary's one reason field. */
export const MAX_REASON = 500
export const MAX_EVIDENCE_ENTRIES = 20
export const MAX_EVIDENCE_REF = 200
export const MAX_EVIDENCE_LABEL = 120
/**
 * Edges stored on one record. `blocks` sits on the blocker, so this is how many items one
 * item may hold up; an item past it is a workstream rather than an item.
 */
export const MAX_RELATION_ENTRIES = 50

const COMMON_FIELDS = [
  'id', 'type', 'state', 'title', 'filed_at', 'version',
  'description', 'priority', 'points', 'hours_estimate', 'parent_id',
  'assignee', 'reporter', 'reviewer', 'component', 'labels', 'sprint_id', 'due', 'evidence',
  'relations', 'hold_reason', 'hold_until', 'held_from', 'resolution', 'extra',
] as const

const TYPE_FIELDS: Readonly<Record<WorkItemType, readonly string[]>> = {
  epic: ['outcome'],
  story: ['acceptance_criteria'],
  task: [],
  bug: ['severity', 'repro_steps', 'expected', 'actual', 'found_in', 'fix_confirmed'],
  spike: ['question', 'timebox_hours', 'findings'],
  chore: [],
  impediment: ['severity', 'proposed_resolution'],
}

// An impediment requires both of its fields the way a bug requires severity: raising one
// obliges the raiser to say what would clear it, and an impediment with no proposed
// resolution is a complaint (ADR-0017).
const REQUIRED_AT_CREATION: Readonly<Record<WorkItemType, readonly string[]>> = {
  epic: ['outcome'],
  story: [],
  task: [],
  bug: ['severity', 'repro_steps', 'found_in'],
  spike: ['question', 'timebox_hours'],
  chore: [],
  impediment: ['severity', 'proposed_resolution'],
}

/** The fields a creation refuses to go without, per type (2.1). */
export function requiredAtCreation(type: WorkItemType): readonly string[] {
  return REQUIRED_AT_CREATION[type]
}

// Built once. Validation runs on every record a read decodes, and a set and two arrays
// allocated per call were 340 MiB of the 1,072 MiB a read of 50,000 items allocated.
const FIELDS_OF: Readonly<Record<WorkItemType, readonly string[]>> = Object.fromEntries(
  WORK_ITEM_TYPES.map((type) => [type, [...COMMON_FIELDS, ...TYPE_FIELDS[type]]]),
) as unknown as Record<WorkItemType, readonly string[]>
const PERMITTED: ReadonlyMap<WorkItemType, ReadonlySet<string>> = new Map(
  WORK_ITEM_TYPES.map((type) => [type, new Set(FIELDS_OF[type])]),
)
const KNOWN_FIELDS: ReadonlySet<string> = new Set(WORK_ITEM_TYPES.flatMap((type) => FIELDS_OF[type]))

/** Every field name this type may carry: the common set plus its own. */
export function fieldsOf(type: WorkItemType): readonly string[] {
  return FIELDS_OF[type]
}

export function isKnownField(name: string): boolean {
  return KNOWN_FIELDS.has(name)
}

/**
 * The short name a read surface prints, against the dictionary name a write takes. Both
 * spellings are one field, and this table is the one place that is said.
 *
 * The two paths disagreed and each denied the other's name existed: `--set description=` was
 * accepted while `--set desc=` was refused as "not a field of any work item", and
 * `show --field desc` printed the block while `--field description` was refused as "carries
 * no field named description". A caller who read a record and set what they had just read
 * was told it was not a field. Every path resolves a caller's spelling through
 * `canonicalField` before it decides anything, so neither name can be the unknown one.
 */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  item: 'id',
  filed: 'filed_at',
  v: 'version',
  desc: 'description',
  pri: 'priority',
  pts: 'points',
  hrs: 'hours_estimate',
  parent: 'parent_id',
  sprint: 'sprint_id',
  hold: 'hold_reason',
  ac: 'acceptance_criteria',
  sev: 'severity',
  repro: 'repro_steps',
  found: 'found_in',
  fixed: 'fix_confirmed',
  timebox: 'timebox_hours',
}

const SHORT_OF = new Map(Object.entries(FIELD_ALIASES).map(([short, field]) => [field, short]))

/** How a field is written: by `set`, by a command of its own, or by nothing. */
export type FieldWriter =
  | { readonly kind: 'set' }
  | { readonly kind: 'command'; readonly usage: string }
  | { readonly kind: 'none'; readonly why: string }

const BY_SET: FieldWriter = { kind: 'set' }

/**
 * The exceptions to `set`, which writes the rest of the dictionary. This is here, beside the
 * dictionary, rather than inside the field editor, because a gate remedy reads it too: a
 * rule that told a caller to `set severity` would name a command that refuses the field, and
 * the whole point of a remedy is that running it satisfies the rule. One table, both paths.
 */
const WRITTEN_BY: Readonly<Record<string, FieldWriter>> = {
  id: { kind: 'command', usage: 'treadle file <type> "<title>" --id <value>' },
  type: { kind: 'command', usage: 'treadle file <type> "<title>"' },
  state: { kind: 'command', usage: 'treadle transition <id> <state>' },
  severity: { kind: 'command', usage: 'treadle mark <id> --severity <S1-S4> --reason "<why>"' },
  priority: { kind: 'command', usage: 'treadle mark <id> --priority <1-5> --reason "<why>"' },
  evidence: { kind: 'command', usage: 'treadle evidence add <id> <kind> <ref> [label]' },
  relations: { kind: 'command', usage: 'treadle relation add <id> <blocks|duplicates|relates-to> <other>' },
  sprint_id: { kind: 'command', usage: 'treadle sprint commit <sprint> <id>' },
  resolution: { kind: 'command', usage: 'treadle transition <id> cancelled --resolution <r> --reason "<why>"' },
  hold_reason: { kind: 'command', usage: 'treadle transition <id> on_hold --reason "<why>"' },
  hold_until: { kind: 'command', usage: 'treadle transition <id> on_hold --until <instant> --reason "<why>"' },
  held_from: { kind: 'command', usage: 'treadle transition <id> on_hold --reason "<why>"' },
  filed_at: { kind: 'none', why: 'the instant the item was filed is a record of what happened, not a field' },
  version: { kind: 'none', why: 'the store sets a version on every write, which is how a stale write is caught' },
  extra: { kind: 'none', why: 'a key this build has no meaning for belongs to the record file, which D1 makes authoritative' },
}

/** What writes this field. Everything the table does not name is `set`'s. */
export function writerOf(field: string): FieldWriter {
  return WRITTEN_BY[canonicalField(field)] ?? BY_SET
}

/**
 * The command line that writes one field of one item, or `undefined` where no command does.
 * A caller with nothing to substitute passes a placeholder such as `<value>`.
 */
export function writeCommand(field: string, id: string, value: string): string | undefined {
  const name = canonicalField(field)
  const writer = writerOf(name)
  if (writer.kind === 'none') return undefined
  return writer.kind === 'set'
    ? `treadle set ${id} ${name}=${value}`
    : writer.usage.replaceAll('<id>', id).replaceAll('<value>', value)
}

/**
 * The placeholder a remedy prints where a field's value goes, so a line the reader fills in
 * is filled with something the field accepts. `timebox_hours=<value>` sent a caller to a
 * refusal that `timebox_hours=<n>` does not; prose fields take `<value>`.
 */
const PLACEHOLDER_OF: Readonly<Record<string, string>> = {
  points: '<n>',
  hours_estimate: '<n>',
  timebox_hours: '<n>',
  priority: '<1-5>',
  severity: '<S1-S4>',
  parent_id: '<id>',
  sprint_id: '<id>',
  assignee: '<name>',
  reporter: '<name>',
  reviewer: '<name>',
  due: '<instant>',
  hold_until: '<instant>',
  found_in: `<${FOUND_IN_STAGES.join('|')}>`,
  fix_confirmed: '<true|false>',
  labels: '<slug>,<slug>',
  acceptance_criteria: '"<entry>|<entry>"',
  resolution: `<${RESOLUTIONS.join('|')}>`,
}

export function placeholderOf(field: string): string {
  return PLACEHOLDER_OF[canonicalField(field)] ?? '<value>'
}

/** The dictionary name of a field, given either of its spellings. */
export function canonicalField(name: string): string {
  return FIELD_ALIASES[name] ?? name
}

/** The name a read surface prints for a field, given either of its spellings. */
export function shortField(name: string): string {
  return SHORT_OF.get(canonicalField(name)) ?? name
}

// Both patterns are bounded and linear: one character class per position, no nested
// quantifier, so neither can backtrack (threat model F8's ReDoS discipline).
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
/**
 * A label's own bound: two characters, not the id's three. `ux`, `ui`, `qa`, `ci` and `db`
 * are the labels a team writes in its first week and every one of them was refused, which is
 * a rule about ids applied to a field that is not one. Two rather than one is where the
 * meaning stops: a one-character label is indistinguishable from a typed-past value, and it
 * would make `backlog --label a` a filter nobody can read back. The ceiling stays 64, and
 * `id`, `parent_id`, `sprint_id` and a relation target keep the three-character floor,
 * because those name records and a two-character id collides far sooner than a label does.
 */
const LABEL = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

// DR3 rule 7, widened to the whole class by finding F5. text.ts owns the class so the
// store boundary and this validator cannot drift; a single-line value additionally carries
// no newline and no tab, which `line` mode is.

function isSingleLine(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max
    && isSafeText(value, 'line')
    && value.trim() === value
}

function isText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && isSafeText(value, 'text')
}

function isBoundedInt(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

export function isInstant(value: unknown): value is Instant {
  return typeof value === 'string' && INSTANT.test(value)
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/**
 * A real calendar date, `YYYY-MM-DD`. The shape alone lets `2026-02-30` through, and
 * `Date.parse` then reads it as the second of March; a sprint boundary that two people read
 * differently is the failure the date rule exists to prevent, so a date names the day it
 * denotes or is refused. Checked against the calendar rather than through a `Date`, because
 * this layer touches no clock and the layering test reads the constructor as one.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]
  return days !== undefined && day >= 1 && day <= days
}

/**
 * A day written `YYYY-MM-DD` as its first instant in UTC, or the value unchanged.
 *
 * The two grammars this tool teaches disagreed: `sprint open --end 2026-09-30` takes a day and
 * `set x due=2026-09-30` was refused for a value that names exactly the day meant. A due date
 * and a hold's end are days, so both write paths widen here - `coerce` for `due`, the
 * `--until` flag for `hold_until` - and one record format is stored either way. A malformed
 * day such as `2026-13-40` is not widened at all, so it reaches `isInstant` as itself and earns
 * the refusal that names both forms: widening it first would have manufactured a well-shaped
 * instant out of a day that does not exist, which the shape regex cannot tell from a real one.
 */
export function asInstant(value: string): string {
  return isCalendarDate(value) ? `${value}T00:00:00Z` : value
}

/** The clause the two day-taking fields add to their refusal, so a caller learns the form. */
const DAY_OR_INSTANT = ', or a day such as 2026-09-05, which is stored as its first instant'

export type ValidateOptions = {
  readonly now: Instant
  /** The workspace's estimation scale; defaults to the model's 1,2,3,5,8,13. */
  readonly pointScale?: readonly number[]
  /**
   * Set by the store, and by nothing else. `description` was 100,000 characters before it
   * was narrowed to MAX_DESCRIPTION, so files exist that carry more; applying the write
   * bound on load would quarantine those records and make them unreadable, which
   * docs/STABILITY.md calls the one thing the file format never does. On this path the
   * store's own S5 section ceiling is the bound and a stored value over MAX_DESCRIPTION is
   * doctor finding H18 instead of a refusal.
   */
  readonly storedProse?: true
}

type Check = (value: unknown, item: WorkItem, options: ValidateOptions) => string | undefined

const oneOf = (name: string, allowed: readonly string[]): Check => (value) =>
  typeof value === 'string' && allowed.includes(value)
    ? undefined
    : `${name} must be one of ${allowed.join(', ')}`

/**
 * A bound that refuses says which bound and by how much. A message that named only the
 * limit left a caller guessing whether its 90,000-character description was over by ten
 * characters or by nine times, and the write it refuses is the one place that number is
 * known.
 */
// Every length in this file is JavaScript string length, which is UTF-16 code units, so a
// character outside the Basic Multilingual Plane counts as two. One unit is used on every surface that
// prints a count, so a refusal's number is the number the bound compared; docs/DOMAIN.md,
// "The bounded fields", states it for a reader.
export function overLength(name: string, max: number, observed: number): string {
  return `${name} is ${observed} characters and the limit is ${max}, which is ${observed - max} over`
}

const line = (name: string, max: number): Check => (value) =>
  typeof value === 'string' && isSingleLine(value, max)
    ? undefined
    : typeof value === 'string' && value.length > max
      ? overLength(name, max, value.length)
      : `${name} must be a single line of 1 to ${max} characters with no control or bidi override characters`

const text = (name: string, max: number): Check => (value, _item, options) => {
  if (typeof value !== 'string' || !isText(value, max)) {
    return typeof value === 'string' && value.length > max
      ? overLength(name, max, value.length)
      : `${name} must be 1 to ${max} characters and may carry newlines and tabs but no other control characters`
  }
  // A required paragraph made of spaces says nothing: `proposed_resolution=" "` filed an
  // impediment that named no resolution. Write-time only, as every narrowed bound is.
  if (options.storedProse !== true && value.trim().length === 0) return `${name} is only whitespace, and a text says something or is left unset`
  return undefined
}

const int = (name: string, min: number, max: number): Check => (value) =>
  isBoundedInt(value, min, max) ? undefined : `${name} must be a whole number from ${min} to ${max}`

const slug = (name: string): Check => (value) =>
  typeof value === 'string' && SLUG.test(value)
    ? undefined
    : `${name} must be a slug of 3 to 64 lowercase letters, digits and hyphens`

const instant = (name: string, day = false): Check => (value) =>
  (isInstant(value) ? undefined
    : `${name} must be an RFC 3339 instant in UTC, such as 2026-09-05T12:00:00Z${day ? DAY_OR_INSTANT : ''}`)

const CHECKS: Readonly<Record<string, Check>> = {
  id: slug('id'),
  type: oneOf('type', WORK_ITEM_TYPES),
  state: oneOf('state', WORK_ITEM_STATES),
  title: line('title', MAX_LINE),
  filed_at: instant('filed_at'),
  version: (value) => (isBoundedInt(value, 1, Number.MAX_SAFE_INTEGER) ? undefined : 'version must be a whole number of 1 or more'),

  description: (value, _item, options) =>
    text('description', options.storedProse === true ? Number.MAX_SAFE_INTEGER : MAX_DESCRIPTION)(value, _item, options),
  priority: int('priority', 1, 5),
  points: (value, _item, options) => {
    const scale = options.pointScale ?? DEFAULT_POINT_SCALE
    return typeof value === 'number' && scale.includes(value)
      ? undefined
      : `points must be one of the workspace scale ${scale.join(', ')}`
  },
  hours_estimate: int('hours_estimate', 1, 400),
  parent_id: slug('parent_id'),
  assignee: line('assignee', MAX_LINE),
  reporter: line('reporter', MAX_LINE),
  reviewer: line('reviewer', MAX_LINE),
  component: line('component', MAX_LINE),
  sprint_id: slug('sprint_id'),
  labels: (value) => {
    if (!Array.isArray(value)) return 'labels must be a list of slugs'
    const labels = value as readonly unknown[]
    for (const label of labels) {
      if (typeof label !== 'string' || !LABEL.test(label)) {
        return `labels must be slugs of 2 to 64 lowercase letters, digits and hyphens; ${String(label)} is not one`
      }
    }
    return new Set(labels).size === labels.length ? undefined : 'labels must be unique within one item'
  },

  due: instant('due', true),
  evidence: (value) => {
    if (!Array.isArray(value)) return 'evidence must be a list of pointers'
    const entries = value as readonly unknown[]
    if (entries.length > MAX_EVIDENCE_ENTRIES) {
      return `evidence carries ${entries.length} entries and the limit is ${MAX_EVIDENCE_ENTRIES}`
    }
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) return 'each evidence entry is a kind, a ref and an optional label'
      const pointer = entry as Partial<EvidencePointer>
      if (typeof pointer.kind !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(pointer.kind)) {
        return `an evidence kind must be one of ${EVIDENCE_KINDS.join(', ')}`
      }
      if (typeof pointer.ref !== 'string' || !isSingleLine(pointer.ref, MAX_EVIDENCE_REF)) {
        return typeof pointer.ref === 'string' && pointer.ref.length > MAX_EVIDENCE_REF
          ? overLength('an evidence ref', MAX_EVIDENCE_REF, pointer.ref.length)
          : `an evidence ref must be a single line of 1 to ${MAX_EVIDENCE_REF} characters`
      }
      // A ref with a space is a sentence wearing a pointer's name, and the row grammar can
      // carry one space-bearing column, which the label already is.
      if (pointer.ref.includes(' ')) return `the evidence ref "${pointer.ref}" carries a space; a ref is a hash, a path, a run id or a URL`
      if (pointer.label !== undefined && (typeof pointer.label !== 'string' || !isSingleLine(pointer.label, MAX_EVIDENCE_LABEL))) {
        return typeof pointer.label === 'string' && pointer.label.length > MAX_EVIDENCE_LABEL
          ? overLength('an evidence label', MAX_EVIDENCE_LABEL, pointer.label.length)
          : `an evidence label must be a single line of 1 to ${MAX_EVIDENCE_LABEL} characters`
      }
    }
    return undefined
  },

  // The two checks a record can fail on its own: a self edge and a repeated edge. Whether
  // the other end exists, and whether `blocks` closes a cycle, need the whole workspace and
  // are `relation add`'s refusals on write and `doctor`'s findings on load.
  relations: (value, item) => {
    if (!Array.isArray(value)) return 'relations must be a list of kind and target pairs'
    const entries = value as readonly unknown[]
    if (entries.length > MAX_RELATION_ENTRIES) {
      return `relations carries ${entries.length} entries and the limit is ${MAX_RELATION_ENTRIES}`
    }
    const seen = new Set<string>()
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) return 'each relation is a kind and a target'
      const relation = entry as Partial<StoredRelation>
      if (typeof relation.kind !== 'string' || !(RELATION_KINDS as readonly string[]).includes(relation.kind)) {
        return `a relation kind must be one of ${RELATION_KINDS.join(', ')}`
      }
      if (typeof relation.target !== 'string' || !SLUG.test(relation.target)) {
        return 'a relation target must be a slug of 3 to 64 lowercase letters, digits and hyphens'
      }
      if (relation.target === item.id) return `${item.id} cannot ${relation.kind} itself`
      const edge = `${relation.kind} ${relation.target}`
      if (seen.has(edge)) return `the relation ${edge} is stored twice on ${item.id}`
      seen.add(edge)
    }
    return undefined
  },
  hold_reason: line('hold_reason', MAX_REASON),
  hold_until: (value, _item, options) => {
    if (!isInstant(value)) return `hold_until must be an RFC 3339 instant in UTC${DAY_OR_INSTANT}`
    return value > options.now ? undefined : `hold_until ${value} is not in the future`
  },
  held_from: oneOf('held_from', ['draft', 'ready', 'in_progress', 'in_review']),
  resolution: oneOf('resolution', RESOLUTIONS),
  extra: (value) => {
    if (!(value instanceof Map)) return 'extra must be a Map of unknown field keys to their verbatim values'
    for (const [key, entry] of value as ReadonlyMap<string, unknown>) {
      if (typeof entry !== 'string' || !isSafeText(entry, 'line')) {
        const unsafe = typeof entry === 'string' ? findUnsafeCharacter(entry, 'line') : undefined
        return unsafe === undefined
          ? `extra.${key} must be a single line with no control or bidi override characters`
          : `extra.${key} carries ${unsafe.label} at character ${unsafe.at}, which is refused`
      }
    }
    return undefined
  },

  outcome: text('outcome', 1000),
  acceptance_criteria: (value) => {
    if (!Array.isArray(value)) return 'acceptance_criteria must be a list'
    for (const entry of value as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) return 'each acceptance criterion is a text and a tick'
      const criterion = entry as { text?: unknown; ticked?: unknown }
      // One line each: a criterion renders as `- [ ] text` on a line of its own, and a
      // newline inside it wrote a body line the reader refused on every read after.
      if (typeof criterion.text !== 'string' || !isText(criterion.text, 500) || !isSafeText(criterion.text, 'line')) {
        return 'each acceptance criterion needs a single line of text of 1 to 500 characters'
      }
      if (typeof criterion.ticked !== 'boolean') return 'each acceptance criterion needs a boolean tick'
    }
    return undefined
  },
  severity: oneOf('severity', BUG_SEVERITIES),
  repro_steps: text('repro_steps', 5000),
  expected: text('expected', 2000),
  actual: text('actual', 2000),
  found_in: oneOf('found_in', FOUND_IN_STAGES),
  fix_confirmed: (value) => (typeof value === 'boolean' ? undefined : 'fix_confirmed must be true or false'),
  question: text('question', 1000),
  timebox_hours: int('timebox_hours', 1, 80),
  findings: text('findings', 10_000),
  // The same bound as `outcome` and `question`: a paragraph saying what would clear the
  // blocker, not the plan itself, which belongs in the item that carries it out.
  proposed_resolution: text('proposed_resolution', 1000),
}

const HOLD_FIELDS = ['hold_reason', 'hold_until', 'held_from'] as const

function invalid(rule: string, message: string, item: { id?: unknown }): Failure {
  return fail('VALIDATION', rule, message, typeof item.id === 'string' ? [item.id] : [])
}

/**
 * Validates one work item against the field dictionary and its type's creation policy.
 * The instant is an argument rather than a clock read, which is what keeps this layer pure.
 */
export function validateWorkItem(item: WorkItem, options: ValidateOptions): Result<WorkItem> {
  const typeFailure = CHECKS['type']?.(item.type, item, options)
  if (typeFailure !== undefined) return invalid('V4', typeFailure, item)

  const permitted = PERMITTED.get(item.type) as ReadonlySet<string>
  const present = Object.keys(item).filter((name) => item[name as keyof WorkItem] !== undefined)

  for (const name of present) {
    if (!permitted.has(name)) {
      return invalid(
        'V5',
        isKnownField(name)
          ? `${name} is not a field of ${withArticle(item.type)}`
          : `${name} is not a field of any work item`,
        item,
      )
    }
  }

  for (const name of ['id', 'state', 'title', 'filed_at', 'version']) {
    if (item[name as keyof WorkItem] === undefined) {
      return invalid('V4', `a work item needs ${name}`, item)
    }
  }

  // Every missing one, in one sentence. Naming the first alone cost a caller filing a bug
  // three refusals and three round trips for a fact the type already declares whole, which is
  // ADR-0020's rule read the other way: a verdict is decided by a whole read of the record,
  // not by the first thing in it that fails.
  const missing = requiredAtCreation(item.type).filter((name) => item[name as keyof WorkItem] === undefined)
  if (missing.length > 0) {
    return invalid('V4', `${withArticle(item.type)} needs ${andList(missing)} at creation`, item)
  }

  // Every wrong value, in one sentence, for the same reason the missing ones above are named
  // together: `file bug "x" --set severity=S9 --set found_in=1.0` refused severity, then
  // found_in on the next try, for two facts one read of the record already holds.
  const wrong = present
    .map((name) => CHECKS[name]?.(item[name as keyof WorkItem], item, options))
    .filter((why): why is string => why !== undefined)
  if (wrong.length > 0) return invalid('V4', wrong.join('; '), item)

  if (item.state === 'on_hold') {
    for (const name of ['hold_reason', 'held_from'] as const) {
      if (item[name] === undefined) return invalid('V4', `an item on hold needs ${name}`, item)
    }
  } else {
    for (const name of HOLD_FIELDS) {
      if (item[name] !== undefined) {
        return invalid('V4', `${name} is set on an item whose state is ${item.state}, not on_hold`, item)
      }
    }
  }

  // A resolution says why a stopped item stopped, so it is meaningless anywhere but the
  // stopped state. It is not required here: a record an older tool wrote carries none, and
  // refusing to serve it would make a field addition a store outage. `T6` is what requires
  // one, on the one edge that produces it.
  if (item.state !== 'cancelled' && item.resolution !== undefined) {
    return invalid('V4', `resolution is set on an item whose state is ${item.state}, not cancelled`, item)
  }

  if (item.extra !== undefined) {
    const keys = validateFieldKeys(item.extra)
    if (!keys.ok) return keys
  }

  return ok(item)
}
