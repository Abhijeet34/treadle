// SPDX-License-Identifier: Apache-2.0
// The store seam (DR6). Two real implementations ship against this file: the sharded
// Markdown store of DR2 and the copy-on-write overlay that backs `--dry-run`, and one
// conformance suite runs against both. The interface names no path and no lock, which is
// what lets a later implementation coordinate differently without a contract change.

import type { DomainError, DomainErrorCode } from '../../domain/index.ts'
import type { Instant, ItemId, WorkItem, WorkItemState, WorkItemType } from '../../domain/index.ts'

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

/** Carries a domain refusal outward unchanged apart from the rule id defaulting. */
export function fromDomainError<T = never>(error: DomainError): StoreResult<T> {
  return storeFail(error.code, error.rule ?? 'V4', error.message, error.entities, error.details)
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

export type StoreTransaction = {
  readonly txn: string
  readonly writes: readonly ItemWrite[]
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
}

export type StoreIdentity = {
  readonly id: string
  readonly name: string
  /** Absent for a store that has no path, which the overlay is. */
  readonly path?: string
}

export interface Store {
  /** The one printed identity every command resolves before it runs (2.17 rule 4). */
  identity(): Promise<StoreResult<StoreIdentity>>
  get(id: ItemId): Promise<StoreResult<WorkItem | undefined>>
  list(query?: ItemQuery): Promise<StoreResult<readonly WorkItem[]>>
  events(query?: EventQuery): Promise<StoreResult<readonly StoreEvent[]>>
  /** All-or-nothing: every write lands or none does, under the store's own serialisation. */
  apply(transaction: StoreTransaction): Promise<StoreResult<Applied>>
  /** Quarantined records and load-time integrity violations, in file and line order. */
  findings(): Promise<StoreResult<readonly Finding[]>>
  close(): Promise<void>
}
