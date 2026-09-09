// SPDX-License-Identifier: Apache-2.0
// One read of the store, then every derived fact a command needs off that one read. The
// domain layer takes derived facts as arguments, so this file is where they are derived:
// the hierarchy graph, the gate contexts, the blocker lists and the transition context.
//
// The relation graph is read off the records' own `relations` sections, so every guard and
// gate rule that reads blockers is fed from the one stored direction of each edge.

import {
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
  type TransitionContext,
  type WorkItem,
  type WorkItemState,
  type WorkItemSummary,
  type WorkItemType,
  type WorkspaceConfig,
} from '../../domain/index.ts'
import { storeFail, storeOk, type Finding, type ItemRead, type Store, type StoreEvent, type StoreIdentity, type StoreResult } from '../ports/store.ts'

/**
 * Types whose work passes through review, which is guard G5's input, read from the
 * workspace's `review_step` key. The compiled-in default is `story, bug`; a workspace that
 * wants its epics reviewed configures `review_step` to say so.
 */
export function hasReviewStep(config: WorkspaceConfig, type: WorkItemType): boolean {
  return config.review_step.includes(type)
}

/**
 * The states an item is being worked in. `on_hold` is one of them: the work is somebody's and
 * a hold is a pause in it, so leaving it out would let an assignee hand the record over from a
 * hold and accept it back.
 */
const WORKED_IN: ReadonlySet<string> = new Set(['in_progress', 'in_review', 'on_hold'])

/** What one item's log has said so far about who held it; see `foldWorkTrail`. */
export type WorkTrail = {
  state?: string
  assignee?: string
  /** Lazily created, so an item nobody was ever assigned costs one object and no set. */
  names?: Set<string>
}

/**
 * Who the log says did the work on one item, folded event by event. `DOD3` read `assignee` as
 * the record holds it NOW, and a current value is one write away from anything: the assignee
 * reassigned the ITEM and accepted its own work at `guards G6 pass`. Both the gate and the
 * audit read the trail from here, so the write-time guard and the load-time finding cannot
 * disagree about who did the work.
 *
 * `state` and `assignee` come off the `after` snapshots - `item.file` carries the fields an
 * item was created with and `item.set` and `item.transition` carry each later change - and
 * `-` is the snapshot's own marker for a field nothing set. A removal clears the trail, since
 * the log keeps a removed record's events under the id (ADR-0024) and the record filed under
 * it afterwards inherits nobody.
 *
 * Who RAN the commands is deliberately not in the trail: it would refuse the third party who
 * accepts work the record attributes to somebody else, which `DOD3`'s sentence allows.
 * ADR-0033 argues that and names the launder it leaves open.
 */
export function foldWorkTrail(trail: WorkTrail, event: StoreEvent): void {
  if (event.op === 'item.remove') {
    delete trail.state
    delete trail.assignee
    delete trail.names
    return
  }
  const after = event.after
  if (typeof after !== 'object' || after === null) return
  const fields = after as Record<string, unknown>
  const state = fields['state']
  if (typeof state === 'string') trail.state = state
  const assignee = fields['assignee']
  if (typeof assignee === 'string') {
    if (assignee === '-') delete trail.assignee
    else trail.assignee = assignee
  }
  if (trail.assignee !== undefined && trail.state !== undefined && WORKED_IN.has(trail.state)) {
    (trail.names ??= new Set()).add(trail.assignee)
  }
}

/** The names one item's whole log leaves in its trail, which is DOD3's `workedBy`. */
export function workedBy(events: readonly StoreEvent[]): readonly string[] {
  const trail: WorkTrail = {}
  for (const event of events) foldWorkTrail(trail, event)
  return trail.names === undefined ? [] : [...trail.names]
}

