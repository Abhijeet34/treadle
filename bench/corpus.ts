// SPDX-License-Identifier: Apache-2.0
// Corpora written through the landed store, not synthesised as files. A generator that
// wrote the Markdown itself would measure a format rather than a product, and would drift
// from the store the first time the grammar changed.
//
// Deterministic from one seed: mulberry32 (the same PRNG the store fixtures use, imported
// rather than copied) plus zero-padded ids means two runs of the same spec produce
// byte-identical corpora, which is what makes two runs comparable.

import { constants as fsConstants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { cp, mkdir, rename, rm, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { random } from '../test/helpers/store-fixtures.ts'
import {
  BUG_SEVERITIES,
  FOUND_IN_STAGES,
  type ItemId,
  type StoredRelation,
  type WorkItem,
  type WorkItemState,
  type WorkItemType,
} from '../src/domain/index.ts'
import { ShardedStore, createWorkspace } from '../src/adapters/store/index.ts'
import type { StoreEvent } from '../src/application/ports/store.ts'

/**
 * The state mix. `ready` is the state axis A4's list reads, and DR2 measured 7,312 of 50,000
 * matching it, so 15% is the shape that measurement was taken against.
 */
const STATE_MIX: readonly (readonly [WorkItemState, number])[] = [
  ['draft', 0.20], ['ready', 0.15], ['in_progress', 0.10], ['in_review', 0.08],
  ['done', 0.40], ['on_hold', 0.04], ['cancelled', 0.03],
]

const TYPE_MIX: readonly (readonly [WorkItemType, number])[] = [
  ['story', 0.40], ['task', 0.30], ['bug', 0.18], ['chore', 0.06], ['spike', 0.03], ['epic', 0.03],
]

const OPS = ['file', 'groom', 'start', 'comment', 'estimate', 'assign', 'submit', 'accept'] as const

export type CorpusSpec = {
  readonly items: number
  readonly eventsPerItem: number
  /** Calendar months the shard key spreads over. DR2's corpora used 24 files at every scale. */
  readonly months: number
  readonly seed: number
  /** The last month of the range, `yyyy-mm`. Fixed so a corpus does not drift with today. */
  readonly lastMonth: string
  /**
   * Edges per hundred items, and impediments per hundred. A corpus with none of either
   * priced nothing that reads the relation graph, and every command reads it: `readWorkspace`
   * builds the graph on every invocation.
   */
  readonly relationsPerHundredItems: number
  readonly impedimentsPerHundredItems: number
}

export type Corpus = {
  readonly spec: CorpusSpec
  readonly root: string
  /** Read back from the store after generation, never assumed from the spec. */
  readonly itemsInStore: number
  readonly eventsWritten: number
  readonly months: readonly string[]
  readonly largestMonth: string
  readonly largestMonthItems: number
  readonly largestMonthBytes: number
  readonly readyMatches: number
  readonly impediments: number
  readonly relations: { readonly total: number; readonly blocks: number; readonly duplicates: number; readonly relates_to: number }
  /** The longest `blocks` chain the generator laid down, which is what the cycle check walks. */
  readonly longestBlocksChain: number
  readonly probeIds: { readonly get: string; readonly transition: string }
  readonly bytes: { readonly items: number; readonly events: number }
  readonly generatedMs: number | undefined
  /** What cloning the cache entry into this run's private directory cost. Absent when the
   *  run generated its own corpus and had nothing to clone. */
  readonly cloneMs: number | undefined
  readonly reused: boolean
}

function pickWeighted<T>(mix: readonly (readonly [T, number])[], roll: number): T {
  let acc = 0
  for (const [value, weight] of mix) {
    acc += weight
    if (roll < acc) return value
  }
  return mix[mix.length - 1]![0]
}

function monthRange(lastMonth: string, count: number): readonly string[] {
  const [year, month] = lastMonth.split('-').map(Number) as [number, number]
  const out: string[] = []
  for (let back = count - 1; back >= 0; back -= 1) {
    const index = (year * 12 + (month - 1)) - back
    out.push(`${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`)
  }
  return out
}

const WORDS = [
  'index', 'shard', 'lock', 'render', 'parse', 'migrate', 'gate', 'quarantine', 'journal',
  'cadence', 'handover', 'review', 'backlog', 'impediment', 'cursor', 'schema', 'event',
  'conflict', 'quarantine', 'freshness', 'overlay', 'transition', 'estimate', 'velocity',
]

function sentence(next: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i += 1) out.push(WORDS[Math.floor(next() * WORDS.length)] as string)
  return out.join(' ')
}

/** One item, fully determined by the index and the seed, with the fields its type requires. */
function itemAt(
  index: number, next: () => number, months: readonly string[],
  epics: readonly { readonly id: string; readonly month: string }[],
): WorkItem {
  const id = `wi-${String(index).padStart(6, '0')}`
  const month = months[Math.floor(next() * months.length)] as string
  const day = String(1 + Math.floor(next() * 28)).padStart(2, '0')
  const type = pickWeighted(TYPE_MIX, next())
  const state = pickWeighted(STATE_MIX, next())
  const base: Record<string, unknown> = {
    id,
    type,
    state,
    title: sentence(next, 4 + Math.floor(next() * 5)),
    filed_at: `${month}-${day}T${String(Math.floor(next() * 24)).padStart(2, '0')}:00:00Z`,
    version: 1,
    description: sentence(next, 12 + Math.floor(next() * 20)),
    priority: 1 + Math.floor(next() * 5),
    assignee: `person-${Math.floor(next() * 12)}`,
    labels: [`area-${Math.floor(next() * 8)}`],
  }
  // Parents point at epics generated before this item, so the hierarchy is a forest and the
  // cycle check on every refresh has real edges to walk rather than none.
  //
  // Filed no later than this item, because the shards go in a month at a time in month order:
  // an epic filed in a later month is not in the store when this item's shard lands, and the
  // store refuses a create that names a parent it does not hold, exactly as `file --parent`
  // does (ADR-0025). The draw is one `next()` either way, so the stream stays where it was.
  if (type !== 'epic' && epics.length > 0 && next() < 0.6) {
    const draw = next()
    const eligible = epics.filter((epic) => epic.month <= month)
    if (eligible.length > 0) base['parent_id'] = eligible[Math.floor(draw * eligible.length)]?.id
  }
  if (state === 'on_hold') {
    base['hold_reason'] = sentence(next, 6)
    base['held_from'] = next() < 0.5 ? 'ready' : 'in_progress'
  }
  if (type === 'epic') base['outcome'] = sentence(next, 10)
  if (type === 'story') {
    base['acceptance_criteria'] = [0, 1, 2].map(() => ({ text: sentence(next, 6), ticked: next() < 0.5 }))
  }
  if (type === 'bug') {
    base['severity'] = BUG_SEVERITIES[Math.floor(next() * BUG_SEVERITIES.length)]
    base['repro_steps'] = sentence(next, 14)
    base['found_in'] = FOUND_IN_STAGES[Math.floor(next() * FOUND_IN_STAGES.length)]
  }
  if (type === 'spike') base['question'] = sentence(next, 8)
  return base as unknown as WorkItem
}

/**
 * The same record as an impediment. The draw is not re-rolled, so every other item in the
 * corpus is byte-identical to one generated without impediments and the difference between
 * two runs is exactly the records this replaces. An impediment must say what would clear it,
 * and one that blocks nothing is doctor finding H27, so the caller raises an edge for each.
 */
function asImpediment(item: WorkItem): WorkItem {
  const base: Record<string, unknown> = {
    id: item.id,
    type: 'impediment',
    // A terminal impediment is inactive on every read, so a corpus of resolved ones would
    // price the graph and nothing that walks it. These stand open.
    state: item.state === 'done' || item.state === 'cancelled' ? 'in_progress' : item.state,
    title: item.title,
    filed_at: item.filed_at,
    version: 1,
    description: item.description,
    priority: item.priority,
    assignee: item.assignee,
    labels: item.labels,
    severity: item.severity ?? 'S2',
    proposed_resolution: `platform clears ${item.id}`,
  }
  if (item.state === 'on_hold') {
    base['hold_reason'] = item.hold_reason
    base['held_from'] = item.held_from
  }
  return base as unknown as WorkItem
}

/**
 * `blocks` runs strictly from a lower index to a higher one, in chains, which makes the
 * graph acyclic on purpose: `findRelationCycle` returns on the first cycle it finds, so a
 * corpus with one in it measures how fast the check gives up rather than what it costs. A
 * chain is also what the walk is about, since `pathBetween` follows `blocks` and nothing
 * else. Every impediment gets the first edge, so none of them is finding H27.
 */
function relationsFor(
  items: readonly WorkItem[], impediments: readonly number[], edges: number, next: () => number,
): { readonly byIndex: ReadonlyMap<number, StoredRelation[]>; readonly chain: number } {
  const byIndex = new Map<number, StoredRelation[]>()
  const duplicated = new Set<number>()
  // The impediment pass and the chain pass can reach for the same edge, and a record holding
  // one twice is a store refusal rather than a shrug. An edge already written is not an edge
  // written, so `written` only counts what landed.
  const already = new Set<string>()
  const add = (index: number, relation: StoredRelation): boolean => {
    const key = `${index}:${relation.kind}:${relation.target}`
    if (already.has(key)) return false
    already.add(key)
    const held = byIndex.get(index)
    if (held === undefined) byIndex.set(index, [relation])
    else held.push(relation)
    return true
  }
  const idAt = (index: number): ItemId | undefined => items[index]?.id
  let written = 0

  for (const index of impediments) {
    const target = idAt(index + 1 + Math.floor(next() * 8))
    if (target === undefined) throw new Error(`impediment at index ${index} has nothing to block`)
    if (add(index, { kind: 'blocks', target })) written += 1
  }

  // Chains of eight, so the walk from any node has somewhere to go without approaching the
  // depth ceiling of 64, which would turn the measurement into a refusal.
  const chain = 8
  let at = 0
  while (written < edges && at < items.length - chain - 1) {
    const roll = next()
    if (roll < 0.5) {
      for (let step = 0; step < chain && written < edges; step += 1) {
        const target = idAt(at + step + 1)
        if (target === undefined) break
        if (add(at + step, { kind: 'blocks', target })) written += 1
      }
      at += chain + 1
      continue
    }
    if (roll < 0.7 && !duplicated.has(at)) {
      const target = idAt(at + 1 + Math.floor(next() * 32))
      if (target !== undefined && add(at, { kind: 'duplicates', target })) {
        duplicated.add(at)
        written += 1
      }
      at += 3
      continue
    }
    // Symmetric, so the store holds it once on the lower id, which is the lower index here.
    const target = idAt(at + 1 + Math.floor(next() * 64))
    if (target !== undefined && add(at, { kind: 'relates_to', target })) written += 1
    at += 3
  }

  return { byIndex, chain }
}

/**
 * Events land on or after the instant their item was filed. Dating them anywhere in the
 * month put a third of them before it, which is doctor finding H23: 2,000 of the 5,297
 * findings over the 1,000-item corpus were the generator's, not the product's, and a corpus
 * that manufactures findings measures the reporting of them rather than the store.
 */
function eventsFor(item: WorkItem, count: number, next: () => number): readonly StoreEvent[] {
  const out: StoreEvent[] = []
  const month = item.filed_at.slice(0, 7)
  const filedDay = Number(item.filed_at.slice(8, 10))
  const filedHour = Number(item.filed_at.slice(11, 13))
  for (let i = 0; i < count; i += 1) {
    const day = filedDay + Math.floor(next() * (29 - filedDay))
    // The item is filed on the hour and an event is at half past, so the same hour is after.
    const hour = day === filedDay ? filedHour + Math.floor(next() * (24 - filedHour)) : Math.floor(next() * 24)
    out.push({
      id: `ev-${item.id}-${String(i).padStart(2, '0')}`,
      at: `${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:30:00Z`,
      actor: `person-${Math.floor(next() * 12)}`,
      actor_kind: 'person',
      entity_kind: 'work_item',
      entity: item.id,
      op: OPS[Math.floor(next() * OPS.length)] as string,
      txn: `txn-${item.id}-${String(i).padStart(2, '0')}`,
    })
  }
  return out
}

/** Non-empty lines across every `.jsonl` file under `dir`: one event each, which is how the log is written. */
async function eventLines(dir: string): Promise<number> {
  let total = 0
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith('.jsonl'))) {
    total += readFileSync(path.join(dir, name), 'utf8').split('\n').filter((line) => line.length > 0).length
  }
  return total
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const info = await stat(path.join(dir, name)).catch(() => undefined)
    if (info === undefined) continue
    total += info.isDirectory() ? await directoryBytes(path.join(dir, name)) : info.size
  }
  return total
}

