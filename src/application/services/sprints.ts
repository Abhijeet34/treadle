// SPDX-License-Identifier: Apache-2.0
// The sprint use cases: open one, commit items to it, take one out, close it with the
// carry-over recorded, reopen one closed by mistake, and read them back.
//
// The committed set is never written. An item carries `sprint_id`, so what is committed to
// a sprint is what points at it; `commit` and `uncommit` write items and never the sprint,
// and `open`, `close` and `reopen` write the sprint and never an item. The one thing a close
// writes that nothing else could recover is the carry-over, because the items it names move
// on to the next sprint and stop pointing back. ADR-0016 carries the argument.

import {
  carryOver,
  dayOfSprint,
  dateOf,
  evaluateCommit,
  validateSprint,
  type ItemId,
  type Sprint,
  type WorkItem,
  type WorkItemSummary,
} from '../../domain/index.ts'
import { columnsOf, errorResult, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import type { Store, StoreEvent } from '../ports/store.ts'
import { readWorkspace, readyVerdict, wholeItem, type WorkspaceView } from './context.ts'
import { echoed, nearIds, notFound, slugFor } from './items.ts'
import { makeEvent, type Actor, type Target } from './mutation.ts'
import { storeRefusal } from './refusal.ts'

export const SPRINT_SHAPE: ResultShape = {
  command: 'sprint',
  version: 1,
  effect: 'mutate',
  summary: 'Open a sprint, commit items to it, and close it with what carried over recorded.',
  properties: [
    { kind: 'scalar', key: 'sprint', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'string' },
    { kind: 'list', key: 'set' },
    { kind: 'list', key: 'committed' },
    { kind: 'scalar', key: 'carried', type: 'string' },
    { kind: 'scalar', key: 'already', type: 'string' },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'events', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
  ],
}

export const SPRINTS_SHAPE: ResultShape = {
  command: 'sprints',
  version: 1,
  effect: 'read',
  summary: 'List the sprints, or print one with its dates, its committed set and what carried over.',
  properties: [
    { kind: 'scalar', key: 'sprint', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'scalar', key: 'start', type: 'string' },
    { kind: 'scalar', key: 'end', type: 'string' },
    { kind: 'scalar', key: 'filed', type: 'string' },
    { kind: 'scalar', key: 'closed', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'integer' },
    { kind: 'scalar', key: 'day', type: 'string' },
    { kind: 'scalar', key: 'committed', type: 'integer' },
    { kind: 'scalar', key: 'done', type: 'integer' },
    { kind: 'scalar', key: 'cancelled', type: 'integer' },
    { kind: 'scalar', key: 'pts', type: 'string' },
    { kind: 'scalar', key: 'carried', type: 'string' },
    { kind: 'scalar', key: 'extra', type: 'integer' },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'text', key: 'title', whole: true },
    { kind: 'text', key: 'goal', whole: true },
    {
      kind: 'block',
      key: 'sprints',
      columns: [{ name: 'id' }, { name: 'state' }, { name: 'start' }, { name: 'end' }, { name: 'items' }, { name: 'pts' }, { name: 'title', text: true }],
    },
  ],
}

function refusal(workspace: string, rule: string, entity: string, cause: string, fix: readonly string[]): ResultObject {
  return errorResult({ code: 'VALIDATION', command: 'sprint', workspace, effect: 'mutate', rule, entity, cause, fix })
}

/** The one refusal for a sprint id nothing here carries, with the nearest sprint ids beside it. */
function noSprint(command: string, workspace: string, view: WorkspaceView, id: string): ResultObject {
  const held = view.sprints.length
  return errorResult({
    code: 'NOT_FOUND', command, workspace, effect: command === 'sprints' ? 'read' : 'mutate', rule: 'I5', entity: id,
    cause: `${id} is no sprint here; this workspace holds ${held} ${held === 1 ? 'sprint' : 'sprints'}`,
    near: nearIds(view.sprintById.keys(), id),
    fix: ['treadle sprints'],
  })
}