export type WorkspaceView = {
  readonly identity: StoreIdentity
  /**
   * The workspace's own configuration, off the same record the identity came from: the
   * review step, the ranking weights, the column limits, the aging threshold and
   * the two gates. Every consumer reads it from here rather than from a constant of its own,
   * which is what makes the Policy seam's second implementation data instead of a code path.
   */
  readonly config: WorkspaceConfig
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
const SERVED_ANYWAY: ReadonlySet<string> = new Set([
  'H16', 'S12',
  // The two configured-policy findings. Both are about work rather than about bytes: an
  // item over the aging threshold and a column over its limit are records the store serves
  // whole, and a limit lowered under work already in flight produces the second on a
  // workspace nothing is wrong with. A `doctor` that exited 7 for either would tell a CI job
  // that a slow story is the same event as a truncated shard.
  'H03', 'H04',
  // The audit note, by the same test. `H19` names who wrote a field on an item they are
  // assigned; the record serves whole and nothing about the store is wrong, and ADR-0011
  // already says of it that "it does not refuse: the log says who, and the person reading the
  // pull request decides". The code disagreed, because every rule not listed here refuses.
  // That mattered little while `H19` read `item.mark` alone and matters now that it reads an
  // assignee naming their own reviewer, which is an ordinary thing to do: `doctor` would have
  // exited 7 on a workspace with nothing wrong with it, which is the trap `H27` was narrowed
  // to escape. The move that stops a self-review is `DOD3`, at write time, where a refusal
  // belongs; this stays a line a reader weighs.
  'H19',
])

/** Takes a store `Finding` or a `doctor` one: both name a rule and the rule is the decision. */
export function hidesContent(finding: { readonly rule: string }): boolean {
  return !SERVED_ANYWAY.has(finding.rule)
}

/** The refusal a set of findings earns, naming the first hole and counting the rest. */
function hiddenRefusal(findings: readonly Finding[]): StoreResult<never> | undefined {
  const hidden = findings.filter(hidesContent)
  const first = hidden[0]
  if (first === undefined) return undefined
  const rest = hidden.length === 1 ? 'that finding hides a record' : `${hidden.length} findings hide records`
  return storeFail(
    'INTEGRITY', first.rule,
    `${first.file} line ${first.line}: ${first.reason}; ${rest} this workspace holds, so no answer over it is whole`,
    first.id === undefined ? [] : [first.id],
  )
}

/**
 * What reading the log said about the log, checked after a command has read it.
 *
 * The shards are parsed on every command because every answer is over the record set; the
 * log is parsed only where a command answers from it, so a line the log could not read is
 * found by `history`, `explain` and `doctor` rather than by every command paying for a scan
 * of a file it never looks at. Asked here, after that read, it earns the same exit-7
 * refusal a damaged log has always earned.
 */
export async function logIsWhole(store: Store): Promise<StoreResult<undefined>> {
  const findings = await store.findings()
  if (!findings.ok) return findings
  return hiddenRefusal(findings.value) ?? storeOk(undefined)
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

  const refusal = hiddenRefusal(findings.value)
  if (refusal !== undefined) return refusal

  return {
    ok: true,
    value: {
      identity: identity.value,
      config: identity.value.config,
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

/**
 * Every blocked item to its active blockers, from one pass over the graph. `activeBlockers`
 * above walks the whole relation list per call, which is the right cost for the one item a
 * command acts on and a quadratic one for a read over every item; `next` is that read.
 * An id absent here has no active blocker, and the blockers keep the graph's order, which
 * is the order `activeBlockers` returns them in.
 */
export function activeBlockerIndex(view: WorkspaceView): ReadonlyMap<ItemId, readonly ItemId[]> {
  const index = new Map<ItemId, ItemId[]>()
  for (const relation of view.relations.relations) {
    if (relation.kind !== 'blocks') continue
    const state = view.byId.get(relation.source)?.state
    if (state === undefined || state === 'done' || state === 'cancelled') continue
    // The same clause `blockersOf` carries: finished work is not held up by anything, so a
    // revived blocker never puts a done or cancelled item back on a blocked list.
    const blocked = view.byId.get(relation.target)?.state
    if (blocked === 'done' || blocked === 'cancelled') continue
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

/**
 * `blockedByThis` for every blocker at once, from one pass over the graph, for the same
 * reason `activeBlockerIndex` exists: `next` scores every ready item and asked the whole
 * relation list twice per item, 1,250 ms of a 1,885 ms call over 5,000 edges. An id absent
 * here blocks nothing active.
 */
export function blockedByThisIndex(view: WorkspaceView): ReadonlyMap<ItemId, readonly ItemId[]> {
  const index = new Map<ItemId, ItemId[]>()
  for (const relation of view.relations.relations) {
    if (relation.kind !== 'blocks') continue
    const state = view.byId.get(relation.target)?.state
    if (state === undefined || state === 'done' || state === 'cancelled') continue
    const blocked = index.get(relation.source)
    if (blocked === undefined) index.set(relation.source, [relation.target])
    else blocked.push(relation.target)
  }
  return index
}

/** What a gate rule or a guard is told about a neighbour: enough to name its next move. */
function gateItems(view: WorkspaceView, ids: readonly ItemId[]): readonly GateItem[] {
  return ids.flatMap((id) => {
    const item = view.byId.get(id)
    return item === undefined ? [] : [{ id: item.id, type: item.type, state: item.state, reviewStep: hasReviewStep(view.config, item.type) }]
  })
}

function childrenGates(view: WorkspaceView, id: ItemId): readonly GateItem[] {
  return gateItems(view, view.hierarchy.childrenOf.get(id) ?? [])
}

/** The active blockers of `id` that are impediments, whose proposed resolution a refusal reads back. */
export function openImpedimentsOf(view: WorkspaceView, id: ItemId): readonly ItemId[] {
  return activeBlockers(view, id).filter((blocker) => view.byId.get(blocker)?.type === 'impediment')
}

/** The original an item is a copy of, when the store holds it; DOR10's input. */
function duplicateOf(view: WorkspaceView, item: WorkItem): GateItem | undefined {
  const edge = (item.relations ?? []).find((relation) => relation.kind === 'duplicates')
  return edge === undefined ? undefined : gateItems(view, [edge.target])[0]
}

/**
 * Who is asking, and what the log says about who did the work, which are DOD3's two inputs
 * beside the record's own `reviewer`. Both are optional and both are threaded from the
 * command surface rather than read from anywhere: this layer has no ambient caller, and a
 * gate told neither decides exactly what it decided before.
 *
 * They travel together because one is useless without the other and because they arrive from
 * different reads - the actor from the invocation, the trail from the event log - and a
 * command that has one and not the other is a command whose done gate disagrees with the
 * transition it is about to refuse.
 */
export type Asker = {
  readonly actor?: string
  readonly workedBy?: readonly string[]
}

function gateContextFor(view: WorkspaceView, item: WorkItem, asker: Asker = {}): GateContext {
  const original = duplicateOf(view, item)
  return {
    item,
    blockers: gateItems(view, activeBlockers(view, item.id)),
    children: childrenGates(view, item.id),
    reviewStep: hasReviewStep(view.config, item.type),
    ...(original === undefined ? {} : { duplicateOf: original }),
    ...(asker.actor === undefined ? {} : { actor: asker.actor }),
    ...(asker.workedBy === undefined ? {} : { workedBy: asker.workedBy }),
  }
}

/**
 * The ready gate this workspace runs, which is the built-in one until its file names
 * another. The gate is an argument to `evaluateGate` either way, so a configured gate and
 * the default reach the one evaluator and `explain` prints exactly what `G1` decided.
 */
export function readyVerdict(view: WorkspaceView, item: WorkItem, asker?: Asker, gate: Gate = view.config.ready_gate): GateVerdict {
  return evaluateGate(gate, gateContextFor(view, item, asker))
}

export function doneVerdict(view: WorkspaceView, item: WorkItem, asker?: Asker, gate: Gate = view.config.done_gate): GateVerdict {
  return evaluateGate(gate, gateContextFor(view, item, asker))
}

function openChildrenOf(view: WorkspaceView, id: ItemId): readonly GateItem[] {
  return childrenGates(view, id).filter((child) => child.state !== 'done' && child.state !== 'cancelled')
}

/**
 * Every record whose state a guard or a gate rule reads when it decides about `item`, at the
 * version the view holds, for the transaction's read set. The guards read neighbours: G2, DOR3
 * and DOD2 the blockers, DOD1, G8 and DOR8 the children, G7 the items this one blocks, DOR10
 * the original it duplicates. A compare-and-set on the item alone left all of them open to
 * the race `relation add` closed with the same read set: a start decided against a done
 * blocker landed after that blocker was reopened, an accept landed after a done child was
 * reopened, and a commit landed after the blocker it read as inactive came back. Every edge is
 * read whatever the neighbour's state, because an inactive neighbour is the one whose move
 * changes the verdict; the store refuses with `S10` if any of them moved.
 */
export function guardReads(view: WorkspaceView, item: WorkItem): readonly ItemRead[] {
  const ids = new Set<ItemId>()
  for (const relation of view.relations.relations) {
    if (relation.kind !== 'blocks') continue
    if (relation.source === item.id) ids.add(relation.target)
    else if (relation.target === item.id) ids.add(relation.source)
  }
  for (const child of view.hierarchy.childrenOf.get(item.id) ?? []) ids.add(child)
  for (const relation of item.relations ?? []) if (relation.kind === 'duplicates') ids.add(relation.target)
  ids.delete(item.id)
  return [...ids].flatMap((id) => {
    const other = view.byId.get(id)
    return other === undefined ? [] : [{ id, version: other.version }]
  })
}

/**
 * `G3`'s input for one target state: how many records already sit in that column, and the
 * configured limit. A state the workspace limits nowhere yields no column at all, which is
 * the shape `TransitionContext` documents as "no limit" and which G3 passes on, so a
 * workspace that configures nothing behaves exactly as ADR-0018 left it.
 */
function columnFor(view: WorkspaceView, to: WorkItemState | undefined): TransitionContext['column'] {
  if (to === undefined) return undefined
  const limit = view.config.wip_limits.get(to)
  if (limit === undefined) return undefined
  const used = view.items.filter((other) => other.state === to).length
  return { name: to, used, limit }
}

/**
 * The facts one transition is decided against. `to` is the state the caller is asking for,
 * which only `G3` reads: the state a move is INTO is the one whose limit binds, and a
 * context built without a target carries none, which is what every non-`start` edge wants.
 * `asker` is who is running the move and who the log says did the work, which `DOD3` reads
 * through `G6`.
 */
export function transitionContextFor(view: WorkspaceView, item: WorkItem, to?: WorkItemState, asker?: Asker): TransitionContext {
  const column = columnFor(view, to)
  return {
    item,
    readyGate: readyVerdict(view, item, asker),
    doneGate: doneVerdict(view, item, asker),
    blockers: gateItems(view, activeBlockers(view, item.id)),
    ...(column === undefined ? {} : { column }),
    reviewStep: hasReviewStep(view.config, item.type),
    blockedByThis: blockedByThis(view, item.id),
    openChildren: openChildrenOf(view, item.id),
  }
}