const MANIFEST = '.bench-manifest.json'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function manifestOf(spec: CorpusSpec): string {
  return JSON.stringify(spec)
}

/**
 * Everything that decides a corpus's bytes: the spec, and the source of everything that
 * writes it or draws from it - this file, the store it writes through, the domain constants
 * `itemAt` and `asImpediment` read directly (`BUG_SEVERITIES`, `FOUND_IN_STAGES`), and the
 * `mulberry32` generator that drives every roll. A
 * cache entry is named by this, so a corpus generated by an older generator, against an older
 * store grammar, or off a changed domain constant or RNG can never be found at the path a
 * newer run looks up. That is what makes reuse safe without a validation pass over hundreds of
 * megabytes of records.
 */
function fingerprintOf(spec: CorpusSpec): string {
  const hash = createHash('sha256').update(manifestOf(spec))
  const storeDir = path.join(HERE, '..', 'src', 'adapters', 'store')
  const domainDir = path.join(HERE, '..', 'src', 'domain')
  const sources = [
    path.join(HERE, 'corpus.ts'),
    path.join(HERE, '..', 'test', 'helpers', 'store-fixtures.ts'),
    ...readdirSync(storeDir).filter((name) => name.endsWith('.ts')).sort().map((name) => path.join(storeDir, name)),
    ...readdirSync(domainDir).filter((name) => name.endsWith('.ts')).sort().map((name) => path.join(domainDir, name)),
  ]
  for (const file of sources) hash.update(readFileSync(file))
  return hash.digest('hex').slice(0, 12)
}

