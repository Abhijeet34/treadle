// SPDX-License-Identifier: Apache-2.0
// The sprint: a period with a committed set, and the rules that decide what may enter it.
//
// A sprint is not a work item. It has no gates, no severity and no review, so it is not put
// through the item state machine: it is `open` or `closed`, and nothing else about it moves.
// An OPEN sprint's committed set is not stored here. An item carries `sprint_id`, so the set
// committed to an open sprint is the set of items that point at it, and storing the same list
// on the sprint would be one fact in two places. A CLOSED sprint's set is stored, because it
// is no longer derivable: `members`, `carried` and the four tally numbers are written at the
// close and never move again, since every one of them drifts the moment a member is revived,
// reopened or committed onward.
// docs/architecture/adr/0016-sprints.md carries the argument for each of these, and
// docs/architecture/adr/0022-a-closed-sprint-is-a-record-and-four-narrow-rules.md the
// argument for the tally.

import { fail, ok, type DomainError, type Failure, type Result } from './errors.ts'
import { MAX_REASON, isCalendarDate, isInstant } from './fields.ts'
import { validateFieldKeys } from './record.ts'
import { isSafeText } from './text.ts'
import { isTerminal, type GateVerdict, type Instant, type ItemId, type WorkItemSummary } from './types.ts'

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
  /**
   * The tally frozen at close: how many of the committed items were done then, and their
   * points. Both are recorded because velocity is a historical record, and a live count over
   * a closed sprint's set rises as its carry-over is finished elsewhere, which counts one
   * item in two sprints. Absent on a sprint an older build closed, which reads live.
   */
  readonly done?: number
  readonly done_points?: number
  /**
   * The members that were finished at the close, done or cancelled, in id order. With
   * `carried`, which is every member that was not, this is the whole committed set: the two
   * are disjoint by construction and `membersOf` unions them. The set used to be recomputed
   * as "items pointing at the sprint, plus the carried list", so reviving or reopening a
   * member that was terminal at close and committing it onward shrank the record underneath
   * a frozen count, and a closed sprint read `committed 4` over `done 1 cancelled 1` and
   * `pts 5/3`.
   *
   * Stored as its own list rather than as the whole set, for two reasons. A whole set repeats
   * every carried id, which is the "one fact in two places" this file's header refuses; and a
   * field value is bounded at 8 KiB, so one combined list halved the number of members a
   * sprint could close with, and a 300-item sprint finished to the last item could not close
   * at all.
   */
  readonly finished?: readonly ItemId[]
  /** The total points over the committed set, frozen with the rest of the tally. */
  readonly points?: number
  /**
   * Frozen with `done` and for the same reason: a committed item cancelled after the close
   * read as `done 1 cancelled 1` over `committed 1`, one item under two outcomes, because
   * this count was still live beside a frozen one.
   */
  readonly cancelled?: number
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
  'id', 'title', 'state', 'filed_at', 'version', 'start', 'end', 'closed_at', 'carried',
  'finished', 'done', 'done_points', 'cancelled', 'points', 'goal', 'extra',
] as const

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const DAY_MS = 86_400_000

// `isCalendarDate` moved to `fields.ts`, which is where `isInstant` lives and where a day
// written into an instant field is widened; this file already imports from there, so one
// direction and one copy. It is re-exported here because the sprint rules are its first
// caller and `domain/index.ts` names it beside them.
export { isCalendarDate } from './fields.ts'

/** The UTC calendar date of an instant, which is the day a sprint boundary is compared on. */
export function dateOf(instant: Instant): CalendarDate {
  return instant.slice(0, 10)
}

/**
 * Where an instant falls in the sprint: `day` is 1 on `start` and `days` is the length,
 * both inclusive, so a two-week sprint reads `day 3/14`. Before the start `day` is 0 or
 * less and after the end it is past `days`, and neither is clamped: the arithmetic is the
 * fact, and `sprintDay` below is where it is turned into something a reader can act on.
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
 * The day a read surface prints, which is `dayOfSprint` said in a way a reader can act on.
 *
 * STR-8: a sprint dated entirely in the past reported `day 981/14` on `status`, `sprints`
 * and `board` alike. It is arithmetic nobody can use - day 981 of a 14-day sprint is not a
 * day, it is a distance - and it reads as a defect in the tool rather than as a `--start`
 * typed with the wrong year, which is what it usually is. Outside the window the distance
 * from the boundary is therefore what is printed, and the window's length stays as the
 * denominator so the column parses the same way in every row.
 *
 * No threshold decides it: `ended+2d/14` and `ended+967d/14` are the same sentence at two
 * sizes, and any cut-off between them would be a number this file could not defend. One
 * token, no spaces, because `status` prints this in a row cell that is not the last one and
 * the row grammar splits on spaces.
 */
export function sprintDay(sprint: Sprint, now: Instant): string {
  const { day, days } = dayOfSprint(sprint, now)
  if (day > days) return `ended+${day - days}d/${days}`
  if (day < 1) return `starts+${1 - day}d/${days}`
  return `${day}/${days}`
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

/**
 * The committed set a close recorded, in id order, or `undefined` where no close recorded
 * one. `points` is the marker rather than either list: an empty list cannot be written to a
 * record, because the grammar refuses an empty field value, so a sprint closed over no work
 * carries neither line. Reading that absence as "an older build closed this, count live" let
 * a hand edit point an item at such a sprint and read `committed 1` under a frozen `done 0`.
 * Every close this build performs writes `points` and no earlier one did.
 */
export function membersOf(sprint: Sprint): readonly ItemId[] | undefined {
  if (sprint.state !== 'closed' || sprint.points === undefined) return undefined
  return [...(sprint.carried ?? []), ...(sprint.finished ?? [])].sort()
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
  for (const field of ['carried', 'finished'] as const) {
    const list = sprint[field]
    if (list === undefined) continue
    if (sprint.state !== 'closed') return invalid('V4', `${field} is set on a sprint whose state is ${sprint.state}, not closed`, id)
    for (const item of list) {
      if (typeof item !== 'string' || !SLUG.test(item)) return invalid('V4', `${field} must be a list of item ids; ${String(item)} is not one`, id)
    }
    if (new Set(list).size !== list.length) return invalid('V4', `${field} names an item twice`, id)
  }
  // The two lists partition the committed set: a member was finished at the close or it was
  // carried, never both. An id in both would be counted twice by every number below it.
  if (sprint.carried !== undefined && sprint.finished !== undefined) {
    const carried = new Set(sprint.carried)
    const both = sprint.finished.find((item) => carried.has(item))
    if (both !== undefined) {
      return invalid('V4', `${both} is in carried and in finished, and a member of a closed sprint is one or the other`, id)
    }
  }
  for (const field of ['done', 'done_points', 'cancelled', 'points'] as const) {
    const value = sprint[field]
    if (value === undefined) continue
    if (sprint.state !== 'closed') return invalid('V4', `${field} is set on a sprint whose state is ${sprint.state}, not closed`, id)
    if (!Number.isInteger(value) || value < 0) return invalid('V4', `${field} must be a whole number of 0 or more`, id)
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
 *
 * A `draft` item whose fields are complete commits, and that is the decision rather than an
 * omission: planning a sprint with work nobody has refined yet is ordinary practice, and
 * `file --sprint` files in `draft` by construction, so refusing it would make that flag
 * refuse every item it can file. What was wrong was the silence afterwards, because `next`
 * ranks `ready` only: `notGroomed` in the sprint service is what every surface that commits
 * or reads a committed set now says out loud. ADR-0022 carries the argument.
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
