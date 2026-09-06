// SPDX-License-Identifier: Apache-2.0
// The three reads that answer a question rather than return a record: what to pick up next
// and why that order, why one item is where it is, and where the workspace stands.
//
// `next`'s ranking is deterministic for a given store state and weight set, and the weights
// are in its output rather than in its documentation (R11), so two callers on two harnesses
// compare two runs byte for byte.

import {
  BUG_SEVERITIES,
  TRANSITION_TABLE,
  dayOfSprint,
  daysOverdue,
  healthFindings,
  isOverdue,
  isTerminal,
  legalTargetsFrom,
  type BugSeverity,
  type GuardId,
  type ItemId,
  type WorkItem,
  type WorkItemSummary,
} from '../../domain/index.ts'
import { columnsOf, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { Store, StoreEvent } from '../ports/store.ts'
import {
  activeBlockers,
  blockedByThis,
  doneVerdict,
  readWorkspace,
  wholeItem,
  readyVerdict,
  type WorkspaceView,
} from './context.ts'
import { auditImpediment, auditItem, auditRelationsOf } from './doctor.ts'
import { notFound } from './items.ts'
import { committedTo } from './sprints.ts'
import { storeRefusal, unknownCursor } from './refusal.ts'

export type Weights = {
  readonly pri: number
  readonly age: number
  readonly dep: number
  readonly spr: number
  readonly asg: number
  readonly due: number
  readonly sev: number
}

/**
 * Integer weights, so a score is an integer and two implementations cannot round apart.
 * `due` is four so a day past the date outranks four days of age and never a priority step:
 * a date the workspace agreed is evidence, and priority is still the thing a person set.
 * `sev` is six for the same reason read the other way: an S1 scores 4 and a priority level
 * is 10, so severity lifts a defect by at most 2.4 levels and priority stays the lever a
 * person sets. The two components answer different questions and both are printed.
 */
export const DEFAULT_WEIGHTS: Weights = { pri: 10, age: 1, dep: 5, spr: 8, asg: 8, due: 4, sev: 6 }

const SEVERITY_RANK: Readonly<Record<BugSeverity, number>> = { S1: 4, S2: 3, S3: 2, S4: 1 }

/** 4 for an S1 down to 1 for an S4, and 0 for anything with no severity. */
export function severityRank(item: WorkItemSummary): number {
  return item.severity === undefined ? 0 : SEVERITY_RANK[item.severity]
}

const MAX_AGE_DAYS = 30
const DAY_MS = 86_400_000

export const NEXT_SHAPE: ResultShape = {
  command: 'next',
  version: 1,
  effect: 'read',
  summary: 'Rank what to pick up, and print the components and weights that produced the order.',
  properties: [
    { kind: 'scalar', key: 'weights', type: 'string' },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'absent', type: 'string' },
    { kind: 'scalar', key: 'clause', type: 'string' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'more', type: 'integer' },
    { kind: 'scalar', key: 'page', type: 'string' },
    {
      kind: 'block',
      key: 'next',
      columns: [{ name: 'id' }, { name: 'pts' }, { name: 'score' }, { name: 'parts' }, { name: 'title', text: true }],
    },
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
    { kind: 'text', key: 'reason' },
    { kind: 'scalar', key: 'blocked', type: 'string' },
    { kind: 'scalar', key: 'sprint', type: 'string' },
    { kind: 'scalar', key: 'parent', type: 'string' },
    { kind: 'scalar', key: 'blocks', type: 'string' },
    { kind: 'scalar', key: 'sev', type: 'string' },
    { kind: 'text', key: 'by' },
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
    {
      kind: 'block',
      key: 'findings',
      columns: [{ name: 'rule' }, { name: 'detail', text: true }],
    },
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
    { kind: 'scalar', key: 'findings', type: 'integer' },
    { kind: 'scalar', key: 'overdue', type: 'integer' },
    { kind: 'scalar', key: 'absent_features', type: 'string' },
    { kind: 'scalar', key: 'defects', type: 'string' },
    { kind: 'block', key: 'states', columns: [{ name: 'state' }, { name: 'n' }] },
    { kind: 'block', key: 'health', columns: [{ name: 'rule' }, { name: 'item' }, { name: 'saw' }] },
    {
      kind: 'block',
      key: 'next',
      columns: [{ name: 'id' }, { name: 'pts' }, { name: 'score' }, { name: 'title', text: true }],
    },
    // Appended last, which STABILITY's output-schema rule makes a non-breaking addition, and
    // absent when no sprint is open, so a workspace that runs none pays nothing for it.
    {
      kind: 'block',
      key: 'sprints',
      columns: [{ name: 'id' }, { name: 'day' }, { name: 'items' }, { name: 'pts' }, { name: 'title', text: true }],
    },
  ],
}

