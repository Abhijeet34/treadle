// SPDX-License-Identifier: Apache-2.0
// The second real implementation of the store seam (DR6): a copy-on-write layer over a
// base store. It is how `--dry-run` and `--preview` evaluate every guard and diff every
// entity without writing, which is a product requirement (2.15) rather than a test double.
//
// It writes nothing, takes no lock and touches no file, and it is still held to the same
// contract: `test/store/conformance.ts` runs against both implementations. A write here
// goes through encode, render, parse and decode exactly as the sharded store's does, so a
// dry run can never approve a record the real store would refuse to write.

import type { WorkItem } from '../../domain/index.ts'
import {
  duplicateRefusal,
  storeFail,
  storeOk,
  type Applied,
  type AppliedWrite,
  type EventQuery,
  type Finding,
  type ItemQuery,
  type Store,
  type StoreEvent,
  type StoreIdentity,
  type StoreResult,
  type StoreTransaction,
} from '../../application/ports/store.ts'
import { parseRecordSource, renderRecord } from './grammar.ts'
import { decodeItem, encodeItem } from './item-codec.ts'

function matches(item: WorkItem, query: ItemQuery): boolean {
  if (query.state !== undefined && item.state !== query.state) return false
  if (query.type !== undefined && item.type !== query.type) return false
  if (query.sprint !== undefined && item.sprint_id !== query.sprint) return false
  return true
}

function order(a: WorkItem, b: WorkItem): number {
  return a.filed_at === b.filed_at ? a.id.localeCompare(b.id) : a.filed_at.localeCompare(b.filed_at)
}

export class OverlayStore implements Store {
  readonly #base: Store
  readonly #items = new Map<string, WorkItem>()
  readonly #events: StoreEvent[] = []

  constructor(base: Store) {
    this.#base = base
  }

  async identity(): Promise<StoreResult<StoreIdentity>> {
    return this.#base.identity()
  }

  async get(id: string): Promise<StoreResult<WorkItem | undefined>> {
    const written = this.#items.get(id)
    if (written !== undefined) return storeOk(written)
    return this.#base.get(id)
  }

  async list(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItem[]>> {
    const base = await this.#base.list({})
    if (!base.ok) return base
    const merged = new Map(base.value.map((item) => [item.id, item]))
    for (const [id, item] of this.#items) merged.set(id, item)
    const items = [...merged.values()].filter((item) => matches(item, query)).sort(order)
    return storeOk(query.limit === undefined ? items : items.slice(0, query.limit))
  }

  async events(query: EventQuery = {}): Promise<StoreResult<readonly StoreEvent[]>> {
    const base = await this.#base.events({})
    if (!base.ok) return base
    const all = [...base.value, ...this.#events].filter((event) => {
      if (query.entity !== undefined && event.entity !== query.entity) return false
      if (query.from !== undefined && event.at < query.from) return false
      if (query.to !== undefined && event.at >= query.to) return false
      return true
    }).sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)))
    return storeOk(query.limit === undefined ? all : all.slice(0, query.limit))
  }

  async findings(): Promise<StoreResult<readonly Finding[]>> {
    return this.#base.findings()
  }

  async apply(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    const staged = new Map<string, WorkItem>()
    const applied: AppliedWrite[] = []
    // A dry run refuses what the real write would refuse, which is why this reads the base
    // store's findings rather than assuming a clean store (ADR-0006).
    const findings = await this.findings()
    if (!findings.ok) return findings

    for (const write of transaction.writes) {
      const clash = duplicateRefusal(write.item.id, findings.value)
      if (clash !== undefined) return clash

      const current = staged.get(write.item.id) ?? await this.get(write.item.id)
        .then((r) => (r.ok ? r.value : undefined))
      const conflict = compareAndSet(write.item.id, current, write.ifVersion)
      if (conflict !== undefined) return conflict

      // The sharded store carries a stored record's unknown field keys forward; the
      // overlay carries them from the item it is layering over, so a dry run diffs the
      // same bytes the real write would produce. Unknown *sections* are the one thing it
      // cannot carry, because `WorkItem` has a place for an unknown field and not for an
      // unknown section; docs/architecture/adr/0006-the-store-seam.md names that gap.
      const extra = new Map([...(current?.extra ?? []), ...(write.item.extra ?? [])])
      const version = (current?.version ?? 0) + 1
      const round = roundTrip({
        ...write.item,
        version,
        ...(extra.size === 0 ? {} : { extra }),
      })
      if (!round.ok) return round
      staged.set(write.item.id, round.value)
      applied.push({ id: write.item.id, version })
    }

    for (const [id, item] of staged) this.#items.set(id, item)
    this.#events.push(...transaction.events)
    return storeOk({ txn: transaction.txn, writes: applied, events: transaction.events.length })
  }

  async close(): Promise<void> {
    this.#items.clear()
    this.#events.length = 0
  }
}

function compareAndSet(
  id: string, current: WorkItem | undefined, ifVersion: number | undefined,
): StoreResult<never> | undefined {
  if (ifVersion === undefined) {
    if (current === undefined) return undefined
    return storeFail('CONFLICT', 'S10', `${id} already exists at version ${current.version}; a create names no version`, [id], { actual: current.version })
  }
  if (current === undefined) {
    return storeFail('CONFLICT', 'S10', `${id} is not in the store, so version ${ifVersion} cannot be matched`, [id], { expected: ifVersion })
  }
  if (current.version === ifVersion) return undefined
  return storeFail('CONFLICT', 'S10', `${id} is at version ${current.version} and the write named ${ifVersion}`, [id], { expected: ifVersion, actual: current.version })
}

/** The same encode, render, parse and decode the sharded store's write path runs. */
function roundTrip(item: WorkItem): StoreResult<WorkItem> {
  const encoded = encodeItem(item)
  if (!encoded.ok) return encoded
  const parsed = parseRecordSource(renderRecord(encoded.value), 1)
  if (!parsed.ok) return storeFail('VALIDATION', parsed.rule, `${item.id}: ${parsed.reason}`, [item.id])
  return decodeItem(parsed.record)
}
