// SPDX-License-Identifier: Apache-2.0
// Corpora written through the landed store, not synthesised as files. A generator that
// wrote the Markdown itself would measure a format rather than a product, and would drift
// from the store the first time the grammar changed.
//
// Deterministic from one seed: mulberry32 (the same PRNG the store fixtures use, imported
// rather than copied) plus zero-padded ids means two runs of the same spec produce
// byte-identical corpora, which is what makes two runs comparable.

import { mkdir, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { random } from '../test/helpers/store-fixtures.ts'
import {
  BUG_SEVERITIES,
  DEFAULT_POINT_SCALE,
  FOUND_IN_STAGES,
  isTerminal,
  type ItemId,
  type Sprint,
  type StoredRelation,
  type WorkItem,
  type WorkItemState,
  type WorkItemType,
} from '../src/domain/index.ts'
import { MAX_FIELD_VALUE_BYTES, ShardedStore, createWorkspace } from '../src/adapters/store/index.ts'
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
   * builds the graph on every invocation. One sprint record per month is not a knob, because
   * the item generator already points every item at `sprint-<0..23>` and a pointer with no
   * record behind it is doctor finding H26 fifty thousand times over.
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
  readonly sprintsWritten: number
  readonly openSprint: string
  /**
   * What a close would have recorded against what the store accepted. `carried` is one
   * field line and the ceiling is MAX_FIELD_VALUE_BYTES, so a sprint past about 810 open
   * items cannot record its own carry-over.
   */
  readonly carryOver: { readonly largestWanted: number; readonly largestStored: number; readonly sprintsTruncated: number }
  readonly impediments: number
  readonly relations: { readonly total: number; readonly blocks: number; readonly duplicates: number; readonly relates_to: number }
  /** The longest `blocks` chain the generator laid down, which is what the cycle check walks. */
  readonly longestBlocksChain: number
  readonly probeIds: { readonly get: string; readonly transition: string }
  readonly bytes: { readonly items: number; readonly events: number; readonly index: number }
  readonly generatedMs: number | undefined
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
  'index', 'shard', 'lock', 'render', 'parse', 'migrate', 'gate', 'sprint', 'burndown',
  'cadence', 'retro', 'standup', 'backlog', 'impediment', 'cursor', 'schema', 'event',
  'conflict', 'quarantine', 'freshness', 'overlay', 'transition', 'estimate', 'velocity',
]

function sentence(next: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i += 1) out.push(WORDS[Math.floor(next() * WORDS.length)] as string)
  return out.join(' ')
}

