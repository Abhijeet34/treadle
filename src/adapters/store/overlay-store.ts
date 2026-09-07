// SPDX-License-Identifier: Apache-2.0
// The second real implementation of the store seam (DR6): a copy-on-write layer over a
// base store. It is how `--dry-run` evaluates every guard and diffs every entity without
// writing, which is a product requirement (2.15) rather than a test double. `--preview` is
// the cheaper question beside it: it resolves the target and evaluates no guard, so it runs
// against the real store and never reaches here.
//
// It writes nothing, takes no lock and touches no file, and it is still held to the same
// contract: `test/store/conformance.ts` runs against both implementations. A write here
// goes through encode, render, parse and decode exactly as the sharded store's does, so a
// dry run can never approve a record the real store would refuse to write.

import { summaryOf, type Sprint, type WorkItem, type WorkItemSummary } from '../../domain/index.ts'
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
import { decodeSprint, encodeSprint } from './sprint-codec.ts'
import { parentMissing, stillNamed, type Referrer } from './referential.ts'

function matches(item: WorkItemSummary, query: ItemQuery): boolean {
  if (query.state !== undefined && item.state !== query.state) return false
  if (query.type !== undefined && item.type !== query.type) return false
  if (query.sprint !== undefined && item.sprint_id !== query.sprint) return false
  return true
}

function order(a: WorkItemSummary, b: WorkItemSummary): number {
  return a.filed_at === b.filed_at ? a.id.localeCompare(b.id) : a.filed_at.localeCompare(b.filed_at)
}

/** The base store's rows with this layer's writes over them and its removals taken out, in `list`'s order. */
function merged<T extends WorkItemSummary>(
  base: readonly T[], pending: Iterable<T>, removed: ReadonlySet<string>, query: ItemQuery,
): readonly T[] {
  const byId = new Map(base.map((item) => [item.id, item]))
  for (const item of pending) byId.set(item.id, item)
  for (const id of removed) byId.delete(id)
  const items = [...byId.values()].filter((item) => matches(item, query)).sort(order)
  return query.limit === undefined ? items : items.slice(0, query.limit)
}

export class OverlayStore implements Store {
  readonly #base: Store
  readonly #items = new Map<string, WorkItem>()
  readonly #sprints = new Map<string, Sprint>()
  /** Ids this layer has removed, which the base store still holds; see `ItemRemoval`. */
  readonly #removed = new Set<string>()
  readonly #events: StoreEvent[] = []

  constructor(base: Store) {
    this.#base = base
  }

  async identity(): Promise<StoreResult<StoreIdentity>> {
    return this.#base.identity()
  }