export type Score = {
  readonly item: WorkItemSummary
  readonly score: number
  readonly parts: string
}

export function ageDays(filed: string, now: string): number {
  const days = Math.floor((Date.parse(now) - Date.parse(filed)) / DAY_MS)
  return Math.max(0, Math.min(MAX_AGE_DAYS, Number.isFinite(days) ? days : 0))
}

export function scoreOf(
  view: WorkspaceView, item: WorkItemSummary, now: string, weights: Weights, forActor: string | undefined,
): Score {
  const priority = item.priority === undefined ? 0 : 6 - item.priority
  const age = ageDays(item.filed_at, now)
  // `d` is the number of active items this one directly blocks: finishing it frees that
  // many. A blocker's own severity is `v` on its own row, and the depth below it is not
  // counted because a chain is freed one link at a time.
  const dependents = blockedByThis(view, item.id).length
  // Membership of an open sprint, and only an open one: work left behind in a closed sprint
  // gets no lift until it is committed onward, which is what carry-over asks a team to do.
  const sprint = item.sprint_id !== undefined && view.sprintById.get(item.sprint_id)?.state === 'open' ? 1 : 0
  const match = forActor !== undefined && item.assignee === forActor ? 1 : 0
  const overdue = daysOverdue(item, now)
  const severity = severityRank(item)
  const score = priority * weights.pri + age * weights.age + dependents * weights.dep
    + sprint * weights.spr + match * (forActor === undefined ? 0 : weights.asg)
    + overdue * weights.due + severity * weights.sev
  return {
    item,
    score,
    parts: `p${priority}/a${age}/d${dependents}/s${sprint}/m${match}/u${overdue}/v${severity}`,
  }
}

/**
 * What to pick up is what can be started. A ready item with an active blocker is refused
 * by G2 at `start`, so ranking it first sends the caller into a refusal; it is left out and
 * `--explain-absence` names the blockers.
 */
export function rank(
  view: WorkspaceView, now: string, weights: Weights, forActor: string | undefined,
): readonly Score[] {
  return view.items
    .filter((item) => item.state === 'ready' && activeBlockers(view, item.id).length === 0)
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
  const from = request.cursor === undefined ? 0 : ranked.findIndex((scored) => scored.item.id === request.cursor)
  if (from < 0) return unknownCursor('next', workspace, request.cursor as string, request.cursor as string, 'treadle next')
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
    weights: `pri ${weights.pri} age ${weights.age} dep ${weights.dep} spr ${weights.spr} asg ${asg} due ${weights.due} sev ${weights.sev}`,
  }
  if (ranked.length === 0) {
    data['none'] = `searched ${view.value.items.length} matched 0`
  }
  if (request.explainAbsence !== undefined) {
    const id = request.explainAbsence
    const item = view.value.byId.get(id)
    data['absent'] = id
    if (item === undefined) {
      data['clause'] = `unknown searched ${view.value.items.length}`
      data['store'] = view.value.identity.path ?? workspace
    } else if (item.state !== 'ready') {
      data['clause'] = `state want ready got ${item.state}`
    } else if (activeBlockers(view.value, id).length > 0) {
      data['clause'] = `blocked by ${activeBlockers(view.value, id).join(',')}`
    } else if (!page.some((scored) => scored.item.id === id)) {
      data['clause'] = `rank want ${from + 1}..${from + request.limit} got ${ranked.findIndex((s) => s.item.id === id) + 1}`
    } else {
      data['clause'] = 'none; it is in the list'
    }
  }
  const remaining = ranked.length - (from + page.length)
  if (remaining > 0) {
    data['more'] = remaining
    const following = ranked[from + page.length]
    if (following !== undefined) data['page'] = `treadle next --cursor ${following.item.id}`
  }
  data['next'] = block
  return okResult(NEXT_SHAPE, { workspace, data })
}

type Entry = {
  readonly at: string
  readonly event: string
  readonly by: string
  readonly reason?: string
}

/**
 * The write that put the item in the state it is in: when, which event, who, and the reason
 * T4 made it record. The actor is the answer to "who changed this" for the change a reader
 * of `explain` is already asking about; `history` is the same fact for every other change.
 */
function enteredAt(events: readonly StoreEvent[], state: string): Entry | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined || (event.op !== 'item.transition' && event.op !== 'item.file')) continue
    // The log is a committed file. An event whose `after.state` is not the state the record
    // holds did not put the item where it is, however recent it claims to be; a log written
    // before the file event carried its fields has no `after.state`, and is trusted as before.
    const after = event.after as { state?: unknown } | undefined
    const said = after?.state
    if (said === undefined || said === state) {
      return typeof event.reason === 'string'
        ? { at: event.at, event: event.id, by: event.actor, reason: event.reason }
        : { at: event.at, event: event.id, by: event.actor }
    }
  }
  return undefined
}

