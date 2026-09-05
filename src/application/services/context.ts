// SPDX-License-Identifier: Apache-2.0
// One read of the store, then every derived fact a command needs off that one read. The
// domain layer takes derived facts as arguments, so this file is where they are derived:
// the hierarchy graph, the gate contexts, the blocker lists and the transition context.
//
// The relation graph is empty here, and deliberately: no command that writes a relation is
// built yet, so nothing in the store can carry one. When `link` lands it fills this in and
// every guard that reads blockers starts biting, with no change above this file.

import {
  DEFAULT_DONE_GATE,
  DEFAULT_READY_GATE,
  blockersOf,
  emptyRelationGraph,
  evaluateGate,
  hierarchyFrom,
  type Gate,
  type GateChild,
  type GateContext,
  type GateVerdict,
  type HierarchyGraph,
  type ItemId,
  type RelationGraph,
  type TransitionContext,
  type WorkItem,
  type WorkItemState,
  type WorkItemType,
} from '../../domain/index.ts'
import type { Finding, Store, StoreIdentity, StoreResult } from '../ports/store.ts'

/**
 * Types whose work passes through review, which is guard G5's input. Workspace
 * configuration owns this once `config` lands; until then it is one stated default.
 */
const REVIEW_STEP: readonly WorkItemType[] = ['story', 'bug', 'epic']

export function hasReviewStep(type: WorkItemType): boolean {
  return REVIEW_STEP.includes(type)
}

export type WorkspaceView = {
  readonly identity: StoreIdentity
  readonly items: readonly WorkItem[]
  /**
   * A lookup index over `items`, and only that. It used to be the third place a record's
   * identity was decided, because a `Map` keeps the last entry for a repeated key while the
   * store's two owners both refuse one; the map is safe now because neither owner can hand
   * `list` a repeated id. What a lookup cannot answer is why an id is absent, which is what
   * `unserved` is for: absent and ambiguous are different refusals.
   */
  readonly byId: ReadonlyMap<ItemId, WorkItem>
  /** Ids the store holds records for and refuses to serve, with the finding that says why. */
  readonly unserved: ReadonlyMap<ItemId, Finding>
  readonly hierarchy: HierarchyGraph
  readonly relations: RelationGraph
}

export async function readWorkspace(store: Store): Promise<StoreResult<WorkspaceView>> {
  const identity = await store.identity()
  if (!identity.ok) return identity
  const items = await store.list()
  if (!items.ok) return items
  const findings = await store.findings()
  if (!findings.ok) return findings

  const byId = new Map(items.value.map((item) => [item.id, item]))
  const unserved = new Map(findings.value.flatMap(
    (finding) => (finding.id === undefined || byId.has(finding.id) ? [] : [[finding.id, finding] as const]),
  ))
  return {
    ok: true,
    value: {
      identity: identity.value,
      items: items.value,
      byId,
      unserved,
      hierarchy: hierarchyFrom(items.value),
      relations: emptyRelationGraph(),
    },
  }
}

export function activeBlockers(view: WorkspaceView, id: ItemId): readonly ItemId[] {
  return blockersOf(view.relations, (other) => view.byId.get(other)?.state, id)
}

/** Items this one blocks that are still active, which guard G7 reads. */
export function blockedByThis(view: WorkspaceView, id: ItemId): readonly ItemId[] {
  return view.relations.relations
    .filter((relation) => relation.kind === 'blocks' && relation.source === id)
    .map((relation) => relation.target)
    .filter((target) => {
      const state = view.byId.get(target)?.state
      return state !== undefined && state !== 'done' && state !== 'cancelled'
    })
}

function childrenGates(view: WorkspaceView, id: ItemId): readonly GateChild[] {
  return (view.hierarchy.childrenOf.get(id) ?? []).flatMap((child) => {
    const item = view.byId.get(child)
    return item === undefined ? [] : [{ id: item.id, type: item.type, state: item.state }]
  })
}

export function gateContextFor(view: WorkspaceView, item: WorkItem): GateContext {
  return {
    item,
    blockers: activeBlockers(view, item.id),
    children: childrenGates(view, item.id),
    reviewStep: hasReviewStep(item.type),
    // Impediments are not an entity in the store yet, so nothing can be open against an item.
    openImpediments: 0,
  }
}

export function readyVerdict(view: WorkspaceView, item: WorkItem, gate: Gate = DEFAULT_READY_GATE): GateVerdict {
  return evaluateGate(gate, gateContextFor(view, item))
}

export function doneVerdict(view: WorkspaceView, item: WorkItem, gate: Gate = DEFAULT_DONE_GATE): GateVerdict {
  return evaluateGate(gate, gateContextFor(view, item))
}

export function openChildrenOf(view: WorkspaceView, id: ItemId): readonly ItemId[] {
  return (view.hierarchy.childrenOf.get(id) ?? []).filter((child) => {
    const state: WorkItemState | undefined = view.byId.get(child)?.state
    return state !== undefined && state !== 'done' && state !== 'cancelled'
  })
}

export function transitionContextFor(view: WorkspaceView, item: WorkItem): TransitionContext {
  return {
    item,
    readyGate: readyVerdict(view, item),
    doneGate: doneVerdict(view, item),
    blockers: activeBlockers(view, item.id),
    // No board exists until `board` lands, and an absent column is what the domain reads as
    // "no work-in-progress limit applies", rather than a limit of zero which would refuse.
    iterationMember: true,
    reviewStep: hasReviewStep(item.type),
    blockedByThis: blockedByThis(view, item.id),
    openChildren: openChildrenOf(view, item.id),
  }
}
