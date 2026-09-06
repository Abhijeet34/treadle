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
  RELATION_KINDS,
  isTerminal,
  type ItemId,
  type RelationKind,
  type WorkItem,
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

/**
 * The kinds `relation add` writes: the two that carry a rule and the one that says a caller
 * meant "see also" rather than `blocks`. The other three stay in the closed set the file
 * format reads, so a record carrying one still serves, and gain a writer with a decision
 * rather than by default; ADR-0015 carries why three and not six.
 */
export const LINKABLE_KINDS: readonly RelationKind[] = ['blocks', 'duplicates', 'relates_to']

/**
 * A caller's spelling of a kind, or `undefined`. The command line takes `relates-to` as the
 * capability contract spells it and `relates_to` as every other closed-set value here is
 * spelled, and both name the one stored kind.
 */
export function linkableKindOf(spelling: string): RelationKind | undefined {
  const kind = spelling.replaceAll('-', '_')
  return LINKABLE_KINDS.find((linkable) => linkable === kind)
}

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

/**
 * The graph a set of records carries. This is the load path, so it refuses nothing: a
 * hand-edited cycle is `findRelationCycle`'s to report and an edge to a missing record is
 * the caller's finding. A symmetric edge a file spells the other way round is the same edge.
 */
export function relationGraphFrom(items: Iterable<Pick<WorkItem, 'id' | 'relations'>>): RelationGraph {
  const relations: Relation[] = []
  // Every command pays this build through the workspace read, so a repeated edge is found by
  // key rather than by scanning the edges accepted so far: that scan was 105 ms of every
  // command at 5,000 edges, and grows with the square of the count.
  const seen = new Set<string>()
  for (const item of items) {
    for (const stored of item.relations ?? []) {
      if (!(RELATION_KINDS as readonly string[]).includes(stored.kind)) continue
      const edge = normalise({ kind: stored.kind, source: item.id, target: stored.target })
      const key = `${edge.kind} ${edge.source} ${edge.target}`
      if (seen.has(key)) continue
      seen.add(key)
      relations.push(edge)
    }
  }
  return { relations }
}

/** A symmetric edge is stored once, in id order, so the two spellings are one edge. */
function normalise(relation: Relation): Relation {
  if (!isSymmetric(relation.kind) || relation.source <= relation.target) return relation
  return { kind: relation.kind, source: relation.target, target: relation.source }
}

function same(a: Relation, b: Relation): boolean {
  return a.kind === b.kind && a.source === b.source && a.target === b.target
}

/**
 * The out-edges of one kind, keyed by source, built once per decision. Both traversals
 * below used to filter the whole relation list once per node they visited, which made a
 * write-time check O(nodes x edges) and the load-time finder O(edges x nodes x edges):
 * measured at 12.3 s for `doctor` over 200 records carrying 3,600 `blocks` edges.
 */
type Adjacency = ReadonlyMap<ItemId, readonly ItemId[]>

function adjacencyOf(graph: RelationGraph, kind: RelationKind): Adjacency {
  const out = new Map<ItemId, ItemId[]>()
  for (const relation of graph.relations) {
    if (relation.kind !== kind) continue
    const targets = out.get(relation.source)
    if (targets === undefined) out.set(relation.source, [relation.target])
    else targets.push(relation.target)
  }
  return out
}

function outgoing(adjacency: Adjacency, from: ItemId): readonly ItemId[] {
  return adjacency.get(from) ?? []
}

type Reach =
  | { readonly outcome: 'path'; readonly path: readonly ItemId[] }
  | { readonly outcome: 'too-deep' }
  /** `read` is every node whose out-edges the walk consulted, which is the decision's read set. */
  | { readonly outcome: 'none'; readonly read: readonly ItemId[] }

/**
 * Depth-bounded reachability. Returns the path when `to` is reachable from `from`,
 * `'too-deep'` when the walk hits the ceiling, and otherwise the nodes it read.
 */
function reach(adjacency: Adjacency, from: ItemId, to: ItemId): Reach {
  const stack: { readonly node: ItemId; readonly path: readonly ItemId[] }[] = [{ node: from, path: [from] }]
  const seen = new Set<ItemId>()
  while (stack.length > 0) {
    const frame = stack.pop() as { node: ItemId; path: readonly ItemId[] }
    if (frame.path.length > MAX_RELATION_DEPTH) return { outcome: 'too-deep' }
    if (frame.node === to && frame.path.length > 1) return { outcome: 'path', path: frame.path }
    if (seen.has(frame.node)) continue
    seen.add(frame.node)
    for (const next of outgoing(adjacency, frame.node)) {
      if (next === to) return { outcome: 'path', path: [...frame.path, next] }
      stack.push({ node: next, path: [...frame.path, next] })
    }
  }
  return { outcome: 'none', read: [...seen] }
}