/**
 * Copy-on-write where the filesystem has it (APFS, btrfs, xfs), a byte copy where it does
 * not. The whole reuse story rests on this being cheap, so the figure it costs is measured
 * per run and reported as `cloneMs` rather than assumed.
 */
async function cloneTree(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, mode: fsConstants.COPYFILE_FICLONE })
}

async function generateInto(root: string, spec: CorpusSpec): Promise<Generated> {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const created = await createWorkspace(root, {
    id: `bench-${spec.items}`,
    name: `Benchmark corpus, ${spec.items} items`,
    at: `${spec.lastMonth}-01T00:00:00Z`,
  })
  if (!created.ok) throw new Error(`corpus workspace: ${created.error.message}`)
  const generated = await generate(root, spec)
  await writeFile(path.join(root, MANIFEST), manifestOf(spec))
  return generated
}

/**
 * The corpus a run measures: its own private clone, taken from a shared cache entry that
 * nothing ever mutates. Isolation is the default here rather than a `TREADLE_BENCH_DIR` a
 * caller has to remember, because every axis mutates what it measures - A1 writes records,
 * A5 edits shard lines, A4 deletes the index - and two runs sharing one root produce figures
 * that look ordinary and describe a corpus neither of them was in.
 *
 * A cache entry is built under a private staging name and moved into place with one
 * `rename`, so a half-written corpus never occupies the path a reader looks up, and a process
 * killed mid-generation leaves staging litter rather than a plausible short corpus.
 *
 * Ceiling: nothing prunes the cache, so each generator version orphans the entries it
 * supersedes, about 354 MB for a full set of four. Reaping one automatically would race a run
 * cloning it; bench/README.md carries the reasoning and the manual remedy.
 */
