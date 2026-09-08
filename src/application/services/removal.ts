// SPDX-License-Identifier: Apache-2.0
// The one use case that takes a record out of the store.
//
// What "removed" means here is settled in ADR-0024 and is the whole reason this file is
// short: the record leaves its month shard, and the append-only event log is not touched by
// it. Every event that record ever earned stays in the log, `history <id>` reads them back
// after the removal because the log is keyed by entity id rather than by a record existing,
// and one more event is appended saying the record went, who removed it, why, and what its
// audited fields were at that instant. The trail therefore gains a line and loses none.
//
// The guards below are all one rule read two ways: a removal is refused exactly where it
// would leave another record naming something the store no longer holds, because that is the
// shape `doctor` raises as `H24`, `H26`, `H28` and `H30`, and a write that manufactures a
// finding is a write the tool should not perform. An item's own state gates nothing, because
// no state makes another record depend on it; what does is a closed sprint that counted it,
// an edge pointing at it, or a child parented to it.
//
// These guards decide against a read taken before the store's lock, so they cannot see a
// neighbour written after it. That half of the rule is the store's, as `S17` inside the lock
// (ADR-0025); this half is what gives a caller the cause and the line that clears it.

import { fieldsOf, overLength, MAX_REASON, type ItemId, type WorkItem } from '../../domain/index.ts'
import { errorResult, okResult, type ResultObject, type ResultShape, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import { readWorkspace, wholeItem, type WorkspaceView } from './context.ts'
import { notFound } from './items.ts'
import { AUDITED_FIELDS, auditedSnapshot, diffOf, makeEvent, type Actor, type Target } from './mutation.ts'
import { storeRefusal } from './refusal.ts'

export const REMOVE_SHAPE: ResultShape = {
  command: 'remove',
  version: 1,
  effect: 'mutate',
  summary: 'Take one mis-filed item out of the records, keeping every event it earned in the log.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'type', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'integer' },
    { kind: 'text', key: 'title', whole: true },
    // F12: every entry ends in a value the caller wrote, so the line carries the
    // untrusted-content marker rather than reading as the tool's own speech.
    { kind: 'list', key: 'set', data: true },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
  ],
}

export type RemoveRequest = {
  readonly id: ItemId
  readonly reason?: string
  /** The confirmation `--yes` carries; a removal without it is refused, as `init`'s is. */
  readonly confirmed: boolean
  readonly actor: Actor
}

function refusal(workspace: string, rule: string, entity: string, cause: string, fix: readonly string[]): ResultObject {
  return errorResult({ code: 'VALIDATION', command: 'remove', workspace, effect: 'mutate', rule, entity, cause, fix })
}

/** One record that names this item, as the sentence a refusal reads and the line that clears it. */
type Reference = { readonly cause: string; readonly fix: readonly string[] }

/**
 * The first record that would be left naming this item, or `undefined`. The four kinds are
 * the four ways one record can hold another's id: a closed sprint's committed set, a stored
 * relation edge, a child's parent, and a retrospective's action list.
 *
 * A closed sprint is read two ways because two eras of record exist. This build's close
 * writes `carried` and `finished`, so a member is named by one of them; a sprint an older
 * build closed wrote neither for its finished members, and `committedTo` recomputes that
 * sprint's set from what still points at it, so `sprint_id` is the membership there. Reading
 * only the frozen list let a member of a legacy closed sprint be removed, which shrinks a
 * count a team already read; reading only `sprint_id` misses every carried member, which is
 * `H28`. Both are read.
 *
 * An open sprint is deliberately not among them. Its committed set is what points at it,
 * recomputed on every read, so a member leaving takes nothing with it.
 */
function namedBy(view: WorkspaceView, item: WorkItem): Reference | undefined {
  const { id } = item
  for (const sprint of view.sprints) {
    if (sprint.state !== 'closed') continue
    const recorded = [...(sprint.carried ?? []), ...(sprint.finished ?? [])]
    if (!recorded.includes(id) && item.sprint_id !== sprint.id) continue
    return {
      cause: `${id} is a member of ${sprint.id}, which is closed, and a closed sprint's committed set is a record that its tally was counted over`,
      fix: [`treadle sprints ${sprint.id}`],
    }
  }
  const edge = view.relations.relations.find((relation) => relation.target === id)
  if (edge !== undefined) {
    return {
      cause: `${edge.source} ${edge.kind} ${id}, and removing ${id} would leave that edge naming no record`,
      fix: [`treadle relation remove ${edge.source} ${edge.kind} ${id}`, `treadle explain ${id}`],
    }
  }
  const child = (view.hierarchy.childrenOf.get(id) ?? [])[0]
  if (child !== undefined) {
    return {
      cause: `${child} has ${id} as its parent, and removing ${id} would leave that record naming no parent`,
      fix: [`treadle set ${child} parent_id=`, `treadle backlog --fields id,type,state,title`],
    }
  }
  // A retrospective's action list is the one place the retro-to-chore link is stored, so a
  // chore taken out from under it leaves the record unable to say what it produced. There is
  // no fix line that edits the list, because no command edits a filed retrospective: the
  // record is the answer, and `transition <id> cancelled` is what stops the work instead.
  const ceremony = view.ceremonies.find((held) => (held.actions ?? []).includes(id))
  if (ceremony !== undefined) {
    return {
      cause: `${ceremony.id} names ${id} in its action list, and a retrospective's actions are the record of what it produced`,
      fix: [`treadle ceremonies ${ceremony.id}`, `treadle transition ${id} cancelled`],
    }
  }
  return undefined
}

