// SPDX-License-Identifier: Apache-2.0
// The decorator that makes `-vvv` mean something: every store operation the command performs,
// with the record it touched. What it does NOT carry is the point of it; the redaction rule
// lives in src/cli/diagnostics.ts and finding F10 is why.

import type {
  Applied, EventQuery, Finding, ItemQuery, Store, StoreEvent, StoreIdentity, StoreResult, StoreTransaction,
} from '../application/ports/store.ts'
import type { Sprint, WorkItem, WorkItemSummary } from '../domain/index.ts'

export interface OperationLog {
  store(operation: string, fields: Readonly<Record<string, unknown>>): void
}

export class LoggingStore implements Store {
  readonly #inner: Store
  readonly #log: OperationLog

  constructor(inner: Store, log: OperationLog) {
    this.#inner = inner
    this.#log = log
  }

  async identity(): Promise<StoreResult<StoreIdentity>> {
    const result = await this.#inner.identity()
    this.#log.store('identity', { ok: result.ok, id: result.ok ? result.value.id : '-' })
    return result
  }

  async get(id: string): Promise<StoreResult<WorkItem | undefined>> {
    const result = await this.#inner.get(id)
    // The one read that carries a record's prose, so the one place F10's rule has to hold.
    if (result.ok && result.value !== undefined) this.#log.store('read', fieldsOf(result.value))
    this.#log.store('get', { id, found: result.ok && result.value !== undefined })
    return result
  }

  async list(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItem[]>> {
    const result = await this.#inner.list(query)
    if (result.ok) for (const item of result.value) this.#log.store('read', fieldsOf(item))
    this.#log.store('list', { n: result.ok ? result.value.length : 0 })
    return result
  }

  async eachItem(query: ItemQuery, visit: (item: WorkItem) => void): Promise<StoreResult<number>> {
    const result = await this.#inner.eachItem(query, (item) => {
      this.#log.store('read', fieldsOf(item))
      visit(item)
    })
    this.#log.store('eachItem', { n: result.ok ? result.value : 0 })
    return result
  }

  async summaries(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItemSummary[]>> {
    const result = await this.#inner.summaries(query)
    if (result.ok) for (const item of result.value) this.#log.store('read', fieldsOf(item))
    this.#log.store('summaries', { n: result.ok ? result.value.length : 0 })
    return result
  }

  async sprints(): Promise<StoreResult<readonly Sprint[]>> {
    const result = await this.#inner.sprints()
    this.#log.store('sprints', { n: result.ok ? result.value.length : 0 })
    return result
  }

  async events(query: EventQuery = {}): Promise<StoreResult<readonly StoreEvent[]>> {
    const result = await this.#inner.events(query)
    this.#log.store('events', { n: result.ok ? result.value.length : 0 })
    return result
  }

  async eachEvent(query: EventQuery, visit: (event: StoreEvent) => void): Promise<StoreResult<number>> {
    const result = await this.#inner.eachEvent(query, visit)
    this.#log.store('eachEvent', { n: result.ok ? result.value : 0 })
    return result
  }

  async apply(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    for (const write of transaction.writes) this.#log.store('write', fieldsOf(write.item))
    for (const write of transaction.sprints ?? []) this.#log.store('write', { id: write.sprint.id, state: write.sprint.state })
    const result = await this.#inner.apply(transaction)
    this.#log.store('apply', { txn: transaction.txn, ok: result.ok })
    return result
  }

  async findings(): Promise<StoreResult<readonly Finding[]>> {
    return this.#inner.findings()
  }

  async close(): Promise<void> {
    await this.#inner.close()
  }
}

/** Every field of a record, so the log is complete; the formatter decides what it may show. */
function fieldsOf(item: WorkItemSummary | WorkItem): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (value !== undefined && key !== 'extra') out[key] = value
  }
  return out
}
