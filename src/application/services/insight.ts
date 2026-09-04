// SPDX-License-Identifier: Apache-2.0
// The three reads that answer a question rather than return a record: what to pick up next
// and why that order, why one item is where it is, and where the workspace stands.
//
// `next`'s ranking is deterministic for a given store state and weight set, and the weights
// are in its output rather than in its documentation (R11), so two callers on two harnesses
// compare two runs byte for byte.

import {
  TRANSITION_TABLE,
  legalTargetsFrom,
  type GuardId,
  type ItemId,
  type WorkItem,
} from '../../domain/index.ts'
import { columnsOf, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { Store } from '../ports/store.ts'
import {
  activeBlockers,
  blockedByThis,
  doneVerdict,
  readWorkspace,
  readyVerdict,
  type WorkspaceView,
} from './context.ts'
import { notFound } from './items.ts'
import { storeRefusal } from './refusal.ts'

export type Weights = {
  readonly pri: number
  readonly age: number
  readonly dep: number
  readonly spr: number
  readonly asg: number
}

/** Integer weights, so a score is an integer and two implementations cannot round apart. */
export const DEFAULT_WEIGHTS: Weights = { pri: 10, age: 1, dep: 5, spr: 8, asg: 8 }

const MAX_AGE_DAYS = 30
const DAY_MS = 86_400_000

export const NEXT_SHAPE: ResultShape = {
  command: 'next',
  version: 1,
  effect: 'read',
  summary: 'Rank what to pick up, and print the components and weights that produced the order.',
  properties: [
    { kind: 'scalar', key: 'weights', type: 'string' },
    {
      kind: 'block',
      key: 'next',
      columns: [{ name: 'id' }, { name: 'pts' }, { name: 'score' }, { name: 'parts' }, { name: 'title', text: true }],
    },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'absent', type: 'string' },
    { kind: 'scalar', key: 'clause', type: 'string' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'more', type: 'integer' },
    { kind: 'scalar', key: 'page', type: 'string' },
  ],
}

export const EXPLAIN_SHAPE: ResultShape = {
  command: 'explain',
  version: 1,
  effect: 'read',
  summary: 'Say why one item is where it is, and what each legal next move needs.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'type', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'scalar', key: 'since', type: 'string' },
    { kind: 'scalar', key: 'from_event', type: 'string' },
    { kind: 'scalar', key: 'blocked', type: 'string' },
    { kind: 'scalar', key: 'sprint', type: 'string' },
    { kind: 'scalar', key: 'parent', type: 'string' },
    {
      kind: 'block',
      key: 'gates',
      columns: [{ name: 'gate' }, { name: 'rule' }, { name: 'verdict' }, { name: 'need', text: true }],
    },
    {
      kind: 'block',
      key: 'moves',
      columns: [{ name: 'to' }, { name: 'guards' }],
    },
    { kind: 'scalar', key: 'blocks', type: 'string' },
  ],
}

export const STATUS_SHAPE: ResultShape = {
  command: 'status',
  version: 1,
  effect: 'read',
  summary: 'Orient a caller in the workspace in one call.',
  properties: [
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'items', type: 'integer' },
    { kind: 'scalar', key: 'points', type: 'integer' },
    { kind: 'block', key: 'states', columns: [{ name: 'state' }, { name: 'n' }] },
    { kind: 'scalar', key: 'findings', type: 'integer' },
    {
      kind: 'block',
      key: 'next',
      columns: [{ name: 'id' }, { name: 'pts' }, { name: 'score' }, { name: 'title', text: true }],
    },
    { kind: 'scalar', key: 'absent_features', type: 'string' },
  ],
}

export type Score = {
  readonly item: WorkItem
  readonly score: number
  readonly parts: string
}

export function ageDays(filed: string, now: string): number {
  const days = Math.floor((Date.parse(now) - Date.parse(filed)) / DAY_MS)
  return Math.max(0, Math.min(MAX_AGE_DAYS, Number.isFinite(days) ? days : 0))
}

export function scoreOf(
  view: WorkspaceView, item: WorkItem, now: string, weights: Weights, forActor: string | undefined,
): Score {
  const priority = item.priority === undefined ? 0 : 6 - item.priority
  const age = ageDays(item.filed_at, now)
  const dependents = blockedByThis(view, item.id).length
  const sprint = item.sprint_id === undefined ? 0 : 1
  const match = forActor !== undefined && item.assignee === forActor ? 1 : 0
  const score = priority * weights.pri + age * weights.age + dependents * weights.dep
    + sprint * weights.spr + match * (forActor === undefined ? 0 : weights.asg)
  return { item, score, parts: `p${priority}/a${age}/d${dependents}/s${sprint}/m${match}` }
}

export function rank(
  view: WorkspaceView, now: string, weights: Weights, forActor: string | undefined,
): readonly Score[] {
  return view.items
    .filter((item) => item.state === 'ready')
    .map((item) => scoreOf(view, item, now, weights, forActor))
    .sort((a, b) => (a.score === b.score ? (a.item.id < b.item.id ? -1 : 1) : b.score - a.score))
}

export type NextRequest = {
  readonly limit: number
  readonly cursor?: ItemId
  readonly forActor?: string
  readonly explainAbsence?: ItemId
}

