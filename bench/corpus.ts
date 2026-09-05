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

function eventsFor(item: WorkItem, count: number, next: () => number): readonly StoreEvent[] {
  const out: StoreEvent[] = []
  const month = item.filed_at.slice(0, 7)
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: `ev-${item.id}-${String(i).padStart(2, '0')}`,
      at: `${month}-${String(1 + Math.floor(next() * 28)).padStart(2, '0')}T${String(Math.floor(next() * 24)).padStart(2, '0')}:30:00Z`,
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

  let generatedMs: number | undefined
  if (!reused) {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    const created = await createWorkspace(root, {
      id: `bench-${spec.items}`,
      name: `Benchmark corpus, ${spec.items} items`,
      at: `${spec.lastMonth}-01T00:00:00Z`,
    })
    if (!created.ok) throw new Error(`corpus workspace: ${created.error.message}`)
    generatedMs = await generate(root, spec)
    await writeFile(manifestPath, wanted)
  }

  const store = new ShardedStore(root)
  const all = await store.list({})
  if (!all.ok) throw new Error(`corpus readback: ${all.error.message}`)
  const ready = await store.list({ state: 'ready' })
  if (!ready.ok) throw new Error(`corpus readback: ${ready.error.message}`)
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
    probeIds: {
      get: inLargest[Math.floor(inLargest.length / 2)] as string,
      transition: inLargest[inLargest.length - 1] as string,
    },
    bytes: {
      items: await directoryBytes(path.join(root, 'items')),
      events: await directoryBytes(path.join(root, 'events')),
      index: await directoryBytes(path.join(root, '.index')),
    },
    generatedMs,
    reused,
  }
}

/** One transaction per month shard, so a shard is written once rather than per record. */
async function generate(root: string, spec: CorpusSpec): Promise<number> {
  const next = random(spec.seed)
  const months = monthRange(spec.lastMonth, spec.months)
  const store = new ShardedStore(root)
  const started = performance.now()

  const epics: string[] = []
  const byMonth = new Map<string, { writes: { item: WorkItem }[]; events: StoreEvent[] }>()
  for (let i = 1; i <= spec.items; i += 1) {
    const item = itemAt(i, next, months, epics)
    if (item.type === 'epic' && epics.length < 64) epics.push(item.id)
    const month = item.filed_at.slice(0, 7)
    const bucket = byMonth.get(month) ?? { writes: [], events: [] }
    bucket.writes.push({ item })
    bucket.events.push(...eventsFor(item, spec.eventsPerItem, next))
    byMonth.set(month, bucket)
  }

  for (const month of [...byMonth.keys()].sort()) {
    const bucket = byMonth.get(month)!
    const applied = await store.apply({
      txn: `txn-corpus-${month}`,
      writes: bucket.writes,
      events: bucket.events,
    })
    if (!applied.ok) throw new Error(`corpus ${month}: ${applied.error.code} ${applied.error.message}`)
  }

  const elapsed = performance.now() - started
  await store.close()
  return elapsed
}

/** Deletes the derived index so the next open pays DR8's first-index-build budget. */
export async function dropIndex(root: string): Promise<void> {
  await rm(path.join(root, '.index'), { recursive: true, force: true })
}
