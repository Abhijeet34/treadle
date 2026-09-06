// SPDX-License-Identifier: Apache-2.0
// The sprint: a period with a committed set, and the rules that decide what may enter it.
//
// A sprint is not a work item. It has no gates, no severity and no review, so it is not put
// through the item state machine: it is `open` or `closed`, and nothing else about it moves.
// The committed set is not stored here either. An item carries `sprint_id`, so the set of
// items committed to an open sprint is the set of items that point at it, and storing the
// same list on the sprint would be one fact in two places. What the sprint record does keep
// is the one thing that cannot be derived after the fact: the carry-over its close recorded.
// docs/architecture/adr/0016-sprints.md carries the argument for each of these.

import { fail, ok, type DomainError, type Failure, type Result } from './errors.ts'
import { MAX_REASON, isInstant } from './fields.ts'
import type { GateVerdict } from './gates.ts'
import { validateFieldKeys } from './record.ts'
import { isSafeText } from './text.ts'
import { isTerminal, type Instant, type ItemId, type WorkItemSummary } from './types.ts'

export const SPRINT_STATES = ['open', 'closed'] as const
export type SprintState = (typeof SPRINT_STATES)[number]

/** A calendar date, `YYYY-MM-DD`, read as a UTC day. `isCalendarDate` is the validator. */
export type CalendarDate = string

/** The goal is one paragraph, bounded like the tool's other reason fields. */
export const MAX_GOAL = MAX_REASON

export type Sprint = {
  readonly id: string
  readonly title: string
  readonly state: SprintState
  /** The instant the sprint was opened; the same key every record in the store carries. */
  readonly filed_at: Instant
  readonly version: number
  /** First and last day of the sprint, both inclusive, as UTC calendar dates. */
  readonly start: CalendarDate
  readonly end: CalendarDate
  readonly closed_at?: Instant
  /**
   * The items still open when the sprint closed, recorded at that instant and cleared by a
   * reopen. Carry-over is the number a team looks at, and once those items move on to the
   * next sprint nothing else in the store says they were here.
   */
  readonly carried?: readonly ItemId[]
  readonly goal?: string
  /** Keys a newer writer produced that this version does not know, preserved verbatim. */
  readonly extra?: ReadonlyMap<string, string>
}

/**
 * Every field a sprint record persists, which is the list the visibility sweep in
 * test/architecture/field-visibility.test.ts holds to a read surface. `id` and `title` sit in
 * the record heading, as an item's do.
 */
export const SPRINT_FIELDS = [
  'id', 'title', 'state', 'filed_at', 'version', 'start', 'end', 'closed_at', 'carried', 'goal', 'extra',
] as const

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/**
 * A real calendar date. The shape alone lets `2026-02-30` through, and `Date.parse` then
 * reads it as the second of March; a sprint boundary that two people read differently is
 * the failure the date rule exists to prevent, so a date names the day it denotes or is
 * refused. Checked against the calendar rather than through a `Date`, because this layer
 * touches no clock and the layering test reads the constructor as one.
 */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]
  return days !== undefined && day >= 1 && day <= days
}

/** The UTC calendar date of an instant, which is the day a sprint boundary is compared on. */
export function dateOf(instant: Instant): CalendarDate {
  return instant.slice(0, 10)
}

/**
 * Where an instant falls in the sprint: `day` is 1 on `start` and `days` is the length,
 * both inclusive, so a two-week sprint reads `day 3/14`. Before the start `day` is 0 or
 * less and after the end it is past `days`; neither is clamped, because "day 16 of 14" is
 * the fact a reader of an overrunning sprint needs.
 */
export function dayOfSprint(sprint: Sprint, now: Instant): { readonly day: number; readonly days: number } {
  const start = Date.parse(`${sprint.start}T00:00:00Z`)
  const end = Date.parse(`${sprint.end}T00:00:00Z`)
  const today = Date.parse(`${dateOf(now)}T00:00:00Z`)
  return {
    day: Math.floor((today - start) / DAY_MS) + 1,
    days: Math.floor((end - start) / DAY_MS) + 1,
  }
}

/**
 * What a close records: every committed item whose work is still open, in id order. A
 * cancelled item is finished work that stopped, not work that carries over, and it stays in
 * the committed set with its own state saying so.
 */
export function carryOver(committed: readonly WorkItemSummary[]): readonly ItemId[] {
  return committed
    .filter((item) => !isTerminal(item.state))
    .map((item) => item.id)
    .sort()
}

function invalid(rule: string, message: string, id: string | undefined): Failure {
  return fail('VALIDATION', rule, message, id === undefined ? [] : [id])
}