  async get(id: string): Promise<StoreResult<WorkItem | undefined>> {
    if (this.#removed.has(id)) return storeOk(undefined)
    const written = this.#items.get(id)
    if (written !== undefined) return storeOk(written)
    return this.#base.get(id)
  }

  async list(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItem[]>> {
    const base = await this.#base.list({})
    if (!base.ok) return base
    return storeOk(merged(base.value, this.#items.values(), this.#removed, query))
  }

  // The overlay merges its pending writes over the whole base list on every read, which
  // ADR-0006 records as its cost, so its streaming reads hold what its array reads hold and
  // keep only the contract: the same items, the same order, the same refusal.
  async eachItem(query: ItemQuery, visit: (item: WorkItem) => void): Promise<StoreResult<number>> {
    const items = await this.list(query)
    if (!items.ok) return items
    for (const item of items.value) visit(item)
    return storeOk(items.value.length)
  }

  async summaries(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItemSummary[]>> {
    const base = await this.#base.summaries({})
    if (!base.ok) return base
    return storeOk(merged(base.value, [...this.#items.values()].map(summaryOf), this.#removed, query))
  }

  async sprints(): Promise<StoreResult<readonly Sprint[]>> {
    const base = await this.#base.sprints()
    if (!base.ok) return base
    const byId = new Map(base.value.map((sprint) => [sprint.id, sprint]))
    for (const sprint of this.#sprints.values()) byId.set(sprint.id, sprint)
    return storeOk([...byId.values()].sort((a, b) => (a.filed_at === b.filed_at ? a.id.localeCompare(b.id) : a.filed_at.localeCompare(b.filed_at))))
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

  async eachEvent(query: EventQuery, visit: (event: StoreEvent) => void): Promise<StoreResult<number>> {
    const events = await this.events(query)
    if (!events.ok) return events
    for (const event of events.value) visit(event)
    return storeOk(events.value.length)
  }

  async findings(): Promise<StoreResult<readonly Finding[]>> {
    return this.#base.findings()
  }

  async apply(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    const staged = new Map<string, WorkItem>()
    const applied: AppliedWrite[] = []
    /** Each written record's parent before this transaction, which is what says whether the write introduces one. */
    const parentWas = new Map<string, string | undefined>()
    // A dry run refuses what the real write would refuse, which is why this reads the base
    // store's findings rather than assuming a clean store (ADR-0006).
    const findings = await this.findings()
    if (!findings.ok) return findings

    for (const read of transaction.reads ?? []) {
      const current = await this.get(read.id).then((r) => (r.ok ? r.value : undefined))
      if (current?.version === read.version) continue
      return storeFail('CONFLICT', 'S10',
        `${read.id} is at version ${current?.version ?? 'none'} and the write was decided against version ${read.version}`,
        [read.id], { expected: read.version })
    }

    for (const write of transaction.writes) {
      const clash = duplicateRefusal(write.item.id, findings.value)
      if (clash !== undefined) return clash

      const current = staged.get(write.item.id) ?? await this.get(write.item.id)
        .then((r) => (r.ok ? r.value : undefined))
      const conflict = compareAndSet(write.item.id, current, write.ifVersion)
      if (conflict !== undefined) return conflict
      if (!parentWas.has(write.item.id)) parentWas.set(write.item.id, current?.parent_id)

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

    const stagedSprints = new Map<string, Sprint>()
    for (const write of transaction.sprints ?? []) {
      const held = stagedSprints.get(write.sprint.id) ?? await this.sprints()
        .then((r) => (r.ok ? r.value.find((sprint) => sprint.id === write.sprint.id) : undefined))
      const conflict = compareAndSet(write.sprint.id, held, write.ifVersion)
      if (conflict !== undefined) return conflict
      const version = (held?.version ?? 0) + 1
      const encoded = encodeSprint({ ...write.sprint, version })
      if (!encoded.ok) return encoded
      const parsed = parseRecordSource(renderRecord(encoded.value), 1)
      if (!parsed.ok) return storeFail('VALIDATION', parsed.rule, `${write.sprint.id}: ${parsed.reason}`, [write.sprint.id])
      const round = decodeSprint(parsed.record)
      if (!round.ok) return round
      stagedSprints.set(write.sprint.id, round.value)
      applied.push({ id: write.sprint.id, version })
    }

    const dropped: string[] = []
    for (const removal of transaction.removes ?? []) {
      const current = staged.get(removal.id) ?? await this.get(removal.id).then((r) => (r.ok ? r.value : undefined))
      const conflict = compareAndSet(removal.id, current, removal.ifVersion)
      if (conflict !== undefined) return conflict
      dropped.push(removal.id)
    }

    // The same referential rule the sharded store runs under its write lock (ADR-0025), so a
    // dry run refuses what the real write would. It reads the merged summaries and the merged
    // sprints, which already carry this layer's own writes over the base store's rows.
    const dangling = await this.#referentialRefusal(transaction, staged, stagedSprints, parentWas)
    if (dangling !== undefined) return dangling

    for (const [id, item] of staged) this.#items.set(id, item)
    for (const id of dropped) { this.#items.delete(id); this.#removed.add(id) }
    for (const [id, sprint] of stagedSprints) this.#sprints.set(id, sprint)
    this.#events.push(...transaction.events)
    return storeOk({ txn: transaction.txn, writes: applied, events: transaction.events.length })
  }

  /**
   * The rule ADR-0025 puts in the sharded store's critical section, decided here over the
   * arrays this layer already merges. Every id the transaction touches answers from the
   * transaction rather than from the store beneath it: a record it removes leaves nothing
   * behind, and one it writes is judged by the parent loop above rather than by the row the
   * base store still holds.
   */
  async #referentialRefusal(
    transaction: StoreTransaction,
    staged: ReadonlyMap<string, WorkItem>,
    stagedSprints: ReadonlyMap<string, Sprint>,
    parentWas: ReadonlyMap<string, string | undefined>,
  ): Promise<StoreResult<never> | undefined> {
    const removed = new Set((transaction.removes ?? []).map((removal) => removal.id))
    const items = await this.summaries()
    if (!items.ok) return items
    const held = new Set(items.value.map((item) => item.id))
    for (const id of staged.keys()) held.add(id)

    for (const item of staged.values()) {
      const parent = item.parent_id
      if (parent === undefined) continue
      if (!removed.has(parent) && held.has(parent)) continue
      if (!removed.has(parent) && parentWas.get(item.id) === parent) continue
      return parentMissing(parent, item.id)
    }

    if (removed.size === 0) return undefined
    const sprints = await this.sprints()
    if (!sprints.ok) return sprints
    const closed = sprints.value
      .map((sprint) => stagedSprints.get(sprint.id) ?? sprint)
      .filter((sprint) => sprint.state === 'closed')
    for (const id of removed) {
      const referrer = referrerIn(id, items.value, staged, removed, closed)
      if (referrer !== undefined) return stillNamed(id, referrer)
    }
    return undefined
  }

  async close(): Promise<void> {
    this.#items.clear()
    this.#sprints.clear()
    this.#removed.clear()
    this.#events.length = 0
  }
}

function compareAndSet(
  id: string, current: { readonly version: number } | undefined, ifVersion: number | undefined,
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

/**
 * The first record left naming `id` after this transaction, in the order the sharded store
 * asks the same three questions: a child's parent, a stored relation edge, then a closed
 * sprint's committed set, read as its frozen lists and as the `sprint_id` an older build's
 * close left pointing at it.
 */
function referrerIn(
  id: string,
  items: readonly WorkItemSummary[],
  staged: ReadonlyMap<string, WorkItem>,
  removed: ReadonlySet<string>,
  closed: readonly Sprint[],
): Referrer | undefined {
  const left = items.filter((item) => !removed.has(item.id) && !staged.has(item.id))
  const child = left.find((item) => item.parent_id === id)
  if (child !== undefined) return { kind: 'parent', id: child.id }
  for (const item of left) {
    const edge = (item.relations ?? []).find((relation) => relation.target === id)
    if (edge !== undefined) return { kind: 'relation', id: item.id, relation: edge.kind }
  }
  const member = items.find((item) => item.id === id)
  for (const sprint of closed) {
    const frozen = [...(sprint.carried ?? []), ...(sprint.finished ?? [])]
    if (frozen.includes(id) || member?.sprint_id === sprint.id) return { kind: 'sprint', id: sprint.id }
  }
  return undefined
}

/** The same encode, render, parse and decode the sharded store's write path runs. */
function roundTrip(item: WorkItem): StoreResult<WorkItem> {
  const encoded = encodeItem(item)
  if (!encoded.ok) return encoded
  const parsed = parseRecordSource(renderRecord(encoded.value), 1)
  if (!parsed.ok) return storeFail('VALIDATION', parsed.rule, `${item.id}: ${parsed.reason}`, [item.id])
  return decodeItem(parsed.record)
}
