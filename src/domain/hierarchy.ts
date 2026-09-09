// SPDX-License-Identifier: Apache-2.0
// Parent/child hierarchy (domain model 2.3).
//
// Threat-model finding F8. Write-time cycle detection is not enough on its own, because
// decision D1 makes the committed file authoritative and a hand edit or a git merge never
// passes through a write. So every traversal here ends on a visited set rather than recursing
// into a cycle, and the walk a write runs above its chosen parent carries a stated depth
// ceiling as well, because that is the one a caller can hand an arbitrarily long chain.

import { fail, ok, type Result } from './errors.ts'
import { withArticle } from './text.ts'
import {
  type ItemId,
  type WorkItemSummary,
  type WorkItemType,
} from './types.ts'

/** The ceiling a traversal refuses at. A real backlog nests three or four deep. */
export const MAX_HIERARCHY_DEPTH = 64

/** Five pairs; the `epic > chore` pair went when `chore` folded into `task`, which epic takes. */
export const ALLOWED_PARENT_PAIRS: readonly { readonly parent: WorkItemType; readonly child: WorkItemType }[] = [
  { parent: 'epic', child: 'story' },
  { parent: 'epic', child: 'task' },
  { parent: 'story', child: 'task' },
  { parent: 'story', child: 'bug' },
  { parent: 'spike', child: 'task' },
]

export type HierarchyGraph = {
  readonly parentOf: ReadonlyMap<ItemId, ItemId>
  readonly childrenOf: ReadonlyMap<ItemId, readonly ItemId[]>
  readonly typeOf: ReadonlyMap<ItemId, WorkItemType>
}

function index(items: Iterable<WorkItemSummary>): HierarchyGraph {
  const parentOf = new Map<ItemId, ItemId>()
  const childrenOf = new Map<ItemId, ItemId[]>()
  const typeOf = new Map<ItemId, WorkItemType>()

  for (const item of items) {
    typeOf.set(item.id, item.type)
    if (item.parent_id !== undefined) {
      parentOf.set(item.id, item.parent_id)
      const siblings = childrenOf.get(item.parent_id)
      if (siblings === undefined) childrenOf.set(item.parent_id, [item.id])
      else siblings.push(item.id)
    }
  }
  return { parentOf, childrenOf, typeOf }
}

/** Builds the graph from a set of items. This is the load path, so it validates nothing. */
export function hierarchyFrom(items: Iterable<WorkItemSummary>): HierarchyGraph {
  return index(items)
}

export function childrenOf(graph: HierarchyGraph, id: ItemId): readonly ItemId[] {
  return graph.childrenOf.get(id) ?? []
}

/**
 * Walks the parent chain of every item that has one and returns the first cycle it finds,
 * as a path that closes on itself. This is the load-time check F8 asks for: it runs before
 * any walk above a node, so a hand-edited cycle is a reported finding rather than a stack
 * overflow.
 *
 * Every node has at most one parent, so a cycle is reachable only from a node that has one:
 * a start without a parent walks one step and stops. Taking the edge map alone is therefore
 * the same search, and it is the shape the store can build from one field per record as it
 * reads the shards, rather than from a whole graph.
 */
export function findParentCycle(parentOf: ReadonlyMap<ItemId, ItemId>): readonly ItemId[] | undefined {
  const settled = new Set<ItemId>()
  for (const start of parentOf.keys()) {
    if (settled.has(start)) continue
    const path: ItemId[] = []
    const seenAt = new Map<ItemId, number>()
    let node: ItemId | undefined = start
    while (node !== undefined) {
      const at = seenAt.get(node)
      if (at !== undefined) return [...path.slice(at), node]
      if (settled.has(node)) break
      seenAt.set(node, path.length)
      path.push(node)
      node = parentOf.get(node)
    }
    for (const visited of path) settled.add(visited)
  }
  return undefined
}

/**
 * The cycle through one node's ancestry, for a caller that knows which edges moved and holds
 * a graph too large to draw whole. Removing an edge cannot close a cycle and neither can
 * leaving one alone, so a graph that was acyclic before a set of edges moved is cyclic only
 * through one of the nodes those edges left, and the walk above each is all that has to run.
 *
 * The parent is fetched rather than looked up in a map, so the caller can answer from an
 * index one row at a time. The visited set and not a depth ceiling is what ends the walk: a
 * ceiling would stop short of a cycle that closes below it and report the graph clean.
 */
export function cycleAbove(
  start: ItemId, parentOf: (id: ItemId) => ItemId | undefined,
): readonly ItemId[] | undefined {
  const path: ItemId[] = [start]
  const seenAt = new Map<ItemId, number>([[start, 0]])
  let node = parentOf(start)
  while (node !== undefined) {
    const at = seenAt.get(node)
    if (at !== undefined) return [...path.slice(at), node]
    seenAt.set(node, path.length)
    path.push(node)
    node = parentOf(node)
  }
  return undefined
}

function ancestors(graph: HierarchyGraph, from: ItemId): Result<readonly ItemId[]> {
  const chain: ItemId[] = []
  const seen = new Set<ItemId>([from])
  let node = graph.parentOf.get(from)
  while (node !== undefined) {
    if (seen.has(node) || chain.length >= MAX_HIERARCHY_DEPTH) {
      return fail('INTEGRITY', seen.has(node) ? 'P2' : 'P3',
        seen.has(node)
          ? `the parent chain above ${from} closes a cycle at ${node}`
          : `the parent chain above ${from} is deeper than the ceiling of ${MAX_HIERARCHY_DEPTH}`,
        [from, node])
    }
    seen.add(node)
    chain.push(node)
    node = graph.parentOf.get(node)
  }
  return ok(chain)
}

/**
 * Sets one parent edge, refusing an unknown id, a disallowed type pair, and an edge that
 * would close a cycle. No pair in the table can form a cycle on its own, so the cycle
 * check exists for a graph a file or a merge already left a bad edge in.
 */
export function setParent(
  graph: HierarchyGraph,
  childId: ItemId,
  parentId: ItemId,
): Result<HierarchyGraph> {
  if (childId === parentId) {
    return fail('GUARD_REFUSED', 'P2', `${childId} cannot be its own parent`, [childId])
  }
  for (const id of [childId, parentId]) {
    if (!graph.typeOf.has(id)) {
      return fail('VALIDATION', 'P4', `${id} is not an item in this workspace`, [id])
    }
  }

  const childType = graph.typeOf.get(childId) as WorkItemType
  const parentType = graph.typeOf.get(parentId) as WorkItemType
  if (!ALLOWED_PARENT_PAIRS.some((p) => p.parent === parentType && p.child === childType)) {
    return fail(
      'GUARD_REFUSED',
      'P1',
      `${withArticle(parentType)} cannot be the parent of ${withArticle(childType)}`,
      [parentId, childId],
    )
  }

  const above = ancestors(graph, parentId)
  if (!above.ok) return above
  if (above.value.includes(childId) || graph.parentOf.get(parentId) === childId) {
    return fail(
      'GUARD_REFUSED',
      'P2',
      `making ${parentId} the parent of ${childId} closes a cycle through ${[parentId, ...above.value].join(' -> ')}`,
      [childId, parentId],
    )
  }

  const parentOf = new Map(graph.parentOf)
  parentOf.set(childId, parentId)
  const childrenIndex = new Map<ItemId, ItemId[]>()
  for (const [child, parent] of parentOf) {
    const siblings = childrenIndex.get(parent)
    if (siblings === undefined) childrenIndex.set(parent, [child])
    else siblings.push(child)
  }
  return ok({ ...graph, parentOf, childrenOf: childrenIndex })
}
