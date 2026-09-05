// SPDX-License-Identifier: Apache-2.0
// One date field, and the two things that read it (report section 3.3).
//
// 2.2's last paragraph is the rule this file obeys: the tool never auto-transitions an item,
// because a silent state change is exactly what the audit log exists to prevent. A date that
// passes may change what a read says and may never change what a record says, so nothing
// here writes and `overdue` is derived on every read exactly as `blocked` is.

import { isTerminal, type Instant, type ItemId, type WorkItem } from './types.ts'

const DAY_MS = 86_400_000

/** The ceiling `next` scores against, so one forgotten item cannot own the ranking. */
export const MAX_OVERDUE_DAYS = 30

/**
 * True when the item is wanted by an instant that has passed and the work is still open.
 * A terminal item is never overdue: the date said when the work was wanted, and the work
 * has stopped, so the flag would name a fact nobody can act on.
 */
export function isOverdue(item: WorkItem, now: Instant): boolean {
  if (item.due === undefined || isTerminal(item.state)) return false
  const due = Date.parse(item.due)
  const at = Date.parse(now)
  return Number.isFinite(due) && Number.isFinite(at) && due < at
}

/** Whole days past `due`, clamped, and zero when the item is not overdue. */
export function daysOverdue(item: WorkItem, now: Instant): number {
  if (!isOverdue(item, now)) return 0
  const days = Math.floor((Date.parse(now) - Date.parse(item.due as string)) / DAY_MS)
  return Math.max(0, Math.min(MAX_OVERDUE_DAYS, days))
}

/**
 * One workspace-health finding: a rule id, the record it names and the value it saw. The
 * rule id says what the condition is, as every rule id in this tool does, so the third
 * column carries the observed value rather than a sentence restating the id.
 */
export type HealthFinding = {
  readonly rule: string
  readonly id: ItemId
  readonly observed: string
}

/**
 * `H17`, and the reason the date field is worth its bytes at all: a due date nobody is
 * assigned is a date nothing acts on, which is decoration. The finding names the record so
 * the remedy is one command. `doctor` is the command the design gives these findings; until
 * it lands `status` carries them, and it consumes this function unchanged when it arrives.
 */
export function healthFindings(items: readonly WorkItem[], now: Instant): readonly HealthFinding[] {
  return items
    .filter((item) => isOverdue(item, now) && item.assignee === undefined)
    .map((item): HealthFinding => ({ rule: 'H17', id: item.id, observed: String(item.due) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
