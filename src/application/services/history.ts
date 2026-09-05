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
//
// THE `what` COLUMN HAS ONE CONVENTION, AND A NEW OP INHERITS IT. Every part of the cell is
// `name=value` or `name=from->to`, and a bare name never appears. One column carried three
// vocabularies before this rule: `state=in_progress->in_review` from a transition, the bare
// `expected,actual` from a `set` over prose, and the bare word `evidence` from an append that
// named neither the kind of artefact nor what it pointed at. A reader could not tell whether
// `expected,actual` meant those fields moved or that the values were literally those words.
//
// A side the log did not record as a printable token is a marker from the closed set below,
// never a silent omission: `(unset)` for a field that was not set, `(text:<n>)` for the
// character count the log stores in place of prose, and `(?)` for anything else. A stored
// value that would collide with a marker prints as `(?)`, so no record's own content can
// forge one. `outcome=` and `override=` already had this shape, and `test/services/
// history-convention.test.ts` holds every part of every op's cell to it.
//
// `what` names the fields an event moved and the values it moved them between. The names
// alone left "when did this reach in_review, and who moved it there" unanswerable from any
// read surface: `show` has the current state, `explain` has `since` and `from_event`, and
// this column had the word `state`.

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
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'more', type: 'integer' },
    { kind: 'scalar', key: 'page', type: 'string' },
    {
      kind: 'block',
      key: 'events',
      columns: [{ name: 'at' }, { name: 'kind' }, { name: 'op' }, { name: 'what' }, { name: 'by', text: true }],
    },
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
 * name. An append has no before to name, so it takes the convention's `name=value` form; the
 * kind is a closed-set token and always prints, which is the least a reader needs to tell one
 * pointer from another. This is where a future append-shaped op says how it reads.
 */
const VALUE_OF_OP: Readonly<Record<string, {
  readonly field: string
  readonly of: (after: Readonly<Record<string, unknown>>) => string
}>> = {
  'item.evidence.add': {
    field: 'evidence',
    of: (after) => {
      const kind = side(after['kind'])
      const ref = side(after['ref'])
      return ref === UNKNOWN ? kind : `${kind}:${ref}`
    },
  },
}

/**
 * The longest value a move may print per side. An audited value is a state, an instant, a
 * severity or a slug, so this is generous for every one of them while keeping five moved
 * fields inside one cell; a longer value falls back to its field name.
 */
const MAX_VALUE = 40

/** A stored snapshot as a plain field map, or `undefined` when the event carries none. */
function snapshot(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** The three markers a side prints when the log recorded no printable value for it. */
const UNSET = '(unset)'
const UNKNOWN = '(?)'
const PROSE = /^(\d+) chars$/

/**
 * One side of a move as it prints. `-` is the snapshot's own marker for a field that was not
 * set, and it printed as an empty string: `reviewer=->dev` reads as a typo rather than as a
 * field that had no previous value. Every marker is parenthesised, and a stored value that
 * opens with the same glyph is reported unknown rather than allowed to forge one.
 */
function side(value: unknown): string {
  if (value === '-') return UNSET
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE) return UNKNOWN
  const prose = PROSE.exec(value)
  if (prose !== null) return `(text:${prose[1] as string})`
  return /\s/.test(value) || value.startsWith('(') ? UNKNOWN : value
}

/**
 * One moved field as `field=from->to`, or as `field=to` where the event recorded no before at
 * all, which is what a creation is. Neither form is ever a bare name.
 */
function move(
  field: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string {
  const to = side(after?.[field])
  return before === undefined ? `${field}=${to}` : `${field}=${side(before[field])}->${to}`
}

/** The item fields one event moved, in the order the event recorded them. */
function movedBy(event: StoreEvent): readonly string[] {
  const before = snapshot(event.before)
  const after = snapshot(event.after)
  const named = VALUE_OF_OP[event.op]
  if (named !== undefined) {
    return [`${named.field}=${after === undefined ? UNKNOWN : named.of(after)}`]
  }
  const source = after ?? before
  if (source === undefined) return []
  const keys = Object.keys(source)
  const known = keys.filter((key) => isKnownField(key))
  const moves = known.map((key) => move(key, before, after))
  // A key this build does not know is counted rather than printed: it is text from a file
  // that no dictionary bounds, and the count is the part a reader can act on.
  return known.length === keys.length ? moves : [...moves, `unknown=${keys.length - known.length}`]
}

/**
 * What one event recorded: the fields it moved, then the two facts that are not fields.
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
    // The `more=n` that replaces the rest needs room of its own, so the fit is tested against
    // a cell that already carries it.
    if (width + part.length + 1 > MAX_CELL - 12) break
    kept.push(part)
    width += part.length + 1
  }
  return kept.length === parts.length
    ? parts.join(',')
    : [...kept, `more=${parts.length - kept.length}`].join(',')
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
  if (ordered.length === 0) data['none'] = `${id} has no recorded change`

  const remaining = ordered.length - (from + page.length)
  if (remaining > 0) {
    data['more'] = remaining
    const following = ordered[from + page.length]
    if (following !== undefined) data['page'] = `treadle history ${id} --cursor ${following.id}`
  }
  data['events'] = block
  return okResult(HISTORY_SHAPE, { workspace, data })
}