export async function next(store: Store, clock: Clock, request: NextRequest): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('next', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  const weights = DEFAULT_WEIGHTS
  const ranked = rank(view.value, clock.now(), weights, request.forActor)
  const at = request.cursor === undefined ? 0 : ranked.findIndex((scored) => scored.item.id === request.cursor)
  const from = at < 0 ? 0 : at
  const page = ranked.slice(from, from + request.limit)

  const block: Block = {
    columns: columnsOf(NEXT_SHAPE, 'next'),
    shown: page.length,
    total: ranked.length,
    rows: page.map((scored): Row => ({
      id: scored.item.id,
      pts: scored.item.points ?? null,
      score: scored.score,
      parts: scored.parts,
      title: scored.item.title,
    })),
  }

  const asg = request.forActor === undefined ? 0 : weights.asg
  const data: Record<string, Value> = {
    weights: `pri ${weights.pri} age ${weights.age} dep ${weights.dep} spr ${weights.spr} asg ${asg}`,
    next: block,
  }
  if (ranked.length === 0) {
    data['none'] = `searched ${view.value.items.length} matched 0`
  }
  const remaining = ranked.length - (from + page.length)
  if (remaining > 0) {
    data['more'] = remaining
    const following = ranked[from + page.length]
    if (following !== undefined) data['page'] = `treadle next --cursor ${following.item.id}`
  }
  if (request.explainAbsence !== undefined) {
    const id = request.explainAbsence
    const item = view.value.byId.get(id)
    data['absent'] = id
    if (item === undefined) {
      data['store'] = view.value.identity.path ?? workspace
      data['clause'] = `unknown searched ${view.value.items.length}`
    } else if (item.state !== 'ready') {
      data['clause'] = `state want ready got ${item.state}`
    } else if (!page.some((scored) => scored.item.id === id)) {
      data['clause'] = `rank want ${from + 1}..${from + request.limit} got ${ranked.findIndex((s) => s.item.id === id) + 1}`
    } else {
      data['clause'] = 'none; it is in the list'
    }
  }
  return okResult(NEXT_SHAPE, { workspace, data })
}

async function enteredAt(
  store: Store, id: ItemId,
): Promise<{ readonly at: string; readonly event: string } | undefined> {
  const events = await store.events({ entity: id })
  if (!events.ok) return undefined
  for (let i = events.value.length - 1; i >= 0; i -= 1) {
    const event = events.value[i]
    if (event !== undefined && (event.op === 'item.transition' || event.op === 'item.file')) {
      return { at: event.at, event: event.id }
    }
  }
  return undefined
}

export async function explain(store: Store, id: ItemId): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('explain', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  const item = view.value.byId.get(id)
  if (item === undefined) return notFound('explain', workspace, view.value, id)

  const blockers = activeBlockers(view.value, id)
  const ready = readyVerdict(view.value, item)
  const done = doneVerdict(view.value, item)
  const failing = [
    ...ready.rules.filter((rule) => !rule.pass).map((rule) => ({ gate: 'ready', rule })),
    ...done.rules.filter((rule) => !rule.pass).map((rule) => ({ gate: 'done', rule })),
  ]

  const gates: Block = {
    columns: columnsOf(EXPLAIN_SHAPE, 'gates'),
    shown: failing.length,
    total: ready.rules.length + done.rules.length,
    rows: failing.map((entry): Row => ({
      gate: entry.gate,
      rule: entry.rule.rule,
      verdict: 'fail',
      need: entry.rule.remedy ?? entry.rule.sentence,
    })),
  }

  const targets = legalTargetsFrom(item)
  const moves: Block = {
    columns: columnsOf(EXPLAIN_SHAPE, 'moves'),
    shown: targets.length,
    total: targets.length,
    rows: targets.map((to): Row => ({ to, guards: guardsOnEdge(item, to).join(',') || '-' })),
  }

  const at = await enteredAt(store, id)
  const data: Record<string, Value> = {
    item: item.id,
    type: item.type,
    state: item.state,
  }
  if (at !== undefined) { data['since'] = at.at; data['from_event'] = at.event }
  data['blocked'] = blockers.length === 0 ? 'no' : `yes ${blockers.join(',')}`
  if (item.sprint_id !== undefined) data['sprint'] = item.sprint_id
  if (item.parent_id !== undefined) data['parent'] = item.parent_id
  data['gates'] = gates
  data['moves'] = moves
  const blocking = blockedByThis(view.value, id)
  data['blocks'] = blocking.length === 0 ? '-' : blocking.join(',')
  return okResult(EXPLAIN_SHAPE, { workspace, data })
}

/** Guards the transition table names on an edge, without evaluating any of them. */
function guardsOnEdge(item: WorkItem, to: string): readonly GuardId[] {
  const spec = TRANSITION_TABLE.find((edge) => edge.from === item.state && edge.to === to)
  if (spec === undefined) return []
  return item.type === 'epic' && to === 'done' ? [...spec.guards, 'G8'] : spec.guards
}

export async function status(store: Store, clock: Clock): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('status', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  const findings = await store.findings()

  const counts = new Map<string, number>()
  for (const item of view.value.items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1)
  const states = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))

  const ranked = rank(view.value, clock.now(), DEFAULT_WEIGHTS, undefined).slice(0, 3)
  return okResult(STATUS_SHAPE, {
    workspace,
    data: {
      store: view.value.identity.path ?? workspace,
      items: view.value.items.length,
      points: view.value.items.reduce((sum, item) => sum + (item.points ?? 0), 0),
      states: {
        columns: columnsOf(STATUS_SHAPE, 'states'),
        shown: states.length,
        total: states.length,
        rows: states.map(([state, n]): Row => ({ state, n })),
      },
      findings: findings.ok ? findings.value.length : 0,
      next: {
        columns: columnsOf(STATUS_SHAPE, 'next'),
        shown: ranked.length,
        total: ranked.length,
        rows: ranked.map((scored): Row => ({
          id: scored.item.id,
          pts: scored.item.points ?? null,
          score: scored.score,
          title: scored.item.title,
        })),
      },
      absent_features: 'sprint board impediment relation',
    },
  })
}