export async function explain(store: Store, id: ItemId): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('explain', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  const whole = await wholeItem(store, view.value, id)
  if (!whole.ok) return storeRefusal('explain', 'read', whole.error, workspace)
  const item = whole.value
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

  // One read of this item's log serves both the entry below and the audit further down; it
  // used to be read twice for the two.
  const events = await store.events({ entity: id })
  const log = events.ok ? events.value : []
  const at = enteredAt(log, item.state)
  const data: Record<string, Value> = {
    item: item.id,
    type: item.type,
    state: item.state,
  }
  if (at !== undefined) {
    data['since'] = at.at
    data['from_event'] = at.event
    if (at.reason !== undefined) data['reason'] = at.reason
  }
  data['blocked'] = blockers.length === 0 ? 'no' : `yes ${blockers.join(',')}`
  if (item.sprint_id !== undefined) data['sprint'] = item.sprint_id
  if (item.parent_id !== undefined) data['parent'] = item.parent_id
  const blocking = blockedByThis(view.value, id)
  data['blocks'] = blocking.length === 0 ? '-' : blocking.join(',')
  if (item.severity !== undefined) data['sev'] = item.severity
  if (at !== undefined) data['by'] = at.by
  data['gates'] = gates
  data['moves'] = moves

  // The audit over the list already read is free here, and is the per-item half of `doctor`.
  const audit = [
    ...auditItem(item, log, new Set(view.value.sprintById.keys())),
    ...auditRelationsOf(new Set(view.value.byId.keys()), item),
    ...auditImpediment(item),
  ]
  if (audit.length > 0) {
    data['findings'] = {
      columns: columnsOf(EXPLAIN_SHAPE, 'findings'),
      shown: audit.length,
      total: audit.length,
      rows: audit.map((finding): Row => ({ rule: finding.rule, detail: finding.detail })),
    }
  }
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

  // Severity reached no read surface at all, and the orientation call is the one a triaging
  // caller makes first. Open bugs only: a closed defect's severity is history, not a queue.
  const open = view.value.items.filter((item) => item.type === 'bug' && !isTerminal(item.state))
  const census = BUG_SEVERITIES
    .map((severity) => [severity, open.filter((item) => item.severity === severity).length] as const)
    .filter(([, count]) => count > 0)
  const defects = census.length === 0 ? undefined : census.map(([s, n]) => `${s} ${n}`).join(' ')

  const now = clock.now()
  const ranked = rank(view.value, now, DEFAULT_WEIGHTS, undefined).slice(0, 3)
  const overdue = view.value.items.filter((item) => isOverdue(item, now))
  const health = healthFindings(view.value.items, now)
  const sprintRows = view.value.sprints.filter((sprint) => sprint.state === 'open').map((sprint): Row => {
    const committed = committedTo(view.value, sprint)
    const done = committed.filter((item) => item.state === 'done')
    const at = dayOfSprint(sprint, now)
    return {
      id: sprint.id,
      day: `${at.day}/${at.days}`,
      items: `${done.length}/${committed.length}`,
      pts: `${done.reduce((sum, item) => sum + (item.points ?? 0), 0)}/${committed.reduce((sum, item) => sum + (item.points ?? 0), 0)}`,
      title: sprint.title,
    }
  })
  return okResult(STATUS_SHAPE, {
    workspace,
    data: {
      store: view.value.identity.path ?? workspace,
      items: view.value.items.length,
      points: view.value.items.reduce((sum, item) => sum + (item.points ?? 0), 0),
      findings: findings.ok ? findings.value.length : 0,
      // Both lines are absent when there is nothing to say, which is what keeps the
      // orientation call the same 440 bytes it was for a workspace that misses no dates.
      ...(overdue.length === 0 ? {} : { overdue: overdue.length }),
      absent_features: 'board',
      ...(defects === undefined ? {} : { defects }),
      states: {
        columns: columnsOf(STATUS_SHAPE, 'states'),
        shown: states.length,
        total: states.length,
        rows: states.map(([state, n]): Row => ({ state, n })),
      },
      ...(health.length === 0 ? {} : {
        health: {
          columns: columnsOf(STATUS_SHAPE, 'health'),
          shown: health.length,
          total: health.length,
          rows: health.map((finding): Row => ({ rule: finding.rule, item: finding.id, saw: finding.observed })),
        },
      }),
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
      ...(sprintRows.length === 0 ? {} : {
        sprints: {
          columns: columnsOf(STATUS_SHAPE, 'sprints'),
          shown: sprintRows.length,
          total: sprintRows.length,
          rows: sprintRows,
        },
      }),
    },
  })
}