/** One item, fully determined by the index and the seed, with the fields its type requires. */
function itemAt(index: number, next: () => number, months: readonly string[], epics: readonly string[]): WorkItem {
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
    points: DEFAULT_POINT_SCALE[Math.floor(next() * DEFAULT_POINT_SCALE.length)],
    assignee: `person-${Math.floor(next() * 12)}`,
    sprint_id: `sprint-${Math.floor(next() * 24)}`,
    labels: [`area-${Math.floor(next() * 8)}`],
  }
  // Parents point at epics generated before this item, so the hierarchy is a forest and the
  // cycle check on every refresh has real edges to walk rather than none.
  if (type !== 'epic' && epics.length > 0 && next() < 0.6) {
    base['parent_id'] = epics[Math.floor(next() * epics.length)]
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
  if (type === 'spike') {
    base['question'] = sentence(next, 8)
    base['timebox_hours'] = 1 + Math.floor(next() * 40)
  }
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
    sprint_id: item.sprint_id,
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
 * One sprint per month, so every `sprint_id` the item generator wrote resolves to a record.
 * Exactly one is open, because `board` with no scope refuses two open sprints by design
 * (C1), and the default board is the path a caller takes.
 */
function sprintsFor(months: readonly string[], items: readonly WorkItem[]): readonly Sprint[] {
  const lastDay = (month: string): string => {
    const [year, m] = month.split('-').map(Number) as [number, number]
    return `${month}-${String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0')}`
  }
  const openIndex = months.length - 1
  const members = new Map<string, ItemId[]>()
  for (const item of items) {
    if (item.sprint_id === undefined || isTerminal(item.state)) continue
    const held = members.get(item.sprint_id)
    if (held === undefined) members.set(item.sprint_id, [item.id])
    else held.push(item.id)
  }
  return months.map((month, index): Sprint => {
    const id = `sprint-${index}`
    const closed = index !== openIndex
    // Two limits the store found here rather than the other way round. An empty list is an
    // absent field, so a sprint whose members all finished writes no `carried` line at all.
    // And `carried` is a single-line field, bounded at MAX_FIELD_VALUE_BYTES, so a sprint
    // past a few hundred open items cannot record its own carry-over. The corpus writes what
    // fits and the corpora table prints wanted against stored, so the ceiling is a measured
    // figure rather than one this comment asserts.
    const carried = fitting(members.get(id) ?? [])
    return {
      id,
      title: `Sprint over ${month}`,
      state: closed ? 'closed' : 'open',
      filed_at: `${month}-01T00:00:00Z`,
      version: 1,
      start: `${month}-01`,
      end: lastDay(month),
      goal: `land the work filed in ${month}`,
      // A close records the items still open as carried, and that list is the half of a
      // committed set the store holds rather than derives, so the corpus writes it.
      ...(closed ? { closed_at: `${lastDay(month)}T23:59:59Z`, ...(carried.length === 0 ? {} : { carried }) } : {}),
    }
  })
}

/**
 * As many ids as the store will accept on one field line. The length is taken off the joined
 * value with the separator the sprint codec writes, rather than estimated from the id length:
 * an estimate that assumed a one-byte separator put 8,996 bytes on a line with an 8,192 byte
 * ceiling and the store refused the whole corpus.
 */
function fitting(ids: readonly ItemId[]): readonly ItemId[] {
  const kept: ItemId[] = []
  for (const id of ids) {
    if (Buffer.byteLength([...kept, id].join(', '), 'utf8') > MAX_FIELD_VALUE_BYTES) break
    kept.push(id)
  }
  return kept
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
  const add = (index: number, relation: StoredRelation): void => {
    const held = byIndex.get(index)
    if (held === undefined) byIndex.set(index, [relation])
    else held.push(relation)
  }
  const idAt = (index: number): ItemId | undefined => items[index]?.id
  let written = 0

  for (const index of impediments) {
    const target = idAt(index + 1 + Math.floor(next() * 8))
    if (target === undefined) throw new Error(`impediment at index ${index} has nothing to block`)
    add(index, { kind: 'blocks', target })
    written += 1
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
        add(at + step, { kind: 'blocks', target })
        written += 1
      }
      at += chain + 1
      continue
    }
    if (roll < 0.7 && !duplicated.has(at)) {
      const target = idAt(at + 1 + Math.floor(next() * 32))
      if (target !== undefined) {
        add(at, { kind: 'duplicates', target })
        duplicated.add(at)
        written += 1
      }
      at += 3
      continue
    }
    // Symmetric, so the store holds it once on the lower id, which is the lower index here.
    const target = idAt(at + 1 + Math.floor(next() * 64))
    if (target !== undefined) {
      add(at, { kind: 'relates_to', target })
      written += 1
    }
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

function manifestOf(spec: CorpusSpec): string {
  return JSON.stringify(spec)
}

export async function buildCorpus(dir: string, spec: CorpusSpec, reuse: boolean): Promise<Corpus> {
  const root = path.join(dir, `ws-${spec.items}`)
  const manifestPath = path.join(root, '.bench-manifest.json')
  const wanted = manifestOf(spec)
  let reused = false
  if (reuse) {
    const found = await readFile(manifestPath, 'utf8').catch(() => undefined)
    reused = found === wanted
  }

  let generated: Generated | undefined
  if (!reused) {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    const created = await createWorkspace(root, {
      id: `bench-${spec.items}`,
      name: `Benchmark corpus, ${spec.items} items`,
      at: `${spec.lastMonth}-01T00:00:00Z`,
    })
    if (!created.ok) throw new Error(`corpus workspace: ${created.error.message}`)
    generated = await generate(root, spec)
    await writeFile(manifestPath, wanted)
  }

  const store = new ShardedStore(root)
  const all = await store.list({})
  if (!all.ok) throw new Error(`corpus readback: ${all.error.message}`)
  const ready = await store.list({ state: 'ready' })
  if (!ready.ok) throw new Error(`corpus readback: ${ready.error.message}`)
  const sprints = await store.sprints()
  if (!sprints.ok) throw new Error(`corpus readback: ${sprints.error.message}`)
  await store.close()

  const perMonth = new Map<string, number>()
  for (const item of all.value) {
    const month = item.filed_at.slice(0, 7)
    perMonth.set(month, (perMonth.get(month) ?? 0) + 1)
  }
  const months = [...perMonth.keys()].sort()
  const largestMonth = months.reduce((best, m) => ((perMonth.get(m) ?? 0) > (perMonth.get(best) ?? 0) ? m : best), months[0] as string)
  const largestBytes = (await stat(path.join(root, 'items', `${largestMonth}.md`)).catch(() => undefined))?.size ?? 0

  // Two probe ids from the largest shard: a read of the biggest file is the worst case a
  // read has, and the transition probe must be an item a create never collides with.
  const inLargest = all.value.filter((i) => i.filed_at.slice(0, 7) === largestMonth).map((i) => i.id).sort()

  return {
    spec,
    root,
    itemsInStore: all.value.length,
    eventsWritten: all.value.length * spec.eventsPerItem,
    months,
    largestMonth,
    largestMonthItems: perMonth.get(largestMonth) ?? 0,
    largestMonthBytes: largestBytes,
    readyMatches: ready.value.length,
    // Read back from the store rather than taken from the generator, for the reason every
    // other count here is: a reused corpus never ran the generator at all.
    sprintsWritten: sprints.value.length,
    carryOver: carryOverOf(all.value, sprints.value),
    openSprint: sprints.value.find((sprint) => sprint.state === 'open')?.id ?? 'NOT MEASURED: no open sprint',
    impediments: all.value.filter((item) => item.type === 'impediment').length,
    relations: relationTally(all.value),
    longestBlocksChain: generated?.chain ?? 8,
    probeIds: {
      get: inLargest[Math.floor(inLargest.length / 2)] as string,
      transition: inLargest[inLargest.length - 1] as string,
    },
    bytes: {
      items: await directoryBytes(path.join(root, 'items')),
      events: await directoryBytes(path.join(root, 'events')),
      index: await directoryBytes(path.join(root, '.index')),
    },
    generatedMs: generated?.ms,
    reused,
  }
}

/**
 * The carry-over each closed sprint would record against the length the store served back,
 * both read off the store so a reused corpus reports the same figures as a fresh one.
 */
function carryOverOf(items: readonly WorkItem[], sprints: readonly Sprint[]): Corpus['carryOver'] {
  const open = new Map<string, number>()
  for (const item of items) {
    if (item.sprint_id === undefined || isTerminal(item.state)) continue
    open.set(item.sprint_id, (open.get(item.sprint_id) ?? 0) + 1)
  }
  let largestWanted = 0
  let largestStored = 0
  let sprintsTruncated = 0
  for (const sprint of sprints) {
    if (sprint.state !== 'closed') continue
    const wanted = open.get(sprint.id) ?? 0
    const stored = sprint.carried?.length ?? 0
    largestWanted = Math.max(largestWanted, wanted)
    largestStored = Math.max(largestStored, stored)
    if (stored < wanted) sprintsTruncated += 1
  }
  return { largestWanted, largestStored, sprintsTruncated }
}

/** The edges the store actually holds, counted off the records rather than off the plan. */
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

export type Generated = {
  readonly ms: number
  readonly sprints: readonly Sprint[]
  readonly impediments: number
  readonly relations: { readonly total: number; readonly blocks: number; readonly duplicates: number; readonly relates_to: number }
  readonly chain: number
}

/**
 * One transaction per month shard, so a shard is written once rather than per record. The
 * items are built whole before any of them is written, because relations and carry-over are
 * both statements about the set and neither can be decided one record at a time.
 */
async function generate(root: string, spec: CorpusSpec): Promise<Generated> {
  const next = random(spec.seed)
  const months = monthRange(spec.lastMonth, spec.months)
  const store = new ShardedStore(root)
  const started = performance.now()

  const epics: string[] = []
  const drawn: WorkItem[] = []
  const impedimentEvery = spec.impedimentsPerHundredItems <= 0
    ? 0 : Math.max(1, Math.round(100 / spec.impedimentsPerHundredItems))
  const impedimentIndexes: number[] = []
  for (let i = 1; i <= spec.items; i += 1) {
    const drawnItem = itemAt(i, next, months, epics)
    if (drawnItem.type === 'epic' && epics.length < 64) epics.push(drawnItem.id)
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
  const tally = { total: 0, blocks: 0, duplicates: 0, relates_to: 0 }
  for (const list of byIndex.values()) {
    for (const relation of list) {
      tally.total += 1
      if (relation.kind === 'blocks') tally.blocks += 1
      else if (relation.kind === 'duplicates') tally.duplicates += 1
      else if (relation.kind === 'relates_to') tally.relates_to += 1
    }
  }

  const byMonth = new Map<string, { writes: { item: WorkItem }[]; events: StoreEvent[] }>()
  for (const item of items) {
    const month = item.filed_at.slice(0, 7)
    const bucket = byMonth.get(month) ?? { writes: [], events: [] }
    bucket.writes.push({ item })
    bucket.events.push(...eventsFor(item, spec.eventsPerItem, next))
    byMonth.set(month, bucket)
  }

  const sprints = sprintsFor(months, items)
  const sorted = [...byMonth.keys()].sort()
  for (const month of sorted) {
    const bucket = byMonth.get(month)!
    const applied = await store.apply({
      txn: `txn-corpus-${month}`,
      writes: bucket.writes,
      // The sprint file is one file, so every sprint record goes in with the first shard
      // rather than being rewritten once per month.
      ...(month === sorted[0] ? { sprints: sprints.map((sprint) => ({ sprint })) } : {}),
      events: bucket.events,
    })
    if (!applied.ok) throw new Error(`corpus ${month}: ${applied.error.code} ${applied.error.message}`)
  }

  const elapsed = performance.now() - started
  await store.close()
  return { ms: elapsed, sprints, impediments: impedimentIndexes.length, relations: tally, chain }
}

/** Deletes the derived index so the next open pays DR8's first-index-build budget. */
export async function dropIndex(root: string): Promise<void> {
  await rm(path.join(root, '.index'), { recursive: true, force: true })
}
