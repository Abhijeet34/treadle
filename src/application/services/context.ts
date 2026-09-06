// SPDX-License-Identifier: Apache-2.0
// One read of the store, then every derived fact a command needs off that one read. The
// domain layer takes derived facts as arguments, so this file is where they are derived:
// the hierarchy graph, the gate contexts, the blocker lists and the transition context.
//
// The relation graph is read off the records' own `relations` sections, so every guard and
// gate rule that reads blockers is fed from the one stored direction of each edge.

import {
  DEFAULT_DONE_GATE,
  DEFAULT_READY_GATE,
  blockersOf,
  evaluateGate,
  hierarchyFrom,
  relationGraphFrom,
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
  type WorkItemSummary,
  type WorkItemType,
} from '../../domain/index.ts'
import { storeFail, storeOk, type Finding, type Store, type StoreIdentity, type StoreResult } from '../ports/store.ts'

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
  /**
   * Every item the store holds, because a view over fewer is refused before it exists, as
   * the fields a scan reads. The whole record of the one item a command acts on is read by
   * `wholeItem` after this view has established that the id names one; holding every record
   * decoded put the read every command performs at 408 MiB and 1.2 s over 50,000 items, to
   * print a few hundred bytes about one of them. ADR-0014 carries the measurement.
   */
  readonly items: readonly WorkItemSummary[]
  /**
   * A lookup index over `items`, and only that. It used to be the third place a record's
   * identity was decided, because a `Map` keeps the last entry for a repeated key while the
   * store's two owners both refuse one; the map is safe now because neither owner can hand
   * `list` a repeated id. An id absent here is absent from the store, because a record the
   * store holds and does not serve refuses the whole read below rather than reaching a lookup.
   */
  readonly byId: ReadonlyMap<ItemId, WorkItemSummary>
  readonly hierarchy: HierarchyGraph
  readonly relations: RelationGraph
}

/**
 * Findings that report a fact about content the store still serves: a CRLF file the next
 * write normalises, a hierarchy that closes a cycle. Every other finding names content the
 * store holds and does not serve, whether it carries an id (a quarantined record, a duplicated
 * one) or not (a file over its ceiling, at a newer schema, or without its schema line, an event
 * line the log could not read). A rule not listed here is treated as hiding content, which is
 * the loud direction to be wrong in.
 */
const SERVED_ANYWAY: ReadonlySet<string> = new Set(['H16', 'S12'])

export function hidesContent(finding: Finding): boolean {
  return !SERVED_ANYWAY.has(finding.rule)
}

/**
 * The one read every command builds its answer on, and therefore the one place the answer
 * is refused when it could not be whole. ADR-0003 rule 7 says damage to a record never
 * silently changes which records exist; the store keeps that promise by quarantining the
 * record and reporting a finding, and this function keeps it for every command by refusing
 * to hand out a view the finding says is missing something. Every answer depends on the set:
 * a backlog counts it, a gate reads an item's children from it, a new id is chosen against
 * it. A view with a hole is therefore a wrong answer for all of them, not a partial one, so
 * the refusal names the first hole with its file, line and reason, counts the rest, and
 * points at `doctor`, which lists them all.
 */
export async function readWorkspace(store: Store): Promise<StoreResult<WorkspaceView>> {
  const identity = await store.identity()
  if (!identity.ok) return identity
  const items = await store.summaries()
  if (!items.ok) return items
  const findings = await store.findings()
  if (!findings.ok) return findings

  const hidden = findings.value.filter(hidesContent)
  const first = hidden[0]
  if (first !== undefined) {
    const rest = hidden.length === 1 ? 'that finding hides a record' : `${hidden.length} findings hide records`
    return storeFail(
      'INTEGRITY', first.rule,
      `${first.file} line ${first.line}: ${first.reason}; ${rest} this workspace holds, so no answer over it is whole`,
      first.id === undefined ? [] : [first.id],
    )
  }

  return {
    ok: true,
    value: {
      identity: identity.value,
      items: items.value,
      byId: new Map(items.value.map((item) => [item.id, item])),
      hierarchy: hierarchyFrom(items.value),
      relations: relationGraphFrom(items.value),
    },
  }
}

/**
 * The whole record of the one item a command acts on: one index lookup, after the view has
 * established that the id names a record the store serves. Absent means the record left the
 * store between the two reads, which a caller treats exactly as an id it never held.
 */
export async function wholeItem(store: Store, view: WorkspaceView, id: ItemId): Promise<StoreResult<WorkItem | undefined>> {
  if (!view.byId.has(id)) return storeOk(undefined)
  return store.get(id)
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
