// SPDX-License-Identifier: Apache-2.0
// The read that answers "who changed this, and when": one row per recorded change to one
// item, newest first, or to one transaction.
//
// TWO SCOPES, NEVER BOTH. An id is every change to one record across every command; `--txn`
// is every change one command made across every record. An intersection of the two is a
// third question nobody asked and the line is refused, exactly as `board --all --sprint`
// is. The transaction-scoped read is what spends the id a mutation hands back on its own
// envelope: `sprint commit s a b c` answers `ok sprint <ws> tj0vksb 3`, and until this flag
// the only reading of that 3 was one item at a time or the JSONL by hand.
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
//
// WHY IS A SECOND BLOCK. `mark --reason "revenue path"` wrote the reason into the log and no
// rendering returned it: `explain` prints the reason of the event that put the item in its
// current state, and a mark moves no state. A reason cannot be a column of the table above,
// because a row carries exactly one space-bearing field and that is the actor, so it is a
// block of its own keyed on `at` and `op`, which the table above prints.

import { MAX_REASON, isConfigKey, isKnownField, isSafeText, isSprintField, type ItemId } from '../../domain/index.ts'
import { columnsOf, errorResult, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Store, StoreEvent } from '../ports/store.ts'
import { readWorkspace } from './context.ts'
import { DEFAULT_LIMIT, invocation, notFound, type CarriedFlag } from './items.ts'
import { AUDITED_FIELDS } from './mutation.ts'
import { storeRefusal, unknownCursor } from './refusal.ts'

export const HISTORY_SHAPE: ResultShape = {
  command: 'history',
  version: 1,
  effect: 'read',
  summary: 'List every recorded change to one record, or every event one transaction wrote, newest first.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'sort', type: 'string' },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'more', type: 'integer' },
    { kind: 'scalar', key: 'page', type: 'string' },
    // Last of the non-block properties, which is as late as the renderer's blocks-last rule
    // allows and moves nothing already declared: the sentence that says the record this
    // history belongs to is no longer in the store.
    { kind: 'scalar', key: 'note', type: 'string' },
    // `transaction` and not `txn`, which is the one name symmetry with the flag argues for:
    // the envelope already carries a `txn` field meaning the transaction this command wrote,
    // which on a read is always null, and two keys of one object that mean opposite halves
    // of the same word is a trap laid for the reader who reaches for either.
    { kind: 'scalar', key: 'transaction', type: 'string' },
    {
      kind: 'block',
      key: 'events',
      // `what` projects stored values: an assignee, a reviewer, a component, an evidence
      // pointer. Every one of them is written by a caller, and the cell is arity-1 because
      // `side` and `cell` refuse a value carrying whitespace, so it takes the marker
      // without taking the free-text column's placement.
      columns: [{ name: 'at' }, { name: 'kind' }, { name: 'op' }, { name: 'what', data: true }, { name: 'by', text: true }],
    },
    /**
     * Why, for the events on this page that recorded one. It is a block of its own and not a
     * column of the one above because a row carries exactly one space-bearing field, which is
     * the actor, and a reason is prose. Its rows key on `at` and `op`, which the events table
     * prints, so a reader joins the two without a column either table does not already have.
     */
    {
      kind: 'block',
      key: 'reasons',
      columns: [{ name: 'at' }, { name: 'op' }, { name: 'why', text: true }],
    },
  ],
}

/** The longest a projected cell may be, which is the field dictionary's own line bound. */
const MAX_CELL = 200

/**
 * A value from a stored event as a non-final row cell. A cell that carries whitespace would
 * split into two fields and move every value after it, so it is reported absent instead:
 * `doctor` is the surface for a file that says something no write path would have accepted.
 *
 * A value opening with `(` is reported absent for the second reason `side` gives: the markers
 * below are parenthesised, and a committed log a hand edit can reach must not be able to forge
 * one. Measured on a hand-edited log, an event whose entity was the literal string `(unset)`
 * printed `entity=(unset)` in the transaction-scoped `what` cell, which reads as the log
 * having recorded no entity at all. The bound is here rather than at that one caller because
 * the invariant is stated over the whole cell vocabulary, not over one part of it.
 */
function cell(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CELL
    && !/\s/.test(value) && !value.startsWith('(')
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
      const kind = side(after['kind'], 'kind')
      const ref = side(after['ref'], 'ref')
      return ref === UNKNOWN ? kind : `${kind}:${ref}`
    },
  },
  // An add records the edge in `after` and a remove in `before`; the op column says which.
  'item.relation.add': { field: 'relation', of: edgeOf },
  'item.relation.remove': { field: 'relation', of: edgeOf },
}