/** The field dictionary of a sprint. `I1` is the date rule; everything else is `V4`. */
export function validateSprint(sprint: Sprint): Result<Sprint> {
  const { id } = sprint
  if (typeof id !== 'string' || !SLUG.test(id)) {
    return invalid('V4', 'id must be a slug of 3 to 64 lowercase letters, digits and hyphens', undefined)
  }
  if (typeof sprint.title !== 'string' || sprint.title.length === 0 || sprint.title.length > 200
    || !isSafeText(sprint.title, 'line') || sprint.title.trim() !== sprint.title) {
    return invalid('V4', 'title must be a single line of 1 to 200 characters with no control or bidi override characters', id)
  }
  if (!(SPRINT_STATES as readonly string[]).includes(sprint.state)) {
    return invalid('V4', `state must be one of ${SPRINT_STATES.join(', ')}`, id)
  }
  if (!isInstant(sprint.filed_at)) return invalid('V4', 'filed_at must be an RFC 3339 instant in UTC', id)
  if (!Number.isInteger(sprint.version) || sprint.version < 1) return invalid('V4', 'version must be a whole number of 1 or more', id)
  for (const field of ['start', 'end'] as const) {
    if (!isCalendarDate(sprint[field])) {
      return invalid('I1', `${field} must be a calendar date written YYYY-MM-DD that names a real day, such as 2026-09-07`, id)
    }
  }
  if (sprint.end < sprint.start) {
    return invalid('I1', `end ${sprint.end} is before start ${sprint.start}; a sprint ends on or after the day it starts`, id)
  }
  if (sprint.closed_at !== undefined) {
    if (!isInstant(sprint.closed_at)) return invalid('V4', 'closed_at must be an RFC 3339 instant in UTC', id)
    if (sprint.state !== 'closed') return invalid('V4', `closed_at is set on a sprint whose state is ${sprint.state}, not closed`, id)
  }
  if (sprint.carried !== undefined) {
    if (sprint.state !== 'closed') return invalid('V4', `carried is set on a sprint whose state is ${sprint.state}, not closed`, id)
    for (const item of sprint.carried) {
      if (typeof item !== 'string' || !SLUG.test(item)) return invalid('V4', `carried must be a list of item ids; ${String(item)} is not one`, id)
    }
    if (new Set(sprint.carried).size !== sprint.carried.length) return invalid('V4', 'carried names an item twice', id)
  }
  if (sprint.goal !== undefined) {
    if (typeof sprint.goal !== 'string' || sprint.goal.length === 0 || !isSafeText(sprint.goal, 'text')) {
      return invalid('V4', `goal must be 1 to ${MAX_GOAL} characters and may carry newlines but no other control characters`, id)
    }
    if (sprint.goal.length > MAX_GOAL) {
      return invalid('V4', `goal is ${sprint.goal.length} characters and the limit is ${MAX_GOAL}, which is ${sprint.goal.length - MAX_GOAL} over`, id)
    }
  }
  if (sprint.extra !== undefined) {
    const keys = validateFieldKeys(sprint.extra)
    if (!keys.ok) return keys
  }
  return ok(sprint)
}

export type CommitContext = {
  readonly sprint: Sprint
  readonly item: WorkItemSummary
  /** The sprint the item points at now, when that sprint exists. */
  readonly current: Sprint | undefined
  readonly readyGate: GateVerdict
}

export type CommitOutcome =
  | { readonly outcome: 'already' }
  | { readonly outcome: 'allowed' }
  | { readonly outcome: 'refused'; readonly error: DomainError; readonly fix: readonly string[] }

/**
 * Whether one item may enter one sprint. Three refusals, each a rule id: the sprint is
 * closed (`I2`), the item already sits in another open sprint (`I3`), or the item cannot be
 * worked, because it is finished or its ready gate fails (`I4`). The ready gate is the
 * item's own definition of "can be picked up", and a sprint is where work gets picked up, so
 * the same rule decides both; a draft story with no acceptance criterion can exist and can
 * never enter a sprint, which is the README's oldest promise about types.
 */
export function evaluateCommit(context: CommitContext): CommitOutcome {
  const { sprint, item, current, readyGate } = context
  if (item.sprint_id === sprint.id) return { outcome: 'already' }
  const refused = (rule: string, message: string, fix: readonly string[]): CommitOutcome => ({
    outcome: 'refused',
    error: fail('GUARD_REFUSED', rule, message, [item.id, sprint.id]).error,
    fix,
  })
  if (sprint.state !== 'open') {
    return refused('I2', `${sprint.id} is closed, and a closed sprint's committed set is a record; reopen it or commit ${item.id} to an open sprint`,
      [`treadle sprints`, `treadle sprint reopen ${sprint.id}`])
  }
  if (current !== undefined && current.state === 'open') {
    return refused('I3', `${item.id} is committed to ${current.id}, which is open; an item is in one sprint`,
      [`treadle sprint uncommit ${item.id}`, `treadle sprint close ${current.id}`])
  }
  if (isTerminal(item.state)) {
    return refused('I4', `${item.id} is ${item.state}, and finished work does not enter a sprint`, [`treadle show ${item.id}`])
  }
  const failing = readyGate.rules.find((rule) => !rule.pass)
  if (failing !== undefined) {
    return refused('I4', `${item.id} is not ready to be worked: ${failing.rule} ${failing.reason ?? failing.sentence}`,
      failing.remedy === undefined ? [`treadle explain ${item.id}`] : [failing.remedy, `treadle explain ${item.id}`])
  }
  return { outcome: 'allowed' }
}

const SPRINT_FIELD_SET: ReadonlySet<string> = new Set(SPRINT_FIELDS)

/** Whether a key is a field of the sprint dictionary, which `history` reads to name a sprint event's moves. */
export function isSprintField(name: string): boolean {
  return SPRINT_FIELD_SET.has(name)
}