export async function acquireCorpus(
  cacheDir: string, runDir: string, spec: CorpusSpec, rebuild: boolean,
): Promise<Corpus> {
  const root = path.join(runDir, `ws-${spec.items}`)
  await mkdir(runDir, { recursive: true })

  // `--rebuild-corpus` generates straight into the run's own directory and neither reads nor
  // writes the cache: replacing a published entry cannot be made safe against a concurrent
  // reader, and a private build is what a caller who distrusts the cache is asking for.
  if (rebuild) return readBack(spec, root, await generateInto(root, spec), false, undefined)

  await mkdir(cacheDir, { recursive: true })
  const cached = path.join(cacheDir, `ws-${spec.items}-${fingerprintOf(spec)}`)
  let generated: Generated | undefined
  if (!existsSync(path.join(cached, MANIFEST))) {
    const staging = path.join(cacheDir, `.staging-${process.pid}-${randomUUID().slice(0, 8)}`)
    generated = await generateInto(staging, spec)
    // Whoever renames first owns the entry. A loser discards its own work instead of deleting
    // the winner's, which is why publication needs no lock and cannot disturb a reader.
    const published = await rename(staging, cached).then(() => true).catch(() => false)
    if (!published) await rm(staging, { recursive: true, force: true })
  }

  await rm(root, { recursive: true, force: true })
  const started = performance.now()
  await cloneTree(cached, root)
  const cloneMs = performance.now() - started
  return readBack(spec, root, generated, generated === undefined, cloneMs)
}

