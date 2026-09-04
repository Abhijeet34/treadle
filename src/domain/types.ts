// SPDX-License-Identifier: Apache-2.0
// The closed sets and the work-item value type (domain model 2.1, 2.2, 2.14).
// Every enum here is closed on purpose: gates, guards and metrics are only unambiguous
// because a type, a state and a relation kind cannot be invented by a workspace.

export type ItemId = string

/** RFC 3339 in UTC with a `Z` suffix. Validated by `isInstant`, never parsed here. */
export type Instant = string

export const WORK_ITEM_TYPES = ['epic', 'story', 'task', 'bug', 'spike', 'chore'] as const
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number]

export const WORK_ITEM_STATES = [
  'draft', 'ready', 'in_progress', 'in_review', 'done', 'on_hold', 'cancelled',
] as const
export type WorkItemState = (typeof WORK_ITEM_STATES)[number]

/** Blocked is not a state. It is derived from the relation graph; see relations.ts. */
export const TERMINAL_STATES = ['done', 'cancelled'] as const

export function isTerminal(state: WorkItemState | undefined): boolean {
  return state === 'done' || state === 'cancelled'
}

export const TRANSITIONS = [
  'groom', 'ungroom', 'start', 'submit', 'finish', 'rework', 'accept', 'reopen',
  'hold', 'resume', 'cancel', 'revive',
] as const
export type TransitionName = (typeof TRANSITIONS)[number]

export const GUARD_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const
export type GuardId = (typeof GUARD_IDS)[number]

export const RELATION_KINDS = [
  'blocks', 'duplicates', 'caused_by', 'discovered_from', 'split_from', 'relates_to',
] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export const BUG_SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const
export type BugSeverity = (typeof BUG_SEVERITIES)[number]

export const FOUND_IN_STAGES = ['dev', 'review', 'test', 'production'] as const
export type FoundInStage = (typeof FOUND_IN_STAGES)[number]

/** The workspace may configure its own scale; this is the default (2.14). */
export const DEFAULT_POINT_SCALE = [1, 2, 3, 5, 8, 13] as const

export type AcceptanceCriterion = {
  readonly text: string
  readonly ticked: boolean
}

export type WorkItem = {
  readonly id: ItemId
  readonly type: WorkItemType
  readonly state: WorkItemState
  readonly title: string
  readonly filed_at: Instant
  readonly version: number

  readonly description?: string
  readonly priority?: number
  readonly points?: number
  readonly hours_estimate?: number
  readonly parent_id?: ItemId
  readonly assignee?: string
  readonly reporter?: string
  readonly reviewer?: string
  readonly component?: string
  readonly labels?: readonly string[]
  readonly sprint_id?: string

  readonly hold_reason?: string
  readonly hold_until?: Instant
  /**
   * The state a hold was entered from. The model says on_hold "restores the state it was
   * entered from", which needs somewhere to keep it; 2.14 names the other two hold fields
   * and not this one, so it is recorded here as this implementation's storage of that rule.
   */
  readonly held_from?: WorkItemState

  readonly outcome?: string
  readonly target_date?: Instant
  readonly acceptance_criteria?: readonly AcceptanceCriterion[]
  readonly severity?: BugSeverity
  readonly repro_steps?: string
  readonly expected?: string
  readonly actual?: string
  readonly found_in?: FoundInStage
  readonly fix_confirmed?: boolean
  readonly question?: string
  readonly timebox_hours?: number
  readonly findings?: string

  /** Fields a newer writer produced that this version does not know (DR3). */
  readonly extra?: ReadonlyMap<string, string>
}
