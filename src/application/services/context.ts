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
  type GateContext,
  type GateItem,
  type GateVerdict,
  type HierarchyGraph,
  type ItemId,
  type RelationGraph,
  type Sprint,
  type TransitionContext,
  type WorkItem,
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
  /**
   * Every sprint, whole. There are tens of them where there are tens of thousands of items,
   * and a sprint's record is a few lines, so the read that projects items to their summary
   * fields carries the sprints as they are (ADR-0016).
   */
  readonly sprints: readonly Sprint[]
  readonly sprintById: ReadonlyMap<string, Sprint>
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
  const sprints = await store.sprints()
  if (!sprints.ok) return sprints
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
      sprints: sprints.value,
      sprintById: new Map(sprints.value.map((sprint) => [sprint.id, sprint])),
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

/**
 * Every blocked item to its active blockers, from one pass over the graph. `activeBlockers`
 * above walks the whole relation list per call, which is the right cost for the one item a
 * command acts on and a quadratic one for a read over every item; `board` is that read.
 * An id absent here has no active blocker, and the blockers keep the graph's order, which
 * is the order `activeBlockers` returns them in.
 */
export function activeBlockerIndex(view: WorkspaceView): ReadonlyMap<ItemId, readonly ItemId[]> {
  const index = new Map<ItemId, ItemId[]>()
  for (const relation of view.relations.relations) {
    if (relation.kind !== 'blocks') continue
    const state = view.byId.get(relation.source)?.state
    if (state === undefined || state === 'done' || state === 'cancelled') continue
    const blockers = index.get(relation.target)
    if (blockers === undefined) index.set(relation.target, [relation.source])
    else blockers.push(relation.source)
  }
  return index
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

/** What a gate rule or a guard is told about a neighbour: enough to name its next move. */
function gateItems(view: WorkspaceView, ids: readonly ItemId[]): readonly GateItem[] {
  return ids.flatMap((id) => {
    const item = view.byId.get(id)
    return item === undefined ? [] : [{ id: item.id, type: item.type, state: item.state, reviewStep: hasReviewStep(item.type) }]
  })
}

function childrenGates(view: WorkspaceView, id: ItemId): readonly GateItem[] {
  return gateItems(view, view.hierarchy.childrenOf.get(id) ?? [])
}

/** The active blockers of `id` that are impediments, whose proposed resolution a refusal reads back. */
export function openImpedimentsOf(view: WorkspaceView, id: ItemId): readonly ItemId[] {
  return activeBlockers(view, id).filter((blocker) => view.byId.get(blocker)?.type === 'impediment')
}

export function gateContextFor(view: WorkspaceView, item: WorkItem): GateContext {
  return {
    item,
    blockers: gateItems(view, activeBlockers(view, item.id)),
    children: childrenGates(view, item.id),
    reviewStep: hasReviewStep(item.type),
  }
}

export function readyVerdict(view: WorkspaceView, item: WorkItem, gate: Gate = DEFAULT_READY_GATE): GateVerdict {
  return evaluateGate(gate, gateContextFor(view, item))
}

export function doneVerdict(view: WorkspaceView, item: WorkItem, gate: Gate = DEFAULT_DONE_GATE): GateVerdict {
  return evaluateGate(gate, gateContextFor(view, item))
}

export function openChildrenOf(view: WorkspaceView, id: ItemId): readonly GateItem[] {
  return childrenGates(view, id).filter((child) => child.state !== 'done' && child.state !== 'cancelled')
}

export function transitionContextFor(view: WorkspaceView, item: WorkItem): TransitionContext {
  return {
    item,
    readyGate: readyVerdict(view, item),
    doneGate: doneVerdict(view, item),
    blockers: gateItems(view, activeBlockers(view, item.id)),
    // The board is a projection that stores nothing (ADR-0018): there is no column to be
    // over, so `column` stays absent and G3 passes, and no membership to lack, so G4's "on
    // the board" is true of every item and the guard stays disarmed. Arming either takes a
    // stored limit or a stored membership, which is `config`, specified and not built.
    iterationMember: true,
    reviewStep: hasReviewStep(item.type),
    blockedByThis: blockedByThis(view, item.id),
    openChildren: openChildrenOf(view, item.id),
  }
}