/** The items committed to one sprint: what points at it, plus what its close carried away. */
export function committedTo(view: WorkspaceView, sprint: Sprint): readonly WorkItemSummary[] {
  const pointing = view.items.filter((item) => item.sprint_id === sprint.id)
  const seen = new Set(pointing.map((item) => item.id))
  const carried = (sprint.carried ?? []).flatMap((id) => {
    const item = view.byId.get(id)
    return item === undefined || seen.has(id) ? [] : [item]
  })
  return [...pointing, ...carried]
}

type Tally = {
  readonly committed: number
  readonly done: number
  readonly cancelled: number
  readonly points: number
  readonly donePoints: number
}

function tallyOf(items: readonly WorkItemSummary[]): Tally {
  const done = items.filter((item) => item.state === 'done')
  return {
    committed: items.length,
    done: done.length,
    cancelled: items.filter((item) => item.state === 'cancelled').length,
    points: items.reduce((sum, item) => sum + (item.points ?? 0), 0),
    donePoints: done.reduce((sum, item) => sum + (item.points ?? 0), 0),
  }
}

function previewOf(shape: ResultShape, workspace: string, view: WorkspaceView, data: Record<string, Value>): ResultObject {
  return okResult(shape, {
    workspace, txn: null, changed: 0,
    data: { ...data, preview: 1, store: view.identity.path ?? workspace, note: 'nothing evaluated; use --dry-run for the outcome' },
  })
}

export type OpenRequest = {
  readonly title: string
  readonly id?: string
  /** Defaults to the UTC date of the clock's instant. */
  readonly start?: string
  readonly end: string
  readonly goal?: string
  readonly actor: Actor
}

export async function openSprint(
  target: Target, clock: Clock, ids: IdGenerator, request: OpenRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('sprint', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const now = clock.now()

  // Deduplicated against items as well as sprints: the two are different entities in
  // different files, and a reader of `backlog --sprint s31` should not have to wonder which.
  const taken = new Set([...view.value.byId.keys(), ...view.value.sprintById.keys()])
  const id = request.id ?? slugFor(request.title, 'sprint', taken)
  if (view.value.sprintById.has(id)) {
    return refusal(workspace, 'I5', id, `${id} is already a sprint here`, [`treadle sprints ${id}`, 'treadle sprint open "<title>" --id <slug>'])
  }
  const sprint: Sprint = {
    id, title: request.title, state: 'open', filed_at: now, version: 1,
    start: request.start ?? dateOf(now), end: request.end,
    ...(request.goal === undefined ? {} : { goal: request.goal }),
  }
  const valid = validateSprint(sprint)
  if (!valid.ok) {
    return refusal(workspace, valid.error.rule ?? 'V4', id, valid.error.message, ['treadle help sprint'])
  }

  const set = [`start - -> ${sprint.start}`, `end - -> ${sprint.end}`]
  if (sprint.goal !== undefined) set.push(`goal - -> ${echoed(sprint.goal)}`)
  const data: Record<string, Value> = { sprint: id, state: 'open', v: '1', set }
  if (mode === 'preview') return previewOf(SPRINT_SHAPE, workspace, view.value, { sprint: id, state: 'open' })

  const txn = ids.txn()
  const eventId = ids.event()
  const applied = await store.apply({
    txn, writes: [], sprints: [{ sprint }],
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: id, entityKind: 'sprint', op: 'sprint.open',
      after: { state: 'open', start: sprint.start, end: sprint.end }, txn, command: 'sprint',
    })],
  })
  if (!applied.ok) return storeRefusal('sprint', 'mutate', applied.error, workspace)
  if (mode === 'dry-run') return okResult(SPRINT_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, dry_run: 1, would_exit: 0 } })
  return okResult(SPRINT_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}

export type CommitRequest = {
  readonly sprint: string
  readonly items: readonly ItemId[]
  readonly actor: Actor
}

