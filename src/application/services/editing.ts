// SPDX-License-Identifier: Apache-2.0
// The field editor: the one command that writes a stored field after the item was filed.
//
// It exists because the gates already demanded fields nothing could set. A bug filed without
// `expected` and `actual` - which is the normal order, since you file before you know the
// details - was refused at the ready gate with `set expected on <id>`, and no such command
// existed. `file --set` writes at creation only, `transition` moves a state, `mark` moves the
// two audited markers and `evidence` appends a pointer, so the item was unadvanceable for
// good and `doctor` still called the workspace clean. Every part worked in isolation.
//
// What it is not is a way past a gate. `severity` and `priority` stay with `mark`, because
// that command records the reason a defect was raised or lowered; the lifecycle fields stay
// with `transition`. Which command owns which field is `writerOf` in the dictionary rather
// than a table here, because the gate remedies read the same fact: a rule that said
// `set severity` would name a command that refuses the field. A field the dictionary gains
// with no entry there is `set`'s, which is the default that cannot re-create the dead end.

import {
  WORK_ITEM_TYPES,
  canonicalField,
  fieldsOf,
  isKnownField,
  validateWorkItem,
  writerOf,
  type ItemId,
  type WorkItem,
} from '../../domain/index.ts'
import { errorResult, okResult, type ResultObject, type ResultShape, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import { readWorkspace } from './context.ts'
import { coerce, notFound } from './items.ts'
import { auditedSnapshot, diffOf, makeEvent, type Actor, type Target } from './mutation.ts'
import { storeRefusal } from './refusal.ts'

export const SET_SHAPE: ResultShape = {
  command: 'set',
  version: 1,
  effect: 'mutate',
  summary: 'Write one or more stored fields of an item that is already filed.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'string' },
    { kind: 'list', key: 'set' },
    { kind: 'scalar', key: 'already', type: 'string' },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
  ],
}

/** Every field `set` writes: the whole dictionary, less what another command owns. */
export const SETTABLE_FIELDS: readonly string[] = [
  ...new Set(WORK_ITEM_TYPES.flatMap((type) => fieldsOf(type))),
].filter((field) => writerOf(field).kind === 'set').sort()

export type SetRequest = {
  readonly id: ItemId
  /** `<field>=<value>` as written, so a refusal can name the token the caller typed. */
  readonly assignments: readonly string[]
  readonly actor: Actor
}

function refusal(workspace: string, rule: string, entity: string, cause: string, fix: readonly string[]): ResultObject {
  return errorResult({ code: 'VALIDATION', command: 'set', workspace, effect: 'mutate', rule, entity, cause, fix })
}

/** Why this field cannot be written here, or `undefined`. */
function unsettable(field: string, item: WorkItem): { readonly cause: string; readonly fix: readonly string[] } | undefined {
  const writer = writerOf(field)
  if (writer.kind === 'command') {
    const usage = writer.usage.replaceAll('<id>', item.id)
    return { cause: `${field} is not set here; ${usage}`, fix: [usage] }
  }
  if (writer.kind === 'none') {
    return { cause: `${field} is not set here; ${writer.why}`, fix: [`treadle show ${item.id}`] }
  }
  if (!isKnownField(field)) {
    return {
      cause: `${field} is not a field of any work item`,
      fix: [`treadle set ${item.id} ${SETTABLE_FIELDS.slice(0, 3).join('=<value> ')}=<value>`],
    }
  }
  if (!fieldsOf(item.type).includes(field)) {
    return { cause: `${field} is not a field of a ${item.type}`, fix: [`treadle show ${item.id}`] }
  }
  return undefined
}

export async function setFields(
  target: Target, clock: Clock, ids: IdGenerator, request: SetRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('set', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const item = view.value.byId.get(request.id)
  if (item === undefined) return notFound('set', workspace, view.value, request.id)

  if (request.assignments.length === 0) {
    return refusal(workspace, 'C1', item.id,
      'set writes one or more field=value assignments, and none was given',
      [`treadle set ${item.id} <field>=<value>`])
  }

  const wanted = new Map<string, string>()
  for (const assignment of request.assignments) {
    const at = assignment.indexOf('=')
    if (at <= 0) {
      return refusal(workspace, 'C1', item.id,
        `${assignment} is not a field=value assignment`,
        [`treadle set ${item.id} <field>=<value>`])
    }
    // Through `canonicalField`, so the spelling `show` printed is a spelling `set` takes.
    const field = canonicalField(assignment.slice(0, at))
    const why = unsettable(field, item)
    if (why !== undefined) return refusal(workspace, 'V5', item.id, why.cause, why.fix)
    wanted.set(field, assignment.slice(at + 1))
  }

  const draft: Record<string, unknown> = { ...item }
  for (const [field, value] of wanted) draft[field] = coerce(field, value)
  const after = draft as unknown as WorkItem

  // The dictionary's order rather than the order the flags were written, so the same change
  // made two ways prints the same lines.
  const ordered = fieldsOf(item.type).filter((field) => wanted.has(field))
  const changes = diffOf(item, after, ordered)
  if (changes.length === 0) {
    return okResult(SET_SHAPE, {
      workspace, txn: null, changed: 0,
      data: { already: item.id, v: String(item.version) },
    })
  }

  const now = clock.now()
  const valid = validateWorkItem(after, { now })
  if (!valid.ok) {
    return refusal(workspace, valid.error.rule ?? 'V4', item.id, valid.error.message, [`treadle show ${item.id}`])
  }

  const set = changes.map((change) => `${change.field} ${change.before} -> ${change.after}`)
  if (mode === 'preview') {
    return okResult(SET_SHAPE, {
      workspace, txn: null, changed: 0,
      data: {
        preview: 1, item: item.id, store: view.value.identity.path ?? workspace,
        set, note: 'nothing evaluated; use --dry-run for the outcome',
      },
    })
  }

  const txn = ids.txn()
  const eventId = ids.event()
  const applied = await store.apply({
    txn,
    writes: [{ item: after, ifVersion: item.version }],
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: item.id, op: 'item.set',
      before: auditedSnapshot(changes, 'before'), after: auditedSnapshot(changes, 'after'),
      txn, command: 'set',
    })],
  })
  if (!applied.ok) return storeRefusal('set', 'mutate', applied.error, workspace)

  const written = applied.value.writes[0]
  const data: Record<string, Value> = {
    item: item.id,
    v: `${item.version} -> ${written?.version ?? item.version + 1}`,
    set,
  }
  if (mode === 'dry-run') {
    return okResult(SET_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, dry_run: 1, would_exit: 0 } })
  }
  return okResult(SET_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}
