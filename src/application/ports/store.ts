// SPDX-License-Identifier: Apache-2.0
// The store seam (DR6). Two real implementations ship against this file: the sharded
// Markdown store of DR2 and the copy-on-write overlay that backs `--dry-run`, and one
// conformance suite runs against both. The interface names no path and no lock, which is
// what lets a later implementation coordinate differently without a contract change.

import type { DomainErrorCode } from '../../domain/index.ts'
import type { Ceremony, Instant, ItemId, Sprint, WorkItem, WorkItemState, WorkItemSummary, WorkItemType, WorkspaceConfig } from '../../domain/index.ts'

/**
 * The domain's three codes plus the five a store can produce on its own. Widening a
 * DomainError into a StoreError is therefore total and loses nothing.
 */
export type StoreErrorCode =
  | DomainErrorCode
  | 'CONFLICT'
  | 'SCHEMA_NEWER'
  | 'SCHEMA_OLDER'
  | 'LOCK_TIMEOUT'
  | 'LOCK_LOST'
  | 'STORE_UNAVAILABLE'

export type StoreError = {
  readonly code: StoreErrorCode
  /** A rule id from the closed set in docs/architecture/adr, for example `S4`, `S10`. */
  readonly rule: string
  /** One sentence naming the file, the record and the observed value. */
  readonly message: string
  readonly entities: readonly string[]
  readonly details?: Readonly<Record<string, string | number>>
}

export type StoreResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StoreError }

export function storeOk<T>(value: T): StoreResult<T> {
  return { ok: true, value }
}

export function storeFail<T = never>(
  code: StoreErrorCode,
  rule: string,
  message: string,
  entities: readonly string[],
  details?: Readonly<Record<string, string | number>>,
): StoreResult<T> {
  return {
    ok: false,
    error: details === undefined
      ? { code, rule, message, entities }
      : { code, rule, message, entities, details },
  }
}

/** One line of the append-only event log (DR3). Keys render in this declaration order. */
export type StoreEvent = {
  readonly id: string
  readonly at: Instant
  readonly actor: string
  readonly actor_kind: string
  readonly entity_kind: string
  readonly entity: string
  readonly op: string
  readonly before?: unknown
  readonly after?: unknown
  readonly guards?: unknown
  /** Why the move was made, on the edges T4 requires one and on every override. */
  readonly reason?: string
  /** How one attempt ended, on the `release` edge that puts the item back in the queue. */
  readonly outcome?: string
  readonly cmd?: string
  readonly txn: string
}

export type ItemQuery = {
  readonly state?: WorkItemState
  readonly type?: WorkItemType
  readonly sprint?: string
  readonly limit?: number
}

export type EventQuery = {
  readonly entity?: string
  /**
   * The transaction whose events are wanted, which is the id `apply` returns and every
   * mutation's result carries. It selects across entities where `entity` selects across
   * transactions, so the two compose and `history` uses one or the other.
   */
  readonly txn?: string
  /** Inclusive lower bound on `at`. */
  readonly from?: Instant
  /** Exclusive upper bound on `at`. */
  readonly to?: Instant
  readonly limit?: number
}

/**
 * One record write. `ifVersion` is the compare-and-set token: absent asserts the item does
 * not exist yet, and a value asserts that exact stored version. The store, not the caller,
 * assigns the next version, so a version can never be forged by a caller writing one in.
 */
export type ItemWrite = {
  readonly item: WorkItem
  readonly ifVersion?: number
}

/**
 * One record a write's decision read without changing. A guard that walks other records,
 * such as the relation cycle check, names every record it read and the version it read it
 * at; the store refuses the write with `S10` if any of them moved, so two writes that each
 * passed the guard against the other's absence cannot both land. The written record itself
 * is covered by its own `ifVersion` and need not be named again.
 */
export type ItemRead = {
  readonly id: ItemId
  readonly version: number
}

/**
 * One record taken out of the store, under the same compare-and-set rule a write is under:
 * `ifVersion` asserts the exact stored version, so a removal decided against a record
 * somebody has since moved is refused with `S10` rather than dropping the newer one.
 *
 * A removal is not a write of nothing. The record leaves its shard; the event log is
 * untouched by it, keeps every event the record ever earned, and gains one more saying it
 * went, by whom and why. ADR-0024 carries the argument.
 */
export type ItemRemoval = {
  readonly id: ItemId
  readonly ifVersion: number
}

/** One sprint write, under the same compare-and-set rule as an item's. */
export type SprintWrite = {
  readonly sprint: Sprint
  readonly ifVersion?: number
}

/** One ceremony write, under the same compare-and-set rule as an item's. */
export type CeremonyWrite = {
  readonly ceremony: Ceremony
  readonly ifVersion?: number
}

export type StoreTransaction = {
  readonly txn: string
  readonly writes: readonly ItemWrite[]
  /** Sprint records, which live in one file beside the shards and land in the same journal. */
  readonly sprints?: readonly SprintWrite[]
  /** Ceremony records, month-sharded as items are and landing in the same journal. */
  readonly ceremonies?: readonly CeremonyWrite[]
  /** Records that leave the store in this transaction; see `ItemRemoval`. */
  readonly removes?: readonly ItemRemoval[]
  /** Records the decision depended on, refused as `S10` if one moved; see `ItemRead`. */
  readonly reads?: readonly ItemRead[]
  /** The workspace record, which `config set` writes; see `WorkspaceWrite`. */
  readonly workspace?: WorkspaceWrite
  readonly events: readonly StoreEvent[]
}

