// SPDX-License-Identifier: Apache-2.0
// The transition use case, and the two anti-ambiguity modes that ride on it.
//
// A dry run holds an overlay store rather than a flag: every guard runs, the record goes
// through encode, render, parse and decode exactly as a real write does, and nothing
// touches a file. A preview evaluates no guard at all and says so on its last line, so the
// cheap "am I pointing at the right thing" check can never be mistaken for a guard check.

import {
  TRANSITION_TABLE,
  evaluateTransition,
  isTerminal,
  type GuardId,
  type GuardResult,
  type ItemId,
  type WorkItem,
  type WorkItemState,
} from '../../domain/index.ts'
import { errorResult, okResult, type ResultObject, type ResultShape, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import type { Store } from '../ports/store.ts'
import { readWorkspace, transitionContextFor } from './context.ts'
import { diffOf, makeEvent, type Actor, type Mode } from './mutation.ts'
import { notFound } from './items.ts'
import { storeRefusal } from './refusal.ts'

export const TRANSITION_SHAPE: ResultShape = {
  command: 'transition',
  version: 1,
  effect: 'mutate',
  summary: 'Move one item to a target state, with every guard on that edge evaluated.',
  properties: [
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'already', type: 'string' },
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'scalar', key: 'since', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'string' },
    { kind: 'list', key: 'set' },
    { kind: 'scalar', key: 'guards', type: 'string' },
    { kind: 'scalar', key: 'will_evaluate', type: 'string' },
    { kind: 'scalar', key: 'will_write', type: 'string' },
    { kind: 'scalar', key: 'events', type: 'string' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
  ],
}

/** Fields a transition may move, in the order they report. */
const MOVED = ['state', 'hold_reason', 'hold_until', 'held_from'] as const

export type TransitionRequestInput = {
  readonly id: ItemId
  readonly target: WorkItemState | 'resume'
  readonly reason?: string
  readonly until?: string
  readonly overrides?: readonly GuardId[]
  readonly actor: Actor
  readonly mode: Mode
}

function guardLine(guards: readonly GuardResult[]): string {
  return guards
    .map((guard) => `${guard.guard} ${guard.pass ? 'pass' : 'fail'}${guard.observed === undefined ? '' : `:${guard.observed}`}${guard.overridden === true ? '/overridden' : ''}`)
    .join(' ')
}

/** The instant the item entered its current state, and the event that says so. */
async function entered(
  store: Store, item: WorkItem,
): Promise<{ readonly at: string; readonly event: string } | undefined> {
  const events = await store.events({ entity: item.id })
  if (!events.ok) return undefined
  for (let i = events.value.length - 1; i >= 0; i -= 1) {
    const event = events.value[i] as { id: string; at: string; op: string; after?: unknown }
    if (event.op === 'item.transition' || event.op === 'item.file') {
      return { at: event.at, event: event.id }
    }
  }
  return undefined
}

function nextItem(item: WorkItem, to: WorkItemState, request: TransitionRequestInput): WorkItem {
  const draft: Record<string, unknown> = { ...item, state: to }
  if (to === 'on_hold') {
    draft['held_from'] = item.state
    if (request.reason !== undefined) draft['hold_reason'] = request.reason
    if (request.until !== undefined) draft['hold_until'] = request.until
  } else if (item.state === 'on_hold') {
    delete draft['held_from']
    delete draft['hold_reason']
    delete draft['hold_until']
  }
  return draft as unknown as WorkItem
}