async function readBack(
  spec: CorpusSpec, root: string, generated: Generated | undefined, reused: boolean, cloneMs: number | undefined,
): Promise<Corpus> {
  const store = new ShardedStore(root)
  try {
    return await readBackWith(store, spec, root, generated, reused, cloneMs)
  } finally {
    // Every refusal below leaves this connection open otherwise, and a corpus directory whose
    // index is still held cannot be removed on Windows at all: the isolation suite, whose
    // whole subject is a corpus short of its spec, failed there on `EBUSY unlink
    // index.sqlite-shm` in its own cleanup rather than on anything it asserts.
    await store.close()
  }
}

async function readBackWith(
  store: ShardedStore,
  spec: CorpusSpec, root: string, generated: Generated | undefined, reused: boolean, cloneMs: number | undefined,
): Promise<Corpus> {
  const items: WorkItem[] = []
  const all = await store.eachItem({}, (item) => items.push(item))
  if (!all.ok) throw new Error(`corpus readback: ${all.error.message}`)
  // A corpus short of its spec is the failure this rig must never absorb: the figures it
  // produces look ordinary and measure something else. The readback happens either way, so
  // comparing two counts costs nothing, and a stop here is the outcome a reader notices.
  if (items.length !== spec.items) {
    throw new Error(`corpus at ${root}: store holds ${items.length} items, spec says ${spec.items}`)
  }
  // The events are counted off the log files for the same reason: `eventsWritten` was the
  // spec's arithmetic, so a cache entry missing an events file was cloned, reported whole
  // and measured, while a missing shard was refused by the count above.
  const eventsWritten = await eventLines(path.join(root, 'events'))
  const eventsWanted = spec.items * spec.eventsPerItem
  if (eventsWritten !== eventsWanted) {
    throw new Error(`corpus at ${root}: the log holds ${eventsWritten} events, spec says ${eventsWanted}`)
  }
  const readyRows: WorkItem[] = []
  const ready = await store.eachItem({ state: 'ready' }, (item) => readyRows.push(item))
  if (!ready.ok) throw new Error(`corpus readback: ${ready.error.message}`)

  const perMonth = new Map<string, number>()
  for (const item of items) {
    const month = item.filed_at.slice(0, 7)
    perMonth.set(month, (perMonth.get(month) ?? 0) + 1)
  }
  const months = [...perMonth.keys()].sort()
  const largestMonth = months.reduce((best, m) => ((perMonth.get(m) ?? 0) > (perMonth.get(best) ?? 0) ? m : best), months[0] as string)
  const largestBytes = (await stat(path.join(root, 'items', `${largestMonth}.md`)).catch(() => undefined))?.size ?? 0

  // Two probe ids from the largest shard: a read of the biggest file is the worst case a
  // read has, and the transition probe must be an item a create never collides with.
  const inLargest = items.filter((i) => i.filed_at.slice(0, 7) === largestMonth).map((i) => i.id).sort()

  return {
    spec,
    root,
    itemsInStore: items.length,
    eventsWritten,
    months,
    largestMonth,
    largestMonthItems: perMonth.get(largestMonth) ?? 0,
    largestMonthBytes: largestBytes,
    readyMatches: readyRows.length,
    impediments: items.filter((item) => item.type === 'impediment').length,
    relations: relationTally(items),
    longestBlocksChain: generated?.chain ?? 8,
    probeIds: {
      get: inLargest[Math.floor(inLargest.length / 2)] as string,
      transition: inLargest[inLargest.length - 1] as string,
    },
    bytes: {
      items: await directoryBytes(path.join(root, 'items')),
      events: await directoryBytes(path.join(root, 'events')),
    },
    generatedMs: generated?.ms,
    cloneMs,
    reused,
  }
}