function edgeOf(snapshot: Readonly<Record<string, unknown>>): string {
  const kind = side(snapshot['kind'], 'kind')
  const other = side(snapshot['other'], 'other')
  return other === UNKNOWN ? kind : `${kind}:${other}`
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
 * Fields whose value is never the `<n> chars` length marker `auditedSnapshot` writes in place
 * of prose, so `side` must never sniff one out of them. Every `AUDITED_FIELDS` entry is
 * recorded verbatim by `auditedSnapshot` and can legitimately read like a count (an assignee
 * literally named "3 chars"); `ref` is not a dictionary field at all and is never put through
 * that length-marker conversion, so a pointer that happens to read "8 chars" is its own value.
 */
const NEVER_PROSE = new Set<string>([...AUDITED_FIELDS, 'ref'])

/**
 * Fields whose value is a comma-joined list of ids. A list over `MAX_VALUE` prints its count
 * rather than `(?)`: a four-id carry-over is 41 characters, and `(?)` said a value existed and
 * nothing else where `(list:4)` says how many, which is the part a reader of a close can act
 * on. `sprints <id>` prints the list itself.
 *
 * The bound is the size and not the kind, which it was for one day: `set x labels=frontend,
 * backend` renders 16 characters, well under the bound, and printed `labels=(list:2)`, hiding
 * the whole content of a change whose whole content is which labels were set. A short list
 * prints verbatim, and a reader splitting the cell on commas tells a continuation from a pair
 * by the `=` a pair always carries.
 */
const LISTED = new Set<string>(['carried', 'finished', 'labels'])

/**
 * The two configuration keys whose value is a list of gate rules, each ending in a sentence.
 * A rule's sentence carries spaces, so the general side rule reports the whole value unknown
 * and says nothing a reader can act on; the count of rules is what a gate change is. It is
 * `(list:n)`'s argument over the separator a gate uses, and it is a separate marker because
 * `rules` is what the refusal, `explain`'s `rules n/m pass` line and the gate itself call them.
 */
const RULED = new Set<string>(['ready_gate', 'done_gate'])

/**
 * One side of a move as it prints. `-` is the snapshot's own marker for a field that was not
 * set, and it printed as an empty string: `reviewer=->dev` reads as a typo rather than as a
 * field that had no previous value. Every marker is parenthesised, and a stored value that
 * opens with the same glyph is reported unknown rather than allowed to forge one.
 */
function side(value: unknown, field: string): string {
  if (value === '-') return UNSET
  if (typeof value !== 'string' || value.length === 0) return UNKNOWN
  if (RULED.has(field)) return `(rules:${value.split('|').length})`
  if (value.length > MAX_VALUE) {
    return LISTED.has(field) && value.includes(',') && !/\s/.test(value)
      ? `(list:${value.split(',').length})`
      : UNKNOWN
  }
  const prose = NEVER_PROSE.has(field) ? null : PROSE.exec(value)
  if (prose !== null) return `(text:${prose[1] as string})`
  return /\s/.test(value) || value.startsWith('(') ? UNKNOWN : value
}

/**
 * One moved field as `field=from->to`, or as `field=value` where the event recorded one side
 * only: no before at all is a creation, and no after at all is a removal, whose record left
 * the store rather than taking a new value. Rendering the missing side as a marker said the
 * log did not record what a removal became, when what it records is that it became nothing;
 * the `op` column is what tells the two one-sided forms apart, exactly as it does for
 * `item.relation.add` and `item.relation.remove`. Neither form is ever a bare name.
 */
function move(
  field: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): string {
  if (before === undefined) return `${field}=${side(after?.[field], field)}`
  if (after === undefined) return `${field}=${side(before[field], field)}`
  return `${field}=${side(before[field], field)}->${side(after[field], field)}`
}

/** The item fields one event moved, in the order the event recorded them. */
function movedBy(event: StoreEvent): readonly string[] {
  const before = snapshot(event.before)
  const after = snapshot(event.after)
  const named = VALUE_OF_OP[event.op]
  if (named !== undefined) {
    const value = after ?? before
    return [`${named.field}=${value === undefined ? UNKNOWN : named.of(value)}`]
  }
  const source = after ?? before
  if (source === undefined) return []
  const keys = Object.keys(source)
  // A sprint event names sprint fields and a workspace event names configuration keys; an
  // item event names neither, so one filter serves all three.
  const known = keys.filter((key) => isKnownField(key) || isSprintField(key) || isConfigKey(key))
  // A pair that was not set before and is not set after moved nothing, and a log of moves is
  // what this cell is: a sprint close over a sprint that finished nothing carried
  // `finished=(unset)->(unset)` beside the six pairs that did move. A creation has no before at
  // all and prints whole.
  //
  // The test is `(unset)` on both sides and never "the two sides render the same", which was
  // the first shape of this filter and hid a real edit: prose is recorded as its length, so a
  // description replaced by another of the same length renders `(text:14)` either side, and
  // the whole `what` cell became `-` for a write that happened.
  const unset = (value: unknown, key: string): boolean => side(value, key) === UNSET
  const moved = known.filter((key) => before === undefined || !(unset(before[key], key) && unset(after?.[key], key)))
  const moves = moved.map((key) => move(key, before, after))
  // A key this build does not know is counted rather than printed: it is text from a file
  // that no dictionary bounds, and the count is the part a reader can act on.
  return known.length === keys.length ? moves : [...moves, `unknown=${keys.length - known.length}`]
}

/**
 * What one event recorded: the fields it moved, then the two facts that are not fields.
 * The cell is bounded like every other, and a name dropped to stay inside it is counted.
 *
 * `named` leads the cell with `entity=<id>` under the transaction-scoped read, where the
 * record is the one fact that tells two rows of the same op apart and is on no column of
 * its own: the three `item.commit` rows of one `sprint commit` each render
 * `sprint_id=(unset)->sprint-31` and nothing else. It leads rather than trails because the
 * bound below drops the tail, and the row's own identity is not what a reader can spare.
 * The entity-scoped read never carries it: there it is the `item` scalar, constant per row.
 */
function whatOf(event: StoreEvent, named: boolean): string {
  const parts = named ? [`entity=${cell(event.entity)}`, ...movedBy(event)] : [...movedBy(event)]
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

/**
 * A recorded reason as the one free-text cell of a row. `reason` is not among the keys
 * `parseEventLine` holds to safe single-line text, so a hand edit of a committed log reaches
 * this cell with anything at all: a delimiter, an unbounded value, or a U+202E override that
 * reorders every character after it in a terminal. The first two would throw a render
 * invariant out of a read and the third is threat-model finding F5's whole class, so the
 * value is held to the domain's own text class here, at the read that prints it.
 *
 * A value that fails prints as the file's own unknown marker, which says a reason was
 * recorded and that this one cannot be shown; `doctor` is the surface for the file that says
 * it. The row is still emitted, because a reason nothing can print is itself the answer.
 */
function why(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REASON) return UNKNOWN
  return isSafeText(value, 'line') ? value : UNKNOWN
}

/**
 * The one thing the read is scoped to. A union rather than two optional fields, so "an id or
 * a transaction, never both" is a shape this service cannot be handed a violation of; the
 * line that writes both is refused in `src/cli/main.ts`, where both are in hand.
 */
export type HistoryScope =
  | { readonly kind: 'item'; readonly id: ItemId }
  | { readonly kind: 'txn'; readonly txn: string }

export type HistoryRequest = {
  readonly scope: HistoryScope
  readonly limit: number
  /** The event id to resume at, which is the id the previous page's `page` line named. */
  readonly cursor?: string
}

/**
 * An id that named no transaction, told apart by one streaming pass over the log. Only this
 * path pays for the pass, and it buys the distinction that makes the refusal worth reading:
 * a caller who reached for an event id gets the transaction that wrote it rather than a
 * dead end, which is `notFound`'s "is a sprint here, not an item" over the log's two ids.
 *
 * An empty answer and a wrong id must not look the same, so neither ends as `~events 0 0`.
 */
async function noTransaction(
  store: Store, workspace: string, txn: string,
): Promise<ResultObject> {
  let held = 0
  let named: StoreEvent | undefined
  const scanned = await store.eachEvent({}, (event) => {
    held += 1
    if (event.id === txn) named = event
  })
  if (!scanned.ok) return storeRefusal('history', 'read', scanned.error, workspace)
  if (named !== undefined) {
    return errorResult({
      code: 'NOT_FOUND', command: 'history', workspace, effect: 'read', rule: 'I5', entity: txn,
      cause: `${txn} is an event here, not a transaction, and --txn takes the transaction a write recorded under`,
      fix: [invocation('history', [], [['txn', named.txn]]), invocation('history', [named.entity], [])],
    })
  }
  return errorResult({
    code: 'NOT_FOUND', command: 'history', workspace, effect: 'read', entity: txn,
    cause: `${txn} names no transaction here; this log holds ${held} ${held === 1 ? 'event' : 'events'}, and a write's own result is what carries the transaction id it wrote under`,
    // The list of records, which is what `notFound` answers an unknown id with. There is no
    // listing of transactions to point at and building one is a command of its own, so the
    // line offered is the other scope's: these are the ids `history <id>` reads.
    fix: ['treadle backlog'],
  })
}

export async function history(
  store: Store, request: HistoryRequest,
): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('history', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  const scope = request.scope
  /** An id names an item or a sprint; the log is keyed by entity and the rows read the same. */
  const carried = (entity: string): boolean =>
    view.value.byId.has(entity) || view.value.sprintById.has(entity)

  const events = await store.events(
    scope.kind === 'txn' ? { txn: scope.txn } : { entity: scope.id })
  if (!events.ok) return storeRefusal('history', 'read', events.error, workspace)
  if (scope.kind === 'txn') {
    // A transaction exists only as the events it wrote, so nothing selected is an id this log
    // has never carried rather than a transaction that changed nothing.
    if (events.value.length === 0) return noTransaction(store, workspace, scope.txn)
  } else if (!carried(scope.id) && events.value.length === 0) {
    // A record `remove` took out still has its whole history, because the log is keyed by
    // entity id rather than by a record existing, and refusing here would make a removal erase
    // the trail it is supposed to leave intact (ADR-0024). An id with neither a record nor an
    // event is the absence `notFound` has always answered.
    return notFound('history', 'read', workspace, view.value, scope.id)
  }
  // The store returns the log in the order it was written; the question this command answers
  // is almost always about the most recent change, so the newest is the first row.
  const ordered = [...events.value].reverse()

  const scoping: readonly CarriedFlag[] = scope.kind === 'txn' ? [['txn', scope.txn]] : []
  const line = (cursor?: string): string =>
    invocation('history', scope.kind === 'txn' ? [] : [scope.id],
      [...scoping, ['limit', request.limit === DEFAULT_LIMIT ? undefined : String(request.limit)], ['cursor', cursor]])
  const named = scope.kind === 'txn' ? scope.txn : scope.id
  const from = request.cursor === undefined ? 0 : ordered.findIndex((event) => event.id === request.cursor)
  if (from < 0) return unknownCursor('history', workspace, named, request.cursor as string, line())
  const page = ordered.slice(from, from + request.limit)

  const block: Block = {
    columns: columnsOf(HISTORY_SHAPE, 'events'),
    shown: page.length,
    total: ordered.length,
    rows: page.map((event): Row => ({
      at: cell(event.at),
      kind: cell(event.actor_kind),
      op: cell(event.op),
      what: whatOf(event, scope.kind === 'txn'),
      by: event.actor,
    })),
  }

  // The same fact under both scopes: a row here names a record `show` will not find, and the
  // reader is told once rather than being left to discover it one follow-up read at a time.
  // The transaction-scoped count is over distinct entities and not over rows, because one
  // removal writes one event and a reader counting rows would read it as one record either way.
  const absent = scope.kind === 'txn'
    ? new Set(ordered.map((event) => event.entity).filter((entity) => !carried(entity)))
    : new Set(carried(scope.id) ? [] : [scope.id])
  const gone = absent.size === 0
    ? undefined
    : scope.kind === 'txn'
      ? `${absent.size} of the records these rows name ${absent.size === 1 ? 'is' : 'are'} no longer here; the entity in each what cell names ${absent.size === 1 ? 'it' : 'them'}, and the log keeps every event ${absent.size === 1 ? 'it' : 'they'} earned`
      : 'no record here carries this id now; these are the events it earned while it did'

  const recorded = page
    .filter((event) => event.reason !== undefined)
    .map((event): Row => ({ at: cell(event.at), op: cell(event.op), why: why(event.reason) }))

  const data: Record<string, Value> = scope.kind === 'txn'
    ? { sort: 'at desc', transaction: scope.txn }
    : { item: scope.id, sort: 'at desc' }
  if (ordered.length === 0) data['none'] = `${named} has no recorded change`

  const remaining = ordered.length - (from + page.length)
  if (remaining > 0) {
    data['more'] = remaining
    const following = ordered[from + page.length]
    if (following !== undefined) data['page'] = line(following.id)
  }
  if (gone !== undefined) data['note'] = gone
  data['events'] = block
  // An empty block still renders its opener, which would put `reasons 0 of 0` under every
  // history of an item nothing was ever marked or moved with a reason for.
  if (recorded.length > 0) {
    data['reasons'] = {
      columns: columnsOf(HISTORY_SHAPE, 'reasons'),
      shown: recorded.length,
      total: recorded.length,
      rows: recorded,
    }
  }
  return okResult(HISTORY_SHAPE, { workspace, data })
}