export async function transition(
  store: Store, clock: Clock, ids: IdGenerator, request: TransitionRequestInput,
): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('transition', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const item = view.value.byId.get(request.id)
  if (item === undefined) return notFound('transition', workspace, view.value, request.id)

  const context = transitionContextFor(view.value, item)

  if (request.mode === 'preview') {
    return okResult(TRANSITION_SHAPE, {
      workspace, txn: null, changed: 0,
      data: {
        preview: 1,
        item: item.id,
        store: view.value.identity.path ?? workspace,
        state: item.state,
        will_evaluate: guardsOnEdge(item, request.target).join(' ') || '-',
        will_write: 'item.transition',
        note: 'guards not evaluated; use --dry-run for the outcome',
      },
    })
  }

  const outcome = evaluateTransition(context, {
    target: request.target,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.overrides === undefined ? {} : { overrides: request.overrides }),
  })

  if (outcome.outcome === 'already') {
    const at = await entered(store, item)
    const data: Record<string, Value> = { already: item.id, state: outcome.state, v: String(item.version) }
    if (at !== undefined) { data['since'] = at.at; data['event'] = at.event }
    return okResult(TRANSITION_SHAPE, { workspace, txn: null, changed: 0, data })
  }

  if (outcome.outcome === 'refused') {
    const failed = outcome.guards.find((guard) => !guard.pass)
    const input = {
      code: 'GUARD_REFUSED' as const,
      command: 'transition', workspace, effect: 'mutate' as const,
      rule: outcome.error.rule ?? 'T1',
      entity: `item ${item.id}`,
      cause: outcome.error.message,
      fix: fixesFor(item, request, failed),
    }
    return errorResult(failed === undefined ? input : { ...input, guard: failed.guard })
  }

  const after = nextItem(item, outcome.to, request)
  const txn = ids.txn()
  const eventId = ids.event()
  const now = clock.now()
  const applied = await store.apply({
    txn,
    writes: [{ item: after, ifVersion: item.version }],
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: item.id, op: 'item.transition',
      before: { state: outcome.from }, after: { state: outcome.to },
      guards: outcome.guards, txn, command: 'transition',
    })],
  })
  if (!applied.ok) return storeRefusal('transition', 'mutate', applied.error, workspace)

  const written = applied.value.writes[0]
  const changes = diffOf(item, after, MOVED).filter((change) => change.field !== 'state')
  const data: Record<string, Value> = {
    item: item.id,
    state: `${outcome.from} -> ${outcome.to}`,
    v: `${item.version} -> ${written?.version ?? item.version + 1}`,
    set: changes.map((change) => `${change.field} ${change.before} -> ${change.after}`),
    guards: guardLine(outcome.guards),
  }
  if (request.mode === 'dry-run') {
    return okResult(TRANSITION_SHAPE, {
      workspace, txn: null, changed: 0,
      data: { dry_run: 1, would_exit: 0, ...data, events: '1 item.transition' },
    })
  }
  return okResult(TRANSITION_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}

/**
 * The guards a preview says it *would* evaluate. Read off the transition table rather than
 * from an evaluation, which is the whole point of the mode: it resolves the target and the
 * store and evaluates nothing.
 */
function guardsOnEdge(item: WorkItem, target: WorkItemState | 'resume'): readonly GuardId[] {
  const to = target === 'resume' ? item.held_from : target
  const spec = TRANSITION_TABLE.find((edge) => edge.from === item.state && edge.to === to)
  if (spec === undefined) return []
  return item.type === 'epic' && to === 'done' ? [...spec.guards, 'G8'] : spec.guards
}

/** Remediations for a refused edge, most likely first, each runnable and each bounded. */
function fixesFor(
  item: WorkItem, request: TransitionRequestInput, failed: GuardResult | undefined,
): readonly string[] {
  const fixes: string[] = [`treadle explain ${item.id}`]
  const target = request.target === 'resume' ? item.held_from : request.target
  if (failed !== undefined && ['G2', 'G3', 'G7'].includes(failed.guard) && target !== undefined) {
    fixes.unshift(`treadle transition ${item.id} ${target} --override ${failed.guard} --reason "<why>"`)
  }
  if (target !== undefined && isTerminal(target)) fixes.push(`treadle show ${item.id}`)
  return fixes
}
