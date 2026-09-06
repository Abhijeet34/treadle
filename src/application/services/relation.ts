// SPDX-License-Identifier: Apache-2.0
// The typed link between two items: `relation add` and `relation remove`.
//
// `explain` printed `blocked no` and `blocks -` on every item from the day it shipped, and
// no command could write either: the tool reported a fact it had no way to record. This is
// the write path for that fact, and it is a typed edge rather than a note because a typed
// edge can be refused. An id that is not an item, a `blocks` edge that closes a cycle, an
// item related to itself and a second original for one duplicate are each a refusal here
// and a silent lie in prose.
//
// An edge is stored once, on one record's `relations` section, and the other direction is
// derived on every read by `relationsOf` and `blockersOf`. Two stored directions are two
// places for one truth, and a hand edit or a merge would move one without the other. The
// record written is therefore the edge's source: the blocker, the copy, or for the one
// symmetric kind the lower id, so the same edge spelled either way lands in the same place.

import {
  addRelation,
  isSymmetric,
  isTerminal,
  linkableKindOf,
  removeRelation,
  validateWorkItem,
  LINKABLE_KINDS,
  type ItemId,
  type Relation,
  type StoredRelation,
  type WorkItem,
  type WorkItemSummary,
} from '../../domain/index.ts'
import { errorResult, okResult, type ResultObject, type ResultShape, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import { readWorkspace, wholeItem, type WorkspaceView } from './context.ts'
import { notFound } from './items.ts'
import { makeEvent, type Actor, type Target } from './mutation.ts'
import { storeRefusal } from './refusal.ts'

export const RELATION_SHAPE: ResultShape = {
  command: 'relation',
  version: 1,
  effect: 'mutate',
  summary: 'Link two items with a typed edge, or remove one; the inverse is derived, never stored.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'string' },
    { kind: 'scalar', key: 'kind', type: 'string' },
    { kind: 'scalar', key: 'other', type: 'string' },
    { kind: 'scalar', key: 'already', type: 'string' },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
  ],
}

export const RELATION_VERBS = ['add', 'remove'] as const
export type RelationVerb = (typeof RELATION_VERBS)[number]

export type RelationRequest = {
  readonly verb: RelationVerb
  readonly id: ItemId
  /** The kind as the caller spelled it, so a refusal can name the token typed. */
  readonly kind: string
  readonly other: ItemId
  readonly actor: Actor
}

/** The record an edge is stored on and its entry there, or `undefined` when nothing holds it. */
function holderOf(view: WorkspaceView, edge: Relation): { readonly item: WorkItemSummary; readonly entry: StoredRelation } | undefined {
  const ends = isSymmetric(edge.kind) ? [edge.source, edge.target] : [edge.source]
  for (const end of ends) {
    const item = view.byId.get(end)
    const other = end === edge.source ? edge.target : edge.source
    const entry = item?.relations?.find((stored) => stored.kind === edge.kind && stored.target === other)
    if (item !== undefined && entry !== undefined) return { item, entry }
  }
  return undefined
}