type ItemMove = { readonly item: WorkItem; readonly before: string | undefined }

async function itemsNamed(
  store: Store, view: WorkspaceView, ids: readonly ItemId[],
): Promise<readonly WorkItem[] | ResultObject> {
  const items: WorkItem[] = []
  for (const id of ids) {
    const whole = await wholeItem(store, view, id)
    if (!whole.ok) return storeRefusal('sprint', 'mutate', whole.error, view.identity.id)
    if (whole.value === undefined) return notFound('sprint', view.identity.id, view, id)
    items.push(whole.value)
  }
  return items
}

/**
 * One transaction over every item that moves, so a commit of three items lands whole or
 * not at all; the `committed` list reports each move as `<item> <from> -> <to>`.
 */
async function applyMoves(
  target: Target, clock: Clock, ids: IdGenerator, view: WorkspaceView, actor: Actor,
  moves: readonly ItemMove[], to: string | undefined, op: 'item.commit' | 'item.uncommit',
  data: Record<string, Value>,
): Promise<ResultObject> {
  const workspace = view.identity.id
  const now = clock.now()
  const txn = ids.txn()
  const events: StoreEvent[] = []
  const writes = moves.map((move) => {
    const draft: Record<string, unknown> = { ...move.item }
    if (to === undefined) delete draft['sprint_id']
    else draft['sprint_id'] = to
    events.push(makeEvent({
      id: ids.event(), at: now, actor, entity: move.item.id, op, txn, command: 'sprint',
      before: { sprint_id: move.before ?? '-' }, after: { sprint_id: to ?? '-' },
    }))
    return { item: draft as unknown as WorkItem, ifVersion: move.item.version }
  })
  const applied = await target.store.apply({ txn, writes, events })
  if (!applied.ok) return storeRefusal('sprint', 'mutate', applied.error, workspace)
  const summary = { ...data, events: `${events.length} ${op}` }
  if (target.mode === 'dry-run') return okResult(SPRINT_SHAPE, { workspace, txn: null, changed: 0, data: { ...summary, dry_run: 1, would_exit: 0 } })
  return okResult(SPRINT_SHAPE, { workspace, txn, changed: writes.length, data: summary })
}

export async function commitItems(
  target: Target, clock: Clock, ids: IdGenerator, request: CommitRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('sprint', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const sprint = view.value.sprintById.get(request.sprint)
  if (sprint === undefined) return noSprint('sprint', workspace, view.value, request.sprint)
  if (request.items.length === 0) {
    return refusal(workspace, 'C1', sprint.id, 'sprint commit names the sprint and then one or more item ids, and no item was given', [`treadle sprint commit ${sprint.id} <id>`])
  }
  const items = await itemsNamed(store, view.value, request.items)
  if (!Array.isArray(items)) return items as ResultObject

  const moves: ItemMove[] = []
  const already: string[] = []
  for (const item of items) {
    const outcome = evaluateCommit({
      sprint, item,
      current: item.sprint_id === undefined ? undefined : view.value.sprintById.get(item.sprint_id),
      readyGate: readyVerdict(view.value, item),
    })
    if (outcome.outcome === 'already') { already.push(item.id); continue }
    if (outcome.outcome === 'refused') {
      return errorResult({
        code: 'GUARD_REFUSED', command: 'sprint', workspace, effect: 'mutate',
        rule: outcome.error.rule ?? 'I4', entity: item.id, cause: outcome.error.message, fix: outcome.fix,
      })
    }
    moves.push({ item, before: item.sprint_id })
  }

  const data: Record<string, Value> = { sprint: sprint.id, state: sprint.state }
  if (moves.length === 0) {
    return okResult(SPRINT_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, already: already.join(',') } })
  }
  data['committed'] = moves.map((move) => `${move.item.id} ${move.before ?? '-'} -> ${sprint.id}`)
  if (already.length > 0) data['already'] = already.join(',')
  if (mode === 'preview') return previewOf(SPRINT_SHAPE, workspace, view.value, { sprint: sprint.id, state: sprint.state })
  return applyMoves(target, clock, ids, view.value, request.actor, moves, sprint.id, 'item.commit', data)
}

