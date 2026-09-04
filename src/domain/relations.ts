// SPDX-License-Identifier: Apache-2.0
// The typed relation graph (domain model 2.3). Six kinds, each with a defined inverse.
//
// Blocked is derived here and never stored, so it cannot go stale on disk, and the raw
// relation list is always available under its own name rather than behind the flag.
//
// Threat-model finding F8 again: write-time cycle detection cannot see an edge a hand edit
// or a merge already put in the file, so every traversal is bounded and there is a
// load-time cycle finder beside the write-time one.

import { fail, ok, type Result } from './errors.ts'
import {
  isTerminal,
  type ItemId,
  type RelationKind,
  type WorkItemState,
} from './types.ts'

/** The ceiling a traversal refuses at, matching the hierarchy's. */
export const MAX_RELATION_DEPTH = 64

const INVERSES: Readonly<Record<RelationKind, string>> = {
  blocks: 'blocked_by',
  duplicates: 'duplicated_by',
  caused_by: 'causes',
  discovered_from: 'led_to',
  split_from: 'split_into',
  relates_to: 'relates_to',
}

/** relates_to is the model's only symmetric kind, so a cycle in it means nothing. */
const SYMMETRIC: ReadonlySet<RelationKind> = new Set<RelationKind>(['relates_to'])

export function inverseOf(kind: RelationKind): string {
  return INVERSES[kind]
}

export function isSymmetric(kind: RelationKind): boolean {
  return SYMMETRIC.has(kind)
}

export type Relation = {
  readonly kind: RelationKind
  readonly source: ItemId
  readonly target: ItemId
}

export type RelationGraph = {
  readonly relations: readonly Relation[]
}

export type RelationView = {
  readonly kind: string
  readonly other: ItemId
  readonly direction: 'outgoing' | 'incoming'
}

export function emptyRelationGraph(): RelationGraph {
  return { relations: [] }
}

/** A symmetric edge is stored once, in id order, so the two spellings are one edge. */
function normalise(relation: Relation): Relation {
  if (!isSymmetric(relation.kind) || relation.source <= relation.target) return relation
  return { kind: relation.kind, source: relation.target, target: relation.source }
}

function same(a: Relation, b: Relation): boolean {
  return a.kind === b.kind && a.source === b.source && a.target === b.target
}

function outgoing(graph: RelationGraph, kind: RelationKind, from: ItemId): readonly ItemId[] {
  return graph.relations.filter((r) => r.kind === kind && r.source === from).map((r) => r.target)
}

/**
 * Depth-bounded reachability. Returns the path when `to` is reachable from `from`,
 * `'too-deep'` when the walk hits the ceiling, and undefined when it is not reachable.
 */
function pathBetween(
  graph: RelationGraph,
  kind: RelationKind,
  from: ItemId,
  to: ItemId,
): readonly ItemId[] | 'too-deep' | undefined {
  const stack: { readonly node: ItemId; readonly path: readonly ItemId[] }[] = [{ node: from, path: [from] }]
  const seen = new Set<ItemId>()
  while (stack.length > 0) {
    const frame = stack.pop() as { node: ItemId; path: readonly ItemId[] }
    if (frame.path.length > MAX_RELATION_DEPTH) return 'too-deep'
    if (frame.node === to && frame.path.length > 1) return frame.path
    if (seen.has(frame.node)) continue
    seen.add(frame.node)
    for (const next of outgoing(graph, kind, frame.node)) {
      if (next === to) return [...frame.path, next]
      stack.push({ node: next, path: [...frame.path, next] })
    }
  }
  return undefined
}

export function addRelation(
  graph: RelationGraph,
  relation: Relation,
): Result<{ readonly graph: RelationGraph; readonly added: boolean }> {
  if (relation.source === relation.target) {
    return fail('GUARD_REFUSED', 'R1', `an item cannot ${relation.kind} itself (${relation.source})`, [relation.source])
  }

  const edge = normalise(relation)
  if (graph.relations.some((r) => same(r, edge))) {
    return ok({ graph, added: false })
  }

  if (!isSymmetric(edge.kind)) {
    const closing = pathBetween(graph, edge.kind, edge.target, edge.source)
    if (closing === 'too-deep') {
      return fail('GUARD_REFUSED', 'R3',
        `the ${edge.kind} graph below ${edge.target} is deeper than the ceiling of ${MAX_RELATION_DEPTH}`,
        [edge.source, edge.target])
    }
    if (closing !== undefined) {
      return fail('GUARD_REFUSED', 'R2',
        `${edge.source} ${edge.kind} ${edge.target} closes a cycle through ${[...closing, edge.source].join(' -> ')}`,
        [edge.source, edge.target])
    }
  }

  return ok({ graph: { relations: [...graph.relations, edge] }, added: true })
}

export function removeRelation(
  graph: RelationGraph,
  relation: Relation,
): { readonly graph: RelationGraph; readonly removed: boolean } {
  const edge = normalise(relation)
  const kept = graph.relations.filter((r) => !same(r, edge))
  return { graph: { relations: kept }, removed: kept.length !== graph.relations.length }
}

/** The load-time cycle check, which write-time detection cannot perform for a hand edit. */
export function findRelationCycle(
  graph: RelationGraph,
  kind: RelationKind,
): readonly ItemId[] | undefined {
  if (isSymmetric(kind)) return undefined
  for (const relation of graph.relations) {
    if (relation.kind !== kind) continue
    const closing = pathBetween(graph, kind, relation.target, relation.source)
    if (closing !== undefined && closing !== 'too-deep') return [...closing, relation.target]
  }
  return undefined
}

/** Outgoing edges under their own kind, incoming edges under the inverse (risk A9). */
export function relationsOf(graph: RelationGraph, id: ItemId): readonly RelationView[] {
  const views: RelationView[] = []
  for (const relation of graph.relations) {
    if (isSymmetric(relation.kind)) {
      if (relation.source === id) views.push({ kind: relation.kind, other: relation.target, direction: 'outgoing' })
      else if (relation.target === id) views.push({ kind: relation.kind, other: relation.source, direction: 'outgoing' })
      continue
    }
    if (relation.source === id) views.push({ kind: relation.kind, other: relation.target, direction: 'outgoing' })
    else if (relation.target === id) views.push({ kind: inverseOf(relation.kind), other: relation.source, direction: 'incoming' })
  }
  return views
}

/**
 * The blockers that are still active. An item is blocked while at least one of these
 * exists, or while an open impediment names it; impediments are the caller's to add,
 * because the impediment entity is not in this layer yet.
 */
export function blockersOf(
  graph: RelationGraph,
  stateOf: (id: ItemId) => WorkItemState | undefined,
  id: ItemId,
): readonly ItemId[] {
  return graph.relations
    .filter((r) => r.kind === 'blocks' && r.target === id && !isTerminal(stateOf(r.source)))
    .map((r) => r.source)
}

export function isBlocked(
  graph: RelationGraph,
  stateOf: (id: ItemId) => WorkItemState | undefined,
  id: ItemId,
): boolean {
  return blockersOf(graph, stateOf, id).length > 0
}
