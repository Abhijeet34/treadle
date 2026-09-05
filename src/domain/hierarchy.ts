// SPDX-License-Identifier: Apache-2.0
// Parent/child hierarchy and roll-up (domain model 2.3).
//
// Threat-model finding F8. Write-time cycle detection is not enough on its own, because
// decision D1 makes the committed file authoritative and a hand edit or a git merge never
// passes through a write. So every traversal here carries a visited set and a stated depth
// ceiling, and reports a cycle as a named refusal rather than recursing into it.

import { fail, ok, type Result } from './errors.ts'
import {
  type ItemId,
  type WorkItem,
  type WorkItemState,
  type WorkItemType,
} from './types.ts'

/** The ceiling a traversal refuses at. A real backlog nests three or four deep. */
export const MAX_HIERARCHY_DEPTH = 64

export const ALLOWED_PARENT_PAIRS: readonly { readonly parent: WorkItemType; readonly child: WorkItemType }[] = [
  { parent: 'epic', child: 'story' },
  { parent: 'epic', child: 'task' },
  { parent: 'epic', child: 'chore' },
  { parent: 'story', child: 'task' },
  { parent: 'story', child: 'bug' },
  { parent: 'spike', child: 'task' },
]

export type HierarchyGraph = {
  readonly parentOf: ReadonlyMap<ItemId, ItemId>
  readonly childrenOf: ReadonlyMap<ItemId, readonly ItemId[]>
  readonly typeOf: ReadonlyMap<ItemId, WorkItemType>
  readonly stateOf: ReadonlyMap<ItemId, WorkItemState>
  readonly pointsOf: ReadonlyMap<ItemId, number>
}

export type RollUp = {
  readonly id: ItemId
  /** Points summed over every non-cancelled descendant. A cancelled subtree is excluded whole. */
  readonly points: number
  readonly donePoints: number
  /** Done points over total points, or null when nothing in the subtree is estimated. */
  readonly progress: number | null
  readonly children: number
  readonly doneChildren: number
  readonly descendants: number
  readonly doneDescendants: number
}

function index(items: Iterable<WorkItem>): HierarchyGraph {
  const parentOf = new Map<ItemId, ItemId>()
  const childrenOf = new Map<ItemId, ItemId[]>()
  const typeOf = new Map<ItemId, WorkItemType>()
  const stateOf = new Map<ItemId, WorkItemState>()
  const pointsOf = new Map<ItemId, number>()

  for (const item of items) {
    typeOf.set(item.id, item.type)
    stateOf.set(item.id, item.state)
    if (item.points !== undefined) pointsOf.set(item.id, item.points)
    if (item.parent_id !== undefined) {
      parentOf.set(item.id, item.parent_id)
      const siblings = childrenOf.get(item.parent_id)
      if (siblings === undefined) childrenOf.set(item.parent_id, [item.id])
      else siblings.push(item.id)
    }
  }
  return { parentOf, childrenOf, typeOf, stateOf, pointsOf }
}

/** Builds the graph from a set of items. This is the load path, so it validates nothing. */
export function hierarchyFrom(items: Iterable<WorkItem>): HierarchyGraph {
  return index(items)
}

export function childrenOf(graph: HierarchyGraph, id: ItemId): readonly ItemId[] {
  return graph.childrenOf.get(id) ?? []
}

/**
 * Walks the parent chain of every item that has one and returns the first cycle it finds,
 * as a path that closes on itself. This is the load-time check F8 asks for: it runs before
 * a roll-up, so a hand-edited cycle is a reported finding rather than a stack overflow.
 *
 * Every node has at most one parent, so a cycle is reachable only from a node that has one:
 * a start without a parent walks one step and stops. Taking the edge map alone is therefore
 * the same search, and it is the shape the store can read as two index columns rather than
 * as a whole graph.
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

export function findHierarchyCycle(graph: HierarchyGraph): readonly ItemId[] | undefined {
  return findParentCycle(graph.parentOf)
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
      `a ${parentType} cannot be the parent of a ${childType}`,
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

/**
 * Rolls a subtree up to one summary. Cancelled descendants are excluded together with
 * their own subtrees, which is what "cancelled children excluded from both" means once
 * the tree is more than one level deep.
 */
export function rollUp(graph: HierarchyGraph, id: ItemId): Result<RollUp> {
  if (!graph.typeOf.has(id)) {
    return fail('VALIDATION', 'P4', `${id} is not an item in this workspace`, [id])
  }

  const visited = new Set<ItemId>([id])
  let points = 0
  let donePoints = 0
  let descendants = 0
  let doneDescendants = 0

  const stack: { readonly node: ItemId; readonly depth: number }[] = [{ node: id, depth: 0 }]
  while (stack.length > 0) {
    const frame = stack.pop() as { node: ItemId; depth: number }
    if (frame.depth > MAX_HIERARCHY_DEPTH) {
      return fail('INTEGRITY', 'P3',
        `the subtree below ${id} is deeper than the ceiling of ${MAX_HIERARCHY_DEPTH}`, [id, frame.node])
    }
    for (const child of childrenOf(graph, frame.node)) {
      if (visited.has(child)) {
        return fail('INTEGRITY', 'P2',
          `the hierarchy below ${id} closes a cycle at ${child}`, [id, child])
      }
      if (graph.stateOf.get(child) === 'cancelled') continue
      visited.add(child)
      descendants += 1
      const childPoints = graph.pointsOf.get(child) ?? 0
      points += childPoints
      if (graph.stateOf.get(child) === 'done') {
        donePoints += childPoints
        doneDescendants += 1
      }
      stack.push({ node: child, depth: frame.depth + 1 })
    }
  }

  const direct = childrenOf(graph, id).filter((c) => graph.stateOf.get(c) !== 'cancelled')
  return ok({
    id,
    points,
    donePoints,
    progress: points === 0 ? null : donePoints / points,
    children: direct.length,
    doneChildren: direct.filter((c) => graph.stateOf.get(c) === 'done').length,
    descendants,
    doneDescendants,
  })
}