export function addRelation(
  graph: RelationGraph,
  relation: Relation,
): Result<{ readonly graph: RelationGraph; readonly added: boolean; readonly read: readonly ItemId[] }> {
  if (relation.source === relation.target) {
    return fail('GUARD_REFUSED', 'R1', `an item cannot be related to itself: ${relation.source} ${relation.kind} ${relation.source}`, [relation.source])
  }

  const edge = normalise(relation)
  if (graph.relations.some((r) => same(r, edge))) {
    return ok({ graph, added: false, read: [] })
  }

  // A copy has one original. Two `duplicates` edges out of one item would say it is a copy
  // of two things, and the second is almost always the first spelled against the wrong id.
  if (edge.kind === 'duplicates') {
    const already = outgoing(adjacencyOf(graph, 'duplicates'), edge.source)[0]
    if (already !== undefined) {
      return fail('GUARD_REFUSED', 'R4',
        `${edge.source} already duplicates ${already}, and an item is a duplicate of one thing`,
        [edge.source, already])
    }
  }

  // The read set is every node whose edges decided this: a concurrent write to one of them
  // is a write the store refuses, because a cycle two commands close between them is one
  // neither could see (the store's `reads` precondition, ADR-0015).
  let read: readonly ItemId[] = []
  if (!isSymmetric(edge.kind)) {
    const closing = reach(adjacencyOf(graph, edge.kind), edge.target, edge.source)
    if (closing.outcome === 'too-deep') {
      return fail('GUARD_REFUSED', 'R3',
        `the ${edge.kind} graph below ${edge.target} is deeper than the ceiling of ${MAX_RELATION_DEPTH}`,
        [edge.source, edge.target])
    }
    if (closing.outcome === 'path') {
      return fail('GUARD_REFUSED', 'R2',
        `${edge.source} ${edge.kind} ${edge.target} closes a cycle through ${[edge.source, ...closing.path].join(' -> ')}`,
        [edge.source, edge.target])
    }
    read = closing.read
  }

  return ok({ graph: { relations: [...graph.relations, edge] }, added: true, read })
}

export function removeRelation(
  graph: RelationGraph,
  relation: Relation,
): { readonly graph: RelationGraph; readonly removed: boolean } {
  const edge = normalise(relation)
  const kept = graph.relations.filter((r) => !same(r, edge))
  return { graph: { relations: kept }, removed: kept.length !== graph.relations.length }
}

/**
 * The load-time cycle check, which write-time detection cannot perform for a hand edit. One
 * depth-first pass with an explicit stack, so it is linear in the graph and bounded by the
 * node count rather than by the write-time ceiling: a hand-edited cycle longer than
 * MAX_RELATION_DEPTH is a cycle all the same, and this used to miss it.
 */
export function findRelationCycle(
  graph: RelationGraph,
  kind: RelationKind,
): readonly ItemId[] | undefined {
  if (isSymmetric(kind)) return undefined
  const adjacency = adjacencyOf(graph, kind)
  const done = new Set<ItemId>()
  for (const root of adjacency.keys()) {
    if (done.has(root)) continue
    const path: ItemId[] = [root]
    const cursor: number[] = [0]
    const onPath = new Set<ItemId>([root])
    while (path.length > 0) {
      const node = path[path.length - 1] as ItemId
      const at = cursor[cursor.length - 1] as number
      const next = outgoing(adjacency, node)[at]
      if (next === undefined) {
        done.add(node)
        onPath.delete(node)
        path.pop()
        cursor.pop()
        continue
      }
      cursor[cursor.length - 1] = at + 1
      if (onPath.has(next)) return [...path.slice(path.indexOf(next)), next]
      if (done.has(next)) continue
      path.push(next)
      cursor.push(0)
      onPath.add(next)
    }
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
 * exists. An impediment is an item, so one that is raised against this item is in this
 * list through the same `blocks` edge as any other blocker, and is inactive once resolved.
 *
 * A blocker the caller cannot find is not active: it cannot be finished or cancelled, so
 * counting it would hold the item forever on a record a hand edit removed. `doctor` names
 * the dangling edge instead.
 */
export function blockersOf(
  graph: RelationGraph,
  stateOf: (id: ItemId) => WorkItemState | undefined,
  id: ItemId,
): readonly ItemId[] {
  return graph.relations
    .filter((r) => {
      if (r.kind !== 'blocks' || r.target !== id) return false
      const state = stateOf(r.source)
      return state !== undefined && !isTerminal(state)
    })
    .map((r) => r.source)
}

export function isBlocked(
  graph: RelationGraph,
  stateOf: (id: ItemId) => WorkItemState | undefined,
  id: ItemId,
): boolean {
  return blockersOf(graph, stateOf, id).length > 0
}