export type UncommitRequest = {
  readonly items: readonly ItemId[]
  readonly actor: Actor
}

export async function uncommitItems(
  target: Target, clock: Clock, ids: IdGenerator, request: UncommitRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('sprint', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  if (request.items.length === 0) {
    return refusal(workspace, 'C1', 'sprint', 'sprint uncommit names one or more item ids, and none was given', ['treadle sprint uncommit <id>'])
  }
  const items = await itemsNamed(store, view.value, request.items)
  if (!Array.isArray(items)) return items as ResultObject

  const moves: ItemMove[] = []
  const already: string[] = []
  for (const item of items) {
    if (item.sprint_id === undefined) { already.push(item.id); continue }
    const current = view.value.sprintById.get(item.sprint_id)
    // A closed sprint's committed set is a record. The way out of one is into the next
    // sprint, which `commit` allows, and never into nowhere.
    if (current !== undefined && current.state === 'closed') {
      return errorResult({
        code: 'GUARD_REFUSED', command: 'sprint', workspace, effect: 'mutate', rule: 'I2', entity: item.id,
        cause: `${item.id} is in ${current.id}, which is closed, and a closed sprint's committed set is a record; commit it to an open sprint instead`,
        fix: ['treadle sprints', `treadle sprint reopen ${current.id}`],
      })
    }
    moves.push({ item, before: item.sprint_id })
  }
  const data: Record<string, Value> = {}
  if (moves.length === 0) {
    return okResult(SPRINT_SHAPE, { workspace, txn: null, changed: 0, data: { already: already.join(',') } })
  }
  data['committed'] = moves.map((move) => `${move.item.id} ${move.before ?? '-'} -> -`)
  if (already.length > 0) data['already'] = already.join(',')
  if (mode === 'preview') return previewOf(SPRINT_SHAPE, workspace, view.value, {})
  return applyMoves(target, clock, ids, view.value, request.actor, moves, undefined, 'item.uncommit', data)
}

export type SprintRequest = {
  readonly sprint: string
  readonly actor: Actor
}

/** `close` and `reopen` share everything but the direction, so one function moves a sprint's state. */
async function moveSprint(
  target: Target, clock: Clock, ids: IdGenerator, request: SprintRequest, to: 'open' | 'closed',
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('sprint', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const sprint = view.value.sprintById.get(request.sprint)
  if (sprint === undefined) return noSprint('sprint', workspace, view.value, request.sprint)
  if (sprint.state === to) {
    return okResult(SPRINT_SHAPE, { workspace, txn: null, changed: 0, data: { already: sprint.id, state: sprint.state, v: String(sprint.version) } })
  }
  const now = clock.now()
  const carried = to === 'closed' ? carryOver(committedTo(view.value, sprint)) : []
  const { closed_at: _closedAt, carried: wasCarried, ...rest } = sprint
  const after: Sprint = to === 'closed'
    ? { ...rest, state: 'closed', closed_at: now, ...(carried.length === 0 ? {} : { carried }) }
    : { ...rest, state: 'open' }

  const set = [`state ${sprint.state} -> ${to}`]
  if (to === 'closed') set.push(`closed_at - -> ${now}`)
  else if (sprint.closed_at !== undefined) set.push(`closed_at ${sprint.closed_at} -> -`)
  const carriedLine = (list: readonly string[] | undefined): string => (list === undefined || list.length === 0 ? '-' : list.join(','))
  if (to === 'closed' || wasCarried !== undefined) set.push(`carried ${carriedLine(wasCarried)} -> ${carriedLine(after.carried)}`)

  const data: Record<string, Value> = { sprint: sprint.id, state: `${sprint.state} -> ${to}`, v: `${sprint.version} -> ${sprint.version + 1}`, set }
  if (to === 'closed') data['carried'] = carriedLine(carried)
  if (mode === 'preview') return previewOf(SPRINT_SHAPE, workspace, view.value, { sprint: sprint.id, state: sprint.state })

  const txn = ids.txn()
  const eventId = ids.event()
  const applied = await store.apply({
    txn, writes: [], sprints: [{ sprint: after, ifVersion: sprint.version }],
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: sprint.id, entityKind: 'sprint',
      op: to === 'closed' ? 'sprint.close' : 'sprint.reopen',
      before: { state: sprint.state, carried: carriedLine(wasCarried) },
      after: { state: to, carried: carriedLine(after.carried) },
      txn, command: 'sprint',
    })],
  })
  if (!applied.ok) return storeRefusal('sprint', 'mutate', applied.error, workspace)
  if (mode === 'dry-run') return okResult(SPRINT_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, dry_run: 1, would_exit: 0 } })
  return okResult(SPRINT_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}