/** The stored edges by kind, which is what the corpora table reports the graph as. */
function relationTally(items: readonly WorkItem[]): Corpus['relations'] {
  const tally = { total: 0, blocks: 0, duplicates: 0, relates_to: 0 }
  for (const item of items) {
    for (const relation of item.relations ?? []) {
      tally.total += 1
      if (relation.kind === 'blocks') tally.blocks += 1
      else if (relation.kind === 'duplicates') tally.duplicates += 1
      else if (relation.kind === 'relates_to') tally.relates_to += 1
    }
  }
  return tally
}

/** What a generation run reports back: how long it took, and the longest blocks chain in it. */
type Generated = {
  readonly ms: number
  readonly chain: number
}

/**
 * One transaction per month shard, so a shard is written once rather than per record. The
 * items are built whole before any of them is written, because the relation graph is a
 * statement about the set and cannot be decided one record at a time.
 */
async function generate(root: string, spec: CorpusSpec): Promise<Generated> {
  const store = new ShardedStore(root)
  try {
    return await generateWith(store, spec)
  } finally {
    // Same reason as `readBack`: a corpus that fails part way through leaves a handle on its
    // index, and the directory it sits in is then undeletable on Windows.
    await store.close()
  }
}

async function generateWith(store: ShardedStore, spec: CorpusSpec): Promise<Generated> {
  const next = random(spec.seed)
  const months = monthRange(spec.lastMonth, spec.months)
  const started = performance.now()

  const epics: { id: string; month: string }[] = []
  const drawn: WorkItem[] = []
  const impedimentEvery = spec.impedimentsPerHundredItems <= 0
    ? 0 : Math.max(1, Math.round(100 / spec.impedimentsPerHundredItems))
  const impedimentIndexes: number[] = []
  for (let i = 1; i <= spec.items; i += 1) {
    const drawnItem = itemAt(i, next, months, epics)
    if (drawnItem.type === 'epic' && epics.length < 64) epics.push({ id: drawnItem.id, month: drawnItem.filed_at.slice(0, 7) })
    // An epic is a parent to items already generated, so replacing one would leave those
    // parent edges pointing at an impediment.
    // The blocked item is drawn from the eight that follow, so an impediment in the last
    // eight would block nothing, which is finding H27.
    const impede = impedimentEvery > 0 && i % impedimentEvery === 0 && drawnItem.type !== 'epic'
      && i + 9 <= spec.items
    if (impede) impedimentIndexes.push(drawn.length)
    drawn.push(impede ? asImpediment(drawnItem) : drawnItem)
  }

  const edges = Math.round((spec.items * spec.relationsPerHundredItems) / 100)
  const { byIndex, chain } = relationsFor(drawn, impedimentIndexes, edges, next)
  const items = drawn.map((item, index) => {
    const relations = byIndex.get(index)
    return relations === undefined ? item : { ...item, relations }
  })
  const byMonth = new Map<string, { writes: { item: WorkItem }[]; events: StoreEvent[] }>()
  for (const item of items) {
    const month = item.filed_at.slice(0, 7)
    const bucket = byMonth.get(month) ?? { writes: [], events: [] }
    bucket.writes.push({ item })
    bucket.events.push(...eventsFor(item, spec.eventsPerItem, next))
    byMonth.set(month, bucket)
  }

  const sorted = [...byMonth.keys()].sort()
  for (const month of sorted) {
    const bucket = byMonth.get(month)!
    const applied = await store.apply({
      txn: `txn-corpus-${month}`,
      writes: bucket.writes,
      events: bucket.events,
    })
    if (!applied.ok) throw new Error(`corpus ${month}: ${applied.error.code} ${applied.error.message}`)
  }

  const elapsed = performance.now() - started
  return { ms: elapsed, chain }
}

