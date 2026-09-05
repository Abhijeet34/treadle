// SPDX-License-Identifier: Apache-2.0
// The read that answers "who changed this, and when": one row per recorded change to one
// item, newest first.
//
// Every write already appended an event carrying an actor, and until this command nothing
// printed one, so the audit trail the tool kept was unanswerable through the tool.
// ADR-0011 named this reader when it widened the `item.file` event to carry the fields an
// item was created with; those fields are what the `what` column reports.
//
// The row grammar allows one space-bearing column (F3) and the actor is the caller's own
// string, so the actor is that column. Everything to its left is projected through `cell`,
// because an event file is a committed file a hand edit can reach and a value carrying a
// space would shift every field after it.

import { isKnownField, type ItemId } from '../../domain/index.ts'
import { columnsOf, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Store, StoreEvent } from '../ports/store.ts'
import { readWorkspace } from './context.ts'
import { notFound } from './items.ts'
import { storeRefusal } from './refusal.ts'

export const HISTORY_SHAPE: ResultShape = {
  command: 'history',
  version: 1,
  effect: 'read',
  summary: 'List every recorded change to one item, newest first, with who made it.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'sort', type: 'string' },
    {
      kind: 'block',
      key: 'events',
      columns: [{ name: 'at' }, { name: 'kind' }, { name: 'op' }, { name: 'what' }, { name: 'by', text: true }],
    },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'more', type: 'integer' },
    { kind: 'scalar', key: 'page', type: 'string' },
  ],
}

/** The longest a projected cell may be, which is the field dictionary's own line bound. */
const MAX_CELL = 200

/**
 * A value from a stored event as a non-final row cell. A cell that carries whitespace would
 * split into two fields and move every value after it, so it is reported absent instead:
 * `doctor` is the surface for a file that says something no write path would have accepted.
 */
function cell(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CELL && !/\s/.test(value)
    ? value
    : '-'
}

/** The guards a move was pushed past. A passing guard is every row's answer and is noise. */
function overridden(event: StoreEvent): readonly string[] {
  if (!Array.isArray(event.guards)) return []
  return (event.guards as readonly { guard?: unknown; overridden?: unknown }[])
    .filter((guard) => guard.overridden === true)
    .map((guard) => `override=${cell(guard.guard)}`)
}

/**
 * Ops whose `after` is the value that was written rather than a snapshot keyed by field
 * name. `evidence add` appends one pointer, so its `after` is the pointer; the field it
 * moved is still one field, and this is where that is said once rather than at the reader.
 */
const FIELD_OF_OP: Readonly<Record<string, string>> = { 'item.evidence.add': 'evidence' }

/** The item fields one event moved, in the order the event recorded them. */
function movedBy(event: StoreEvent): readonly string[] {
  const named = FIELD_OF_OP[event.op]
  if (named !== undefined) return [named]
  const snapshot = event.after ?? event.before
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return []
  const keys = Object.keys(snapshot as Record<string, unknown>)
  const known = keys.filter((key) => isKnownField(key))
  // A key this build does not know is counted rather than printed: it is text from a file
  // that no dictionary bounds, and the count is the part a reader can act on.
  return known.length === keys.length ? known : [...known, `+${keys.length - known.length}`]
}

/**
 * What one event recorded: the fields it moved, then the two facts that are not fields.
 * Field names rather than values, because a value may carry a space and because the values
 * are the record `show` already prints and the divergence `doctor` H20 already compares.
 * The cell is bounded like every other, and a name dropped to stay inside it is counted.
 */
function whatOf(event: StoreEvent): string {
  const parts = [...movedBy(event)]
  if (typeof event.outcome === 'string') parts.push(`outcome=${cell(event.outcome)}`)
  parts.push(...overridden(event))
  if (parts.length === 0) return '-'

  const kept: string[] = []
  let width = 0
  for (const part of parts) {
    // The `+n` that replaces the rest needs room of its own, so the fit is tested against a
    // cell that already carries it.
    if (width + part.length + 1 > MAX_CELL - 6) break
    kept.push(part)
    width += part.length + 1
  }
  return kept.length === parts.length ? parts.join(',') : [...kept, `+${parts.length - kept.length}`].join(',')
}

export type HistoryRequest = {
  readonly limit: number
  /** The event id to resume at, which is the id the previous page's `page` line named. */
  readonly cursor?: string
}

export async function history(
  store: Store, id: ItemId, request: HistoryRequest,
): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('history', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  if (view.value.byId.get(id) === undefined) return notFound('history', workspace, view.value, id)

  const events = await store.events({ entity: id })
  if (!events.ok) return storeRefusal('history', 'read', events.error, workspace)
  // The store returns the log in the order it was written; the question this command answers
  // is almost always about the most recent change, so the newest is the first row.
  const ordered = [...events.value].reverse()

  const at = request.cursor === undefined ? 0 : ordered.findIndex((event) => event.id === request.cursor)
  const from = at < 0 ? 0 : at
  const page = ordered.slice(from, from + request.limit)

  const block: Block = {
    columns: columnsOf(HISTORY_SHAPE, 'events'),
    shown: page.length,
    total: ordered.length,
    rows: page.map((event): Row => ({
      at: cell(event.at),
      kind: cell(event.actor_kind),
      op: cell(event.op),
      what: whatOf(event),
      by: event.actor,
    })),
  }

  const data: Record<string, Value> = { item: id, sort: 'at desc' }
  data['events'] = block
  if (ordered.length === 0) data['none'] = `${id} has no recorded change`

  const remaining = ordered.length - (from + page.length)
  if (remaining > 0) {
    data['more'] = remaining
    const following = ordered[from + page.length]
    if (following !== undefined) data['page'] = `treadle history ${id} --cursor ${following.id}`
  }
  return okResult(HISTORY_SHAPE, { workspace, data })
}