export function closeSprint(target: Target, clock: Clock, ids: IdGenerator, request: SprintRequest): Promise<ResultObject> {
  return moveSprint(target, clock, ids, request, 'closed')
}

export function reopenSprint(target: Target, clock: Clock, ids: IdGenerator, request: SprintRequest): Promise<ResultObject> {
  return moveSprint(target, clock, ids, request, 'open')
}

function sprintRow(view: WorkspaceView, sprint: Sprint): Row {
  const tally = tallyOf(committedTo(view, sprint))
  return {
    id: sprint.id, state: sprint.state, start: sprint.start, end: sprint.end,
    items: `${tally.done}/${tally.committed}`, pts: `${tally.donePoints}/${tally.points}`, title: sprint.title,
  }
}

/** Every sprint, or the one named: the record's own fields, the tally over its committed set, and what carried over. */
export async function sprints(store: Store, clock: Clock, id?: string): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('sprints', 'read', view.error, undefined)
  const workspace = view.value.identity.id

  if (id === undefined) {
    const rows = view.value.sprints.map((sprint) => sprintRow(view.value, sprint))
    const data: Record<string, Value> = {}
    if (rows.length === 0) data['none'] = 'no sprint has been opened here'
    data['sprints'] = { columns: columnsOf(SPRINTS_SHAPE, 'sprints'), shown: rows.length, total: rows.length, rows } satisfies Block
    return okResult(SPRINTS_SHAPE, { workspace, data })
  }

  const sprint = view.value.sprintById.get(id)
  if (sprint === undefined) return noSprint('sprints', workspace, view.value, id)
  const committed = committedTo(view.value, sprint)
  const tally = tallyOf(committed)
  const data: Record<string, Value> = {
    sprint: sprint.id, state: sprint.state, start: sprint.start, end: sprint.end, filed: sprint.filed_at,
  }
  if (sprint.closed_at !== undefined) data['closed'] = sprint.closed_at
  data['v'] = sprint.version
  if (sprint.state === 'open') {
    const at = dayOfSprint(sprint, clock.now())
    data['day'] = `${at.day}/${at.days}`
  }
  data['committed'] = tally.committed
  data['done'] = tally.done
  if (tally.cancelled > 0) data['cancelled'] = tally.cancelled
  data['pts'] = `${tally.donePoints}/${tally.points}`
  // The list the close wrote, not the open items of the moment: after a close the two
  // drift apart as carried items are committed onward, and the record is the answer.
  if (sprint.carried !== undefined) data['carried'] = sprint.carried.join(',')
  if (sprint.extra !== undefined && sprint.extra.size > 0) data['extra'] = sprint.extra.size
  data['title'] = sprint.title
  if (sprint.goal !== undefined) data['goal'] = sprint.goal
  return okResult(SPRINTS_SHAPE, { workspace, data })
}