export async function relate(
  target: Target, clock: Clock, ids: IdGenerator, request: RelationRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('relation', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const source = view.value.byId.get(request.id)
  if (source === undefined) return notFound('relation', 'mutate', workspace, view.value, request.id)
  const kind = linkableKindOf(request.kind)
  if (kind === undefined) {
    return errorResult({
      code: 'VALIDATION', command: 'relation', workspace, effect: 'mutate', rule: 'C1', entity: source.id,
      cause: `${request.kind} is not a relation kind; the kinds are ${LINKABLE_KINDS.join(', ')}`,
      fix: ['treadle help relation'],
    })
  }
  // The other end is looked up before the graph decides anything, so an edge to nothing is
  // the same refusal every command gives an id it cannot resolve, with the near ids beside
  // it. A remove takes any id, because dropping an edge to a record a hand edit removed is
  // the remedy doctor's H24 names.
  if (request.verb === 'add' && view.value.byId.get(request.other) === undefined) {
    return notFound('relation', 'mutate', workspace, view.value, request.other)
  }

  const asked: Relation = { kind, source: source.id, target: request.other }
  // The view decides everything above; the one record that changes is read whole here.
  const record = async (id: ItemId): Promise<WorkItem | undefined> => {
    const whole = await wholeItem(store, view.value, id)
    return whole.ok ? whole.value : undefined
  }
  let written: WorkItem
  let edge: Relation
  let reads: readonly { readonly id: ItemId; readonly version: number }[] = []
  if (request.verb === 'add') {
    const added = addRelation(view.value.relations, asked)
    if (!added.ok) {
      return errorResult({
        code: added.error.code === 'VALIDATION' ? 'VALIDATION' : 'GUARD_REFUSED',
        command: 'relation', workspace, effect: 'mutate', rule: added.error.rule ?? 'R2', entity: source.id,
        cause: added.error.message, fix: [`treadle show ${source.id}`, `treadle explain ${request.other}`],
      })
    }
    if (!added.value.added) {
      return okResult(RELATION_SHAPE, { workspace, txn: null, changed: 0, data: { already: source.id, v: String(source.version) } })
    }
    edge = added.value.graph.relations[added.value.graph.relations.length - 1] as Relation
    // Every record the cycle check read, at the version it read; the store refuses the
    // write if one moved, which is what stops two commands closing a cycle between them.
    reads = added.value.read
      .filter((id) => id !== edge.source)
      .flatMap((id) => { const item = view.value.byId.get(id); return item === undefined ? [] : [{ id, version: item.version }] })
    const holder = await record(edge.source)
    if (holder === undefined) return notFound('relation', 'mutate', workspace, view.value, edge.source)
    written = { ...holder, relations: [...(holder.relations ?? []), { kind: edge.kind, target: edge.target }] }
  } else {
    const removed = removeRelation(view.value.relations, asked)
    const holder = removed.removed ? holderOf(view.value, asked) : undefined
    if (holder === undefined) {
      return okResult(RELATION_SHAPE, {
        workspace, txn: null, changed: 0,
        data: { already: source.id, v: String(source.version), note: `${source.id} does not ${kind} ${request.other}` },
      })
    }
    edge = { kind, source: holder.item.id, target: holder.entry.target }
    const whole = await record(holder.item.id)
    if (whole === undefined) return notFound('relation', 'mutate', workspace, view.value, holder.item.id)
    const kept = (whole.relations ?? []).filter((stored) => stored.kind !== holder.entry.kind || stored.target !== holder.entry.target)
    written = kept.length === 0
      ? Object.fromEntries(Object.entries(whole).filter(([key]) => key !== 'relations')) as unknown as WorkItem
      : { ...whole, relations: kept }
  }

  const now = clock.now()
  const valid = validateWorkItem(written, { now })
  if (!valid.ok) {
    return errorResult({
      code: 'VALIDATION', command: 'relation', workspace, effect: 'mutate',
      rule: valid.error.rule ?? 'V4', entity: written.id, cause: valid.error.message, fix: [`treadle show ${written.id}`],
    })
  }

  const before = view.value.byId.get(written.id) as WorkItemSummary
  if (mode === 'preview') {
    return okResult(RELATION_SHAPE, {
      workspace, txn: null, changed: 0,
      data: {
        item: written.id, kind: edge.kind, other: edge.target, preview: 1,
        store: view.value.identity.path ?? workspace, note: 'nothing evaluated; use --dry-run for the outcome',
      },
    })
  }

  const txn = ids.txn()
  const eventId = ids.event()
  const snapshot = { kind: edge.kind, other: edge.target }
  const applied = await store.apply({
    txn,
    writes: [{ item: written, ifVersion: before.version }],
    ...(reads.length === 0 ? {} : { reads }),
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: written.id, op: `item.relation.${request.verb}`,
      ...(request.verb === 'add' ? { after: snapshot } : { before: snapshot }),
      txn, command: 'relation',
    })],
  })
  if (!applied.ok) return storeRefusal('relation', 'mutate', applied.error, workspace)

  const data: Record<string, Value> = {
    item: written.id,
    v: `${before.version} -> ${applied.value.writes[0]?.version ?? before.version + 1}`,
    kind: edge.kind,
    other: edge.target,
  }
  // A terminal blocker is inactive on every read, so the edge just written blocks nothing;
  // the write succeeds, because the edge is still the record of what was raised against
  // what, and the caller is told rather than left to find `blocked no` on the target.
  if (request.verb === 'add' && edge.kind === 'blocks' && isTerminal(source.state)) {
    data['note'] = `${source.id} is ${source.state}, so this edge blocks nothing while it stays ${source.state}`
  }
  if (mode === 'dry-run') {
    return okResult(RELATION_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, dry_run: 1, would_exit: 0 } })
  }
  return okResult(RELATION_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}