/**
 * What the removal changes that the caller did not name. Neither is a reason to refuse:
 * an open sprint's set is derived, and an item stops blocking whatever it blocked, which is
 * the same thing cancelling it would have done. Both are said out loud, because a silent
 * change to a sprint a team is running or to another item's blocked state is the class of
 * quiet answer this tool refuses everywhere else.
 */
function consequence(view: WorkspaceView, item: WorkItem): string | undefined {
  const parts: string[] = []
  const sprint = item.sprint_id === undefined ? undefined : view.sprintById.get(item.sprint_id)
  // The state is read rather than assumed. `namedBy` refuses a member of a closed sprint
  // before this runs, so the sentence below is only ever true; asserting "is open" of
  // whatever the id resolved to is how it would stop being true after the next change.
  if (sprint !== undefined && sprint.state === 'open') {
    const remaining = view.items.filter((other) => other.sprint_id === sprint.id && other.id !== item.id).length
    parts.push(`${sprint.id} is open and now holds ${remaining} ${remaining === 1 ? 'item' : 'items'}`)
  }
  const freed = view.relations.relations
    .filter((relation) => relation.kind === 'blocks' && relation.source === item.id)
    .map((relation) => relation.target)
    .filter((target) => view.byId.has(target))
  if (freed.length > 0) parts.push(`${freed.join(',')} ${freed.length === 1 ? 'is' : 'are'} no longer blocked by it`)
  return parts.length === 0 ? undefined : parts.join('; ')
}

export async function removeItem(
  target: Target, clock: Clock, ids: IdGenerator, request: RemoveRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('remove', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const whole = await wholeItem(store, view.value, request.id)
  if (!whole.ok) return storeRefusal('remove', 'mutate', whole.error, workspace)
  const item = whole.value
  if (item === undefined) return notFound('remove', 'mutate', workspace, view.value, request.id)

  if (request.reason === undefined || request.reason.trim() === '') {
    return refusal(workspace, 'C1', item.id,
      'a removal records why the record should not exist, and none was given',
      [`treadle remove ${item.id} --reason "<why>" --yes`])
  }
  if (request.reason.length > MAX_REASON) {
    return refusal(workspace, 'T7', item.id, overLength('a reason', MAX_REASON, request.reason.length), ['treadle help remove'])
  }
  const named = namedBy(view.value, item)
  if (named !== undefined) {
    return errorResult({
      code: 'GUARD_REFUSED', command: 'remove', workspace, effect: 'mutate', rule: 'R6', entity: item.id,
      cause: named.cause, fix: named.fix,
    })
  }
  // Last of the refusals, so `--dry-run` reaches every guard above it and answers what the
  // real run would do; the confirmation is about performing the write, and a dry run and a
  // preview perform none. `init` is the other command with a confirmation and it reads the
  // same way: a refusal naming the line to run, never a prompt.
  if (mode === 'apply' && !request.confirmed) {
    return refusal(workspace, 'C1', item.id,
      `removing ${item.id} takes the record out of ${workspace} and no command puts it back; the log keeps its events either way`,
      // A.6: no caller text in a fix line, so the reason they already wrote is a placeholder
      // here as it is everywhere else the tool offers a line back.
      [`treadle remove ${item.id} --reason "<why>" --dry-run`, `treadle remove ${item.id} --reason "<why>" --yes`])
  }

  // The audited fields only, in the dictionary's order. The prose a record carries is not
  // echoed into a result or into the log for the same reason `auditedSnapshot` does not echo
  // it on a `set`: it would duplicate the record it was copied from, and git holds the
  // record's own bytes, which is where the prose survives a removal.
  const audited = fieldsOf(item.type).filter((field) => (AUDITED_FIELDS as readonly string[]).includes(field))
  const changes = diffOf(item, {} as WorkItem, audited)
  const data: Record<string, Value> = {
    item: item.id, type: item.type, state: item.state, v: item.version, title: item.title,
    set: changes.map((change) => `${change.field} ${change.before} -> -`),
  }
  const said = consequence(view.value, item)
  if (said !== undefined) data['note'] = said
  if (mode === 'preview') {
    return okResult(REMOVE_SHAPE, {
      workspace, txn: null, changed: 0,
      data: { ...data, preview: 1, store: view.value.identity.path ?? workspace, note: 'nothing evaluated; use --dry-run for the outcome' },
    })
  }

  const now = clock.now()
  const txn = ids.txn()
  const eventId = ids.event()
  // The transaction names no read set, and that is not the gap it used to be. `guardReads`
  // exists for a decision made against a neighbour that then moves, and every guard above is
  // about a neighbour that does not exist yet, which no `reads` entry can name. The store
  // closes that window under the lock it already takes: `S17` refuses this removal if any
  // record still names the id when the write is about to land (ADR-0025). `R6` above stays
  // because it fires first, with the friendlier cause and the fix lines, in the ordinary
  // case where the neighbour was already there.
  const applied = await store.apply({
    txn,
    writes: [],
    removes: [{ id: item.id, ifVersion: item.version }],
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: item.id, op: 'item.remove',
      // The whole audited record on the `before` side and nothing on the `after`: a reading
      // of the log alone recovers what was removed, which is what makes the trail complete
      // without the shard the record left.
      before: auditedSnapshot(changes, 'before'),
      reason: request.reason, txn, command: 'remove',
    })],
  })
  if (!applied.ok) return storeRefusal('remove', 'mutate', applied.error, workspace)
  if (mode === 'dry-run') {
    return okResult(REMOVE_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, dry_run: 1, would_exit: 0 } })
  }
  return okResult(REMOVE_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}
