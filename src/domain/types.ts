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
export function isTerminal(state: WorkItemState | undefined): boolean {
  return state === 'done' || state === 'cancelled'
}

export const TRANSITIONS = [
  'groom', 'ungroom', 'start', 'submit', 'finish', 'rework', 'accept', 'reopen',
  'hold', 'resume', 'cancel', 'release', 'revive',
] as const
export type TransitionName = (typeof TRANSITIONS)[number]

/**
 * Why a cancelled item stopped. A state says where an item may go next and a resolution
 * says why it went nowhere, which is the separation that lets the captain's "rejected" be
 * recorded without an eighth state and the eight edges one would need.
 */
export const RESOLUTIONS = [
  'wont_do', 'duplicate', 'superseded', 'cannot_reproduce', 'rejected',
] as const
export type Resolution = (typeof RESOLUTIONS)[number]

/**
 * How one attempt ended when the item went back to the queue. It is a fact about the
 * attempt rather than about the item, so it lives in the event and never on the record.
 */
export const ATTEMPT_OUTCOMES = ['failed', 'yielded'] as const
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number]

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

/**
 * What a piece of evidence is, closed so a list of pointers can be counted and filtered
 * rather than read. The set is the seven artefact kinds this tool's callers actually
 * produce; anything else is a `url` or a `file`, which is why both are in it.
 */
export const EVIDENCE_KINDS = ['commit', 'pr', 'run', 'test', 'file', 'url', 'report'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/**
 * A pointer to evidence that lives somewhere a third party can open it, never the evidence
 * itself. `ref` carries no space because it is a hash, a path, a run id or a URL, and a
 * bounded `label` says which one of those it is; the prose that would explain it belongs in
 * the artefact the ref names. ADR-0011 carries the argument for the bounds.
 */
export type EvidencePointer = {
  readonly kind: EvidenceKind
  readonly ref: string
  readonly label?: string
}

/** The workspace may configure its own scale; this is the default (2.14). */
export const DEFAULT_POINT_SCALE = [1, 2, 3, 5, 8, 13] as const

export type AcceptanceCriterion = {
  readonly text: string
  readonly ticked: boolean
}

/**
 * The fields a scan over every item reads: what `backlog` filters and sorts on, what
 * `status` counts, what a gate reads of a child, what `next` scores. A view over the whole
 * workspace holds these and nothing else, and one record's prose and lists are read on
 * demand; `docs/architecture/adr/0013-the-view-is-a-projection.md` carries the measurement.
 * Every one is a `WorkItem` field, so a whole item is a summary wherever one is asked for.
 */
export const SUMMARY_FIELDS = [
  'id', 'type', 'state', 'title', 'filed_at', 'version',
  'priority', 'points', 'parent_id', 'assignee', 'sprint_id', 'resolution', 'due', 'severity',
] as const

export type WorkItemSummary = Pick<WorkItem, (typeof SUMMARY_FIELDS)[number]>

/** The summary of a whole item: its summary fields, each present only where the item has it. */
export function summaryOf(item: WorkItem): WorkItemSummary {
  const out: Record<string, unknown> = {}
  for (const field of SUMMARY_FIELDS) if (item[field] !== undefined) out[field] = item[field]
  return out as WorkItemSummary
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
  /** Bounded pointers at artefacts a third party can open, appended and never edited. */
  readonly evidence?: readonly EvidencePointer[]

  /** An optional date the work is wanted by. `overdue` is derived from it; see dates.ts. */
  readonly due?: Instant

  readonly hold_reason?: string
  readonly hold_until?: Instant
  /**
   * The state a hold was entered from. The model says on_hold "restores the state it was
   * entered from", which needs somewhere to keep it; 2.14 names the other two hold fields
   * and not this one, so it is recorded here as this implementation's storage of that rule.
   */
  readonly held_from?: WorkItemState

  /** Set by `cancel` and cleared by `revive`, and refused in every other state. */
  readonly resolution?: Resolution

  readonly outcome?: string
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