export type AppliedWrite = { readonly id: ItemId; readonly version: number }

export type Applied = {
  readonly txn: string
  readonly writes: readonly AppliedWrite[]
  readonly events: number
}

/** A record the store refused to serve, kept out of every query and reported here. */
export type Finding = {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly reason: string
  readonly id?: string
  /**
   * Which record kind the finding's `id` names, when it names one. A quarantined record still
   * exists, so a neighbour pointing at its id is not dangling; the kind is what keeps that
   * from being read too broadly, since an item and a sprint may not share an id but a reader
   * of one flat set cannot tell which of the two a quarantined id was. The store derives it
   * from the file it was reading, and a finding about a file rather than a record has none.
   */
  readonly kind?: 'item' | 'sprint' | 'ceremony'
}

/**
 * S3 on the write path, shared by both implementations. A duplicated id names no single
 * record, so a write is refused rather than resolved by document order: picking the first
 * copy silently is the reference implementation's own recorded risk, and it is worse on a
 * write than on a read because the caller never learns which copy moved.
 */
export function duplicateRefusal(
  id: ItemId, findings: readonly Finding[],
): StoreResult<never> | undefined {
  const clash = findings.find((finding) => finding.rule === 'S3' && finding.id === id)
  if (clash === undefined) return undefined
  return storeFail(
    'CONFLICT', 'S3',
    `${id} names more than one record here, so a write cannot say which one it means: ${clash.reason}`,
    [id],
  )
}

/**
 * The workspace record, whole. It carries the printed identity and the configuration
 * together because they are one record in one file: splitting them across two port methods
 * would stat and parse `workspace.md` twice on every command, and the read every command
 * already performs is the freshness pass that names it once.
 *
 * `config` is always a value. A configuration this build cannot read is a finding the store
 * reports rather than a refusal here, so `doctor` can still be run over the file that says
 * it; `readWorkspace` is what turns that finding into the refusal every other command gives.
 */
export type StoreIdentity = {
  readonly id: string
  readonly name: string
  /** Absent for a store that has no path, which the overlay is. */
  readonly path?: string
  /** The record's compare-and-set token. Zero on a workspace written before `config set`. */
  readonly version: number
  readonly config: WorkspaceConfig
  /**
   * How many field keys the workspace record carries that this build has no meaning for. A
   * newer writer's key is kept verbatim (DR3) and counted rather than printed, which is the
   * decision the item and sprint dictionaries already made for `extra`: printing one invites
   * a caller to act on a value nothing here can validate, and printing nothing at all made a
   * mistyped configuration key indistinguishable from one nobody wrote.
   */
  readonly extra: number
}

/**
 * The workspace record this transaction writes, under the same compare-and-set rule an item
 * and a sprint are under. There is one such record per store, so this is a single value
 * rather than a list, and `ifVersion` is the version the decision was made against.
 */
export type WorkspaceWrite = {
  readonly config: WorkspaceConfig
  readonly ifVersion: number
}

export interface Store {
  /** The one printed identity every command resolves before it runs (2.17 rule 4). */
  identity(): Promise<StoreResult<StoreIdentity>>
  get(id: ItemId): Promise<StoreResult<WorkItem | undefined>>
  list(query?: ItemQuery): Promise<StoreResult<readonly WorkItem[]>>
  /**
   * The same items as `list` in the same order, as the fields a scan over the whole set
   * reads. The prose and the lists of one record are `get`'s to serve. Every field is the
   * record's own as `list` would serve it, never a cached approximation of it.
   */
  summaries(query?: ItemQuery): Promise<StoreResult<readonly WorkItemSummary[]>>
  /**
   * `list` without the array: `visit` sees each item `list` would return, in its order, and
   * the count comes back. The read is refused where `list` refuses it, and an item visited
   * before the refusal is the caller's to discard. `doctor` is the reader: it audits every
   * field of every record and held all of them at once, 484 MiB of the 1,442 it allocated
   * at 50,000 items, to look at each one once.
   */
  eachItem(query: ItemQuery, visit: (item: WorkItem) => void): Promise<StoreResult<number>>
  /** Every sprint the store holds, in the order they were opened. There are few, so no query. */
  sprints(): Promise<StoreResult<readonly Sprint[]>>
  /**
   * Every ceremony record the store holds, oldest first. A retrospective is filed once a
   * sprint, so the whole set is read as `sprints` is rather than queried; the layout is
   * month-sharded because DR2 drew it that way and a shard is what a reviewer reads in a diff.
   */
  ceremonies(): Promise<StoreResult<readonly Ceremony[]>>
  events(query?: EventQuery): Promise<StoreResult<readonly StoreEvent[]>>
  /** `events` without the array, under the same contract as `eachItem`; 865 MiB of the same call. */
  eachEvent(query: EventQuery, visit: (event: StoreEvent) => void): Promise<StoreResult<number>>
  /** All-or-nothing: every write lands or none does, under the store's own serialisation. */
  apply(transaction: StoreTransaction): Promise<StoreResult<Applied>>
  /** Quarantined records and load-time integrity violations, in file and line order. */
  findings(): Promise<StoreResult<readonly Finding[]>>
  close(): Promise<void>
}
