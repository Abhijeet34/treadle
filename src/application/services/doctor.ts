// SPDX-License-Identifier: Apache-2.0
// The audit read: what the committed files say that nothing refused on the way in.
//
// Two classes of finding meet here. The store's own load-time findings are structural and
// already computed on every read; the four below are the ones only this layer can see,
// because each needs the event log, the field dictionary or the done gate beside the record.
//
// H20 is the one the captain's word "securely" names. The tool cannot stop a hand edit and
// should not try: D1 makes the committed file authoritative, so an edit to it is a
// legitimate edit and git is where its authorship is proved. What the tool can do is notice
// that the record no longer agrees with the log that recorded the value, and say so with
// both numbers, so an S1 quietly becoming an S4 is a finding rather than a diff nobody read.
//
// The log is a committed file too. H23 is the one thing a well-formed hand-written event
// line can say that no write path would have: a change dated before the item was filed.
// It is not refused on load, because the line is well formed; it is reported here, because
// `history` and `explain` answer from it. An event naming an item the store does not hold
// is not a finding: a record removed by hand is a legitimate edit under D1, and the event
// reaches no read surface. Nor is an event that precedes an `item.remove` for the same id:
// the record it described has left, and the one filed under that id afterwards is a
// different record whose `filed_at` says nothing about it.
//
// The audit is one pass over the records and one over the log, and holds neither. It held
// both: 50,000 decoded records and 500,000 decoded events, 1,442 MiB allocated and a
// 1,043,456 KiB peak against a 102,400 KiB budget, to look at each once. What it keeps per
// item is the summary a scan reads plus the few findings decided off the whole record, and
// what it keeps per event is a counter and, for a relation event alone, the two instants
// that say whether its edge still stands; ADR-0021 carries the profile. No event is held,
// and nothing kept grows with the log: the counters are one per item and the folded edges
// one per edge the log mentions, which is the order of the relation graph the read already
// builds.

import {
  MAX_DESCRIPTION,
  findRelationCycle,
  relationGraphFrom,
  summaryOf,
  type Instant,
  type ItemId,
  type RelationGraph,
  type WorkItem,
  type WorkItemState,
  type WorkItemSummary,
  type WorkspaceConfig,
} from '../../domain/index.ts'
import { columnsOf, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { Store, StoreEvent } from '../ports/store.ts'
import { foldWorkTrail, hasReviewStep, hidesContent, type WorkTrail } from './context.ts'
import { storeRefusal } from './refusal.ts'

export const DOCTOR_SHAPE: ResultShape = {
  command: 'doctor',
  version: 1,
  effect: 'read',
  summary: 'Report what the stored files say that no write path would have accepted.',
  properties: [
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'checked', type: 'integer' },
    { kind: 'scalar', key: 'clean', type: 'string' },
    // Appended after `clean`, which STABILITY's output-schema rule makes a non-breaking
    // addition: the table is not empty and nothing on it hides a record, which is the one
    // shape that answers 0 with rows printed.
    { kind: 'scalar', key: 'serving', type: 'string' },
    {
      kind: 'block',
      key: 'findings',
      // `rule` is the tool's own closed set; the other three all project bytes read from a
      // damaged file, an id the record grammar never accepted included, so all three carry
      // the marker. `cell` keeps the two non-final ones arity-1.
      columns: [{ name: 'rule' }, { name: 'id', data: true }, { name: 'where', data: true }, { name: 'detail', text: true }],
    },
  ],
}

export type DoctorFinding = {
  readonly rule: string
  readonly id: string
  readonly where: string
  /** One sentence. It may quote a stored value, so the column is marked as third party. */
  readonly detail: string
}

/**
 * The audited fields whose divergence from the log is a finding, in report order. `state`
 * is here because `explain` answers "since when, and who" from the last event that moved
 * it: a forged line saying `done` over a record that says `draft` was that answer.
 */
const MARKED_FIELDS = ['state', 'severity', 'priority'] as const

/** The longest a non-final cell may be, which is the field dictionary's own line bound. */
const MAX_CELL = 200

/**
 * A value from a file as a non-final row cell. Whitespace would split the row and move
 * every value after it (F3), so such a value prints as absent; the detail column, which is
 * the free-text one, carries it. A shard named with a space took `doctor` down with an
 * internal error, which is the one surface that would have named the shard.
 */
function cell(value: string): string {
  return value.length > 0 && value.length <= MAX_CELL && !/\s/.test(value) ? value : '-'
}

function renderField(item: WorkItemSummary, field: string): string {
  const value = (item as unknown as Record<string, unknown>)[field]
  return value === undefined || value === null ? '-' : String(value)
}

const NONE: readonly DoctorFinding[] = []

/**
 * Whether the log says this edge stands: it was added, the add is later than any remove of
 * it, and later than the removal of the record that held it. Both `H32` directions ask this
 * one question, from opposite sides.
 */
function recorded(edge: LoggedEdge | undefined, removedAt: Instant | undefined): boolean {
  const added = edge?.add
  if (added === undefined) return false
  if (edge?.remove !== undefined && edge.remove >= added) return false
  return removedAt === undefined || added > removedAt
}

/**
 * One item under audit: what a scan reads of it, the findings decided off its whole record
 * before the log is read, and what the log said about it once it has been.
 */
type Audited = {
  readonly item: WorkItemSummary
  /** H18. */
  readonly before: readonly DoctorFinding[]
  /** H21. */
  readonly after: readonly DoctorFinding[]
  /**
   * The value the log last recorded for each marked field, folded forward over every event
   * that named it. Absent means the log never carried the field, which is what a workspace
   * written before the file event carried its fields looks like: silence there is not
   * evidence of an edit, so no finding is raised on it.
   */
  logged?: Map<string, string>
  /**
   * H23 and H19, in log order. An H23 carries the instant its decision is made against,
   * because a removal seen later in the scan is what settles it and the scan order is not
   * the instant order; see `removedAt`.
   */
  fromLog?: { readonly finding: DoctorFinding; readonly at?: Instant }[]
  /**
   * The latest `item.remove` this id has, which is where the record the store holds now
   * begins. It cannot be decided from scan position: the store orders the log by file name
   * and then by `at` within one file, so a hand-written line filed under another month is
   * read where the file puts it (`sharded-store.ts`, `#eachLogEvent`). Dropping H23 findings
   * at the moment the removal was reached therefore cleared a line dated AFTER the removal
   * whenever a forger had filed it under an earlier month, which is the one edit H23 exists
   * to catch. The boundary is the instant, and it is compared once per finding rather than
   * held per event.
   */
  removedAt?: Instant
  /**
   * The instant the item entered the state it is in now, folded forward over every event
   * whose `after` names that state. It is `H03`'s input and the log is the only place it is:
   * a record carries its state and never when it took it.
   */
  enteredAt?: Instant
  /**
   * `H34`: who the log says did the work on this record, and who took it to `done` last. The
   * trail is folded by the same function `DOD3` reads at write time, so the guard and this
   * finding cannot disagree about who did the work; the accept is one string, kept last-wins,
   * because an item reopened and closed again properly is not reported for the accept that
   * was superseded.
   */
  trail?: WorkTrail
  acceptedBy?: string
  /**
   * How many events in the log name this id, which is `H31`'s input. Every write bumps the
   * record's version and appends an event naming it, so the log holds at least `version`
   * events for a record the tool wrote, and one integer per item is the whole cost of
   * knowing it. It counts every event under the id rather than only those after a removal:
   * an id removed and refiled keeps the old record's trail, so counting the lot can only
   * overstate, and overstating is the direction that raises no false finding.
   */
  events?: number
}

/**
 * What the log last said about one edge: the latest `relation.add` and the latest
 * `relation.remove` recorded for it. Two instants rather than a running boolean, because the
 * store orders the log by file name and then by `at` within a file, so a line filed under
 * another month is read out of instant order and a fold that trusted arrival order would
 * read an add-then-remove pair backwards.
 */
type LoggedEdge = { add?: Instant; remove?: Instant }

/**
 * What the audit needs beyond the records and the log: the workspace's own configuration,
 * because two of its findings are thresholds a team set, and an instant to measure an age
 * against. `status` already takes a clock for the overdue finding it raises; these are the
 * same kind of fact, so they arrive the same way rather than through a second mechanism.
 */
export type AuditContext = {
  readonly config: WorkspaceConfig
  readonly now: Instant
}

const DAY_MS = 86_400_000

/**
 * The audit, fed one record at a time and then one event at a time, and read once both
 * passes are over. The whole record is seen exactly once, at `record`, and the two findings
 * that need more of it than a summary carries are decided there.
 */
export class WorkspaceAudit {
  readonly #context: AuditContext
  readonly #heldItems: ReadonlySet<string>
  readonly #entries: Audited[] = []
  readonly #byId = new Map<ItemId, Audited>()
  /**
   * The edges the log recorded, per holder, for every entity the log names and not only for
   * the ones the store serves. `H32`'s second direction is about an id with no record at
   * all, so it cannot hang off an `Audited`: a blocker's record deleted by hand takes the
   * `blocks` edge stored on it with it, and the item it held reads `blocked no` with nothing
   * anywhere to say the blocker ever existed. What is kept is one entry per edge the log
   * mentions, which is the order of the relation graph the read already builds.
   */
  readonly #logEdges = new Map<ItemId, Map<string, LoggedEdge>>()
  /** The latest `item.remove` per entity, which is the boundary `#logEdges` is read against. */
  readonly #logRemoved = new Map<ItemId, Instant>()
  /**
   * `H33`: whether the log's last word on an id the records did NOT supply was a filing or a
   * removal, with the instant it was filed at. An id the store serves is never entered, so a
   * whole workspace normally keeps nothing here at all, and what it keeps is one entry per id
   * that has actually gone missing.
   *
   * The last word in scan order, and not the later instant, which is the one place this
   * departs from `#logRemoved`'s rule. A record filed and removed inside one second carries
   * two lines with the same `at`, so an instant comparison has to break the tie by guessing
   * and gets `remove` then `file` - the migration the tool offers for a field no command
   * writes - wrong in the silent direction. Reading the log's order gets both right for every
   * log the tool wrote, and a hand-written line filed under an earlier month is read where the
   * file puts it, which errs toward reporting; `H23` is what names such a line.
   *
   * Workspace-scoped for `#vanishedEdges`' reason and missed the same way: the removal
   * boundary at `recorded` and `#logRemoved` covers EDGES, so a truncated shard was reported
   * only where a lost record happened to hold one, and the records that held none went with
   * `doctor` printing `clean checked 7 items and 11 events` at exit 0 over a log that had
   * filed ten. `H31` cannot see it either: a record that is not served has no version to fall
   * short of.
   */
  readonly #logLife = new Map<ItemId, { readonly filed: Instant; alive: boolean }>()

  /**
   * The item ids the records supply are the SERVED set. `heldItems` is what the store holds
   * and refused to serve, which it already reported as an S-row of its own: an id in it
   * exists, so a neighbour pointing at it is not dangling. Testing served membership alone
   * made every neighbour of one damaged record lie. A record that is neither served nor held
   * is genuinely absent.
   */
  constructor(context: AuditContext, heldItems: ReadonlySet<string> = new Set()) {
    this.#context = context
    this.#heldItems = heldItems
  }

  record(item: WorkItem): void {
    const before: DoctorFinding[] = []
    if (item.description !== undefined && item.description.length > MAX_DESCRIPTION) {
      before.push({
        rule: 'H18',
        id: item.id,
        where: 'description',
        detail: `the stored description is ${item.description.length} characters and the bound is ${MAX_DESCRIPTION}; the long form belongs in a file this record points at`,
      })
    }
    // The same rule as the line above, on the other field the write path bounds and the load
    // path does not: `hold_until` must be in the future when it is written and merely be an
    // instant when it is read, because a hold already on disk stays readable as it expires.
    // That is right on load and leaves nothing anywhere to say the hold has run out, so a
    // parked blocker held its dependents at `blocked yes` for ever with `doctor` at exit 0.
    // The predicate is `hold_until`'s own check in `src/domain/fields.ts`; a future narrowing
    // of it moves both.
    if (item.state === 'on_hold' && item.hold_until !== undefined && item.hold_until <= this.#context.now) {
      before.push({
        rule: 'H18',
        id: item.id,
        where: 'hold_until',
        detail: `the hold ran out at ${item.hold_until} and the item is still on_hold, which no write path would set; treadle transition ${item.id} resume`,
      })
    }
    const after = item.state === 'done' && hasReviewStep(this.#context.config, item.type) && (item.evidence ?? []).length === 0
      ? [{
        rule: 'H21',
        id: item.id,
        where: 'evidence',
        detail: 'the item is done and points at no evidence, which DOD7 refuses; it was closed by a hand edit or before that rule',
      }]
      : NONE
    const entry: Audited = { item: summaryOf(item), before: before.length === 0 ? NONE : before, after }
    this.#entries.push(entry)
    this.#byId.set(item.id, entry)
  }

  event(event: StoreEvent): void {
    // Folded before the early return below, because both need entities the store does not
    // serve: an edge whose holder record has gone is exactly the case with no `Audited`.
    if (event.op === 'item.relation.add' || event.op === 'item.relation.remove') {
      const added = event.op === 'item.relation.add'
      const snapshot = (added ? event.after : event.before) as Record<string, unknown> | undefined
      const kind = snapshot?.['kind']
      const other = snapshot?.['other']
      if (typeof kind === 'string' && typeof other === 'string') {
        const edges = this.#logEdges.get(event.entity) ?? new Map<string, LoggedEdge>()
        this.#logEdges.set(event.entity, edges)
        const key = `${kind} ${other}`
        const seen = edges.get(key) ?? {}
        const at = added ? seen.add : seen.remove
        if (at === undefined || event.at > at) {
          if (added) seen.add = event.at
          else seen.remove = event.at
        }
        edges.set(key, seen)
      }
    }
    if (event.op === 'item.remove') {
      const removed = this.#logRemoved.get(event.entity)
      if (removed === undefined || event.at > removed) this.#logRemoved.set(event.entity, event.at)
    }
    // Every record is read before any event is (`doctor` runs `eachItem` then `eachEvent`),
    // so an id the store serves is known here and costs no entry.
    if (!this.#byId.has(event.entity)) {
      if (event.op === 'item.file') this.#logLife.set(event.entity, { filed: event.at, alive: true })
      else if (event.op === 'item.remove') {
        const life = this.#logLife.get(event.entity)
        if (life !== undefined) life.alive = false
      }
    }
    const entry = this.#byId.get(event.entity)
    if (entry === undefined) return
    entry.events = (entry.events ?? 0) + 1
    const item = entry.item
    const after = event.after
    if (typeof after === 'object' && after !== null) {
      for (const field of MARKED_FIELDS) {
        const value = (after as Record<string, unknown>)[field]
        if (typeof value !== 'string') continue
        entry.logged ??= new Map()
        entry.logged.set(field, value)
      }
    }
    // The instant this item took the state it is in now, which is H03's whole input. A file
    // event names `draft` and a transition names what it moved to, so one test over `after`
    // covers both and the last one to name the current state is when it was entered.
    if (typeof after === 'object' && after !== null && (after as Record<string, unknown>)['state'] === item.state) {
      entry.enteredAt = event.at
    }
    if (Date.parse(event.at) < Date.parse(item.filed_at)) {
      (entry.fromLog ??= []).push({
        at: event.at,
        finding: {
          rule: 'H23',
          id: item.id,
          where: cell(event.id),
          detail: `event ${event.id} is dated ${event.at}, before the item was filed at ${item.filed_at}; no write path records a change to an item that does not exist yet`,
        },
      })
    }
    // A removal ends one record's life, and the log keeps its events under the id (ADR-0024).
    // Everything dated up to it therefore belongs to the record that left, not to the one the
    // store holds now, and comparing those with a later `filed_at` faulted the whole trail:
    // the one migration the tool offers for a field no command writes - `remove` then `file`
    // under the same id, which is how a type is changed - left `doctor` at exit 7 for ever,
    // because the log is append-only and nothing could clear the findings.
    //
    // A line dated at or before the removal cannot be told from a genuine event of the record
    // that left, so the audit says nothing about either rather than faulting both; every event
    // dated after it is still decided. The latest removal wins, because an id may be removed
    // and refiled more than once. `#ofItem` applies the boundary, since the removal can be
    // reached after the events it settles.
    if (event.op === 'item.remove' && (entry.removedAt === undefined || event.at > entry.removedAt)) {
      entry.removedAt = event.at
    }
    // Who the log says did the work, folded into the trail `H34` is decided against and read
    // from the same place `DOD3` reads it, so the write-time guard and the load-time finding
    // cannot disagree about who that is.
    foldWorkTrail(entry.trail ??= {}, event)
    // The accept, kept as the actor of the LAST move into `done`: an item reopened and closed
    // again properly is not reported for the accept that was superseded, which is the same
    // narrowing `H27` took when it fired between two commands the tool itself prescribes.
    if (event.op === 'item.transition'
      && typeof after === 'object' && after !== null
      && (after as Record<string, unknown>)['state'] === 'done') {
      entry.acceptedBy = event.actor
    }
    // One op, one question: did the person the work is assigned to write the marker field that
    // is supposed to be somebody else's judgement of it. `item.mark` carries severity and
    // priority, which is where this started.
    //
    // `item.set` writing `reviewer` was here too, and it fired on the honest path and nowhere
    // else: an assignee that named a real reviewer because the `DOD3` refusal told it to earned
    // a finding, while the record that laundered an accept earned none, because the launder
    // changed the very field this test reads. Naming your own reviewer is not a hazard now that
    // `DOD3` reads the log for who did the work - no name written into that field lets the
    // worker accept - so the arm goes and `H34` below reports the accept itself.
    if (event.op !== 'item.mark') return
    if (item.assignee === undefined || event.actor !== item.assignee) return
    const changed = typeof after === 'object' && after !== null
      ? Object.keys(after).join(' and ')
      : 'a marked field'
    ;(entry.fromLog ??= []).push({
      finding: {
        rule: 'H19',
        id: item.id,
        where: cell(event.id),
        detail: `${event.actor} changed ${changed} on an item they are assigned; the audit says who and a reader decides`,
      },
    })
  }

  /** The findings of one item that need only its record and its own events, in rule order. */
  #ofItem(entry: Audited): readonly DoctorFinding[] {
    const item = entry.item
    const findings: DoctorFinding[] = [...entry.before]
    for (const field of MARKED_FIELDS) {
      const logged = entry.logged?.get(field)
      if (logged === undefined) continue
      const stored = renderField(item, field)
      if (stored === logged) continue
      findings.push({
        rule: 'H20',
        id: item.id,
        where: field,
        detail: `${field} is ${stored} in the record and the last event to record it says ${logged}; the change was made outside the tool and has no actor`,
      })
    }
    findings.push(...this.#unaccounted(entry), ...this.#selfAccepted(entry), ...this.#handWrittenEdges(entry))
    // The removal boundary is applied here rather than in `event`, because the removal can be
    // reached after the events it settles: the store orders the log by file name first.
    const fromLog = (entry.fromLog ?? [])
      .filter((held) => held.at === undefined || entry.removedAt === undefined || held.at > entry.removedAt)
      .map((held) => held.finding)
    findings.push(...this.#aging(entry), ...fromLog, ...entry.after)
    return findings
  }

  /**
   * `H31`: the log holds fewer events for this record than the record has versions. Every
   * write bumps the version and appends an event naming the id, so the two move together and
   * a shortfall is the log missing lines the records still remember - a deleted month file, a
   * truncated one, a bad merge, or a record written by hand. Nothing else in the tool notices:
   * `doctor` counted the log's own findings, and a log that is simply GONE has no findings to
   * report, so eight items and a deleted event log printed `clean checked 8 items and 0
   * events` at exit 0 while `history` and `explain` answered from nothing.
   *
   * It is only ever raised on a shortfall. A record removed and refiled under one id keeps the
   * old trail and restarts at version 1, so the count runs ahead of the version there, which
   * this says nothing about.
   */
  #unaccounted(entry: Audited): readonly DoctorFinding[] {
    const held = entry.events ?? 0
    const version = entry.item.version
    if (held >= version) return NONE
    return [{
      rule: 'H31',
      id: entry.item.id,
      where: 'version',
      detail: `the record is at version ${version} and the log holds ${held} ${held === 1 ? 'event' : 'events'} naming it; every write records one, so the log has lost lines and no answer read from it is whole`,
    }]
  }

  /**
   * `H34`: a done record whose accept was run by somebody the log says held it while it was
   * worked. It is `DOD3`'s load-time twin, the pair this file already keeps for `G3` and
   * `H04` and for `DOD7` and `H21`, and it reads the trail from the same fold the gate does.
   *
   * The write path refuses this now, so what reaches here is a record closed before that
   * refusal existed, a shard a hand edit took to `done`, or a workspace whose `review_step`
   * was widened after the fact. Nothing reported it: `H19` read the assignee the record holds
   * NOW, which is exactly the field the launder rewrote, so it stayed silent on the laundered
   * record and fired on the honest one instead.
   *
   * `explain` raises it too, because it needs only the record and its own events.
   */
  #selfAccepted(entry: Audited): readonly DoctorFinding[] {
    const item = entry.item
    const by = entry.acceptedBy
    if (item.state !== 'done' || by === undefined) return NONE
    if (!hasReviewStep(this.#context.config, item.type)) return NONE
    if (entry.trail?.names?.has(by) !== true) return NONE
    return [{
      rule: 'H34',
      id: item.id,
      where: 'state',
      detail: `the item was accepted by ${by}, and the log records ${by} as holding it while it was worked; DOD3 refuses that move, so this record was closed by a hand edit, before that rule, or under a review step set afterwards; treadle history ${item.id}`,
    }]
  }

  /**
   * `H32`, the direction a record can be wrong in: the record stores an edge the log never
   * recorded. `relation add` is the only writer and it refuses a cycle (`R2`), a second
   * original (`R4`) and an edge out of finished work (`R5`), so an edge with no event behind
   * it is one that reached the file past all three. The measured case is `R5`'s: a `blocks`
   * edge written by hand onto a done record left `show` printing `blocked_by` while `explain`
   * said `blocked no`, with `doctor` clean between them.
   *
   * An edge added before the id's latest removal belonged to the record that left, which is
   * the boundary `H23` already draws.
   */
  #handWrittenEdges(entry: Audited): readonly DoctorFinding[] {
    const edges = this.#logEdges.get(entry.item.id)
    return (entry.item.relations ?? [])
      .filter((relation) => !recorded(edges?.get(`${relation.kind} ${relation.target}`), entry.removedAt))
      .map((relation): DoctorFinding => ({
        rule: 'H32',
        id: entry.item.id,
        where: 'relations',
        detail: `the record stores ${relation.kind} ${relation.target} and no event in the log recorded it, so it was written outside the tool, which refuses a cycle, a second original and an edge out of finished work; treadle relation remove ${entry.item.id} ${relation.kind} ${relation.target}`,
      }))
  }

  /**
   * `H33`: the log filed a record, recorded no removal of it, and no record here carries the
   * id. It is the "not lost" clause of the store's promise, asked of the memory an agent reads
   * back: a shard cut mid-file, a deleted month, a bad merge or a hand edit takes records out
   * with nothing anywhere saying so, and `doctor`, `status` and every list answered over what
   * was left as though that were the whole of it.
   *
   * The one thing that makes a record's absence legitimate is an `item.remove`, which says out
   * loud what went and why (ADR-0024). A removal after the filing therefore ends the question,
   * and a refile after a removal opens it again.
   *
   * Workspace-scoped rather than per-item, exactly as `#vanishedEdges` is and for the same
   * reason: the question is whether ANY record here carries the id, which an audit fed one
   * record cannot answer.
   */
  #vanishedItems(known: ReadonlySet<ItemId>): readonly DoctorFinding[] {
    const findings: DoctorFinding[] = []
    for (const [id, life] of this.#logLife) {
      if (!life.alive || known.has(id)) continue
      const filed = life.filed
      findings.push({
        rule: 'H33',
        id: cell(id),
        where: 'items',
        detail: `the log filed ${id} at ${filed} and recorded no removal of it, and no record here carries that id, so the record left the store outside the tool: a truncated or deleted shard, a bad merge, or a hand edit; treadle history ${id}`,
      })
    }
    return findings
  }

  /**
   * `H32`, the direction the log can be wrong in, and the one no `Audited` can carry: the log
   * records a live edge whose holder is not a record here and whose going nothing recorded.
   * An edge is stored once, on its source, so deleting a blocker's record by hand deletes the
   * `blocks` edge with it and every dependent silently reads `blocked no` - `next` then ranks
   * work nobody can start. `remove` is not this: it writes an `item.remove`, and it says out
   * loud which items it frees.
   *
   * Workspace-scoped rather than per-item, so it is raised by `findings` and not by `ofOne`:
   * the question is whether ANY record here holds the id, which an audit fed one record
   * cannot answer, and `explain` would otherwise report every other item's edges as missing.
   */
  #vanishedEdges(known: ReadonlySet<ItemId>): readonly DoctorFinding[] {
    const findings: DoctorFinding[] = []
    for (const [holder, edges] of this.#logEdges) {
      if (known.has(holder)) continue
      const removed = this.#logRemoved.get(holder)
      for (const [key, edge] of edges) {
        if (!recorded(edge, removed)) continue
        const target = key.slice(key.indexOf(' ') + 1)
        findings.push({
          rule: 'H32',
          id: cell(holder),
          where: 'relations',
          detail: `the log records ${key} held by ${holder} and no record here carries that id, so the edge went with a record deleted outside the tool and ${target} reads as though it never existed; treadle explain ${target}`,
        })
      }
    }
    return findings
  }

  /**
   * `H03`: an item in progress for longer than the workspace's `aging_days`. The threshold
   * is configuration and zero disarms it, exactly as a zero column limit disarms `G3`, so a
   * workspace that has set nothing raises nothing. Only `in_progress` is asked, which is the
   * domain model's own wording: an item nobody has picked up is the backlog, and an item
   * somebody picked up and left is the thing a standup is for.
   */
  #aging(entry: Audited): readonly DoctorFinding[] {
    const days = this.#context.config.aging_days
    if (days === 0 || entry.item.state !== 'in_progress' || entry.enteredAt === undefined) return NONE
    const age = Math.floor((Date.parse(this.#context.now) - Date.parse(entry.enteredAt)) / DAY_MS)
    if (!Number.isFinite(age) || age <= days) return NONE
    return [{
      rule: 'H03',
      id: entry.item.id,
      where: 'state',
      // One command line, last, with nothing after it: `test/cli/runnable-lines.test.ts`
      // reads a detail's trailing `; treadle ...` as a line to run, and a verb phrase after
      // the command would be run as its arguments.
      detail: `the item has been in_progress for ${age} days, over this workspace's aging_days of ${days}, and explain names what it is waiting on; treadle explain ${entry.item.id}`,
    }]
  }

  /** The findings of the one item `record` was given, which is what `explain` reads. */
  ofOne(): readonly DoctorFinding[] {
    const only = this.#entries[0]
    return only === undefined ? NONE : this.#ofItem(only)
  }

  /** Every id this workspace holds, served or quarantined, which is what a neighbour points at. */
  known(): ReadonlySet<ItemId> {
    return new Set([...this.#byId.keys(), ...this.#heldItems])
  }

  /** Every finding over the workspace, in item then rule order, the cycle check last. */
  findings(): readonly DoctorFinding[] {
    const known = this.known()
    return [
      ...this.#entries.flatMap((entry) => [
        ...this.#ofItem(entry),
        ...auditParentOf(known, entry.item),
        ...auditRelationsOf(known, entry.item),
        ...auditImpediment(entry.item),
      ]),
      ...this.#vanishedItems(known),
      ...this.#vanishedEdges(known),
      ...this.#columnsOverLimit(),
      ...storedBlockingCycle(relationGraphFrom(this.#entries.map((entry) => entry.item))),
    ]
  }

  /**
   * `H04`: a state holding more than its configured limit. It is scoped exactly as `G3`
   * scopes its count, over the whole workspace, so the finding and the guard cannot disagree
   * about which items are in it. `G3` refuses the move that would put a state over its
   * limit, and this reports the ones already there: a limit lowered under
   * work in flight and an override are both routes no guard could have refused, which is the
   * write-time-guard and load-time-finding pair the rest of this file already keeps.
   */
  #columnsOverLimit(): readonly DoctorFinding[] {
    const limits = this.#context.config.wip_limits
    if (limits.size === 0) return NONE
    const findings: DoctorFinding[] = []
    for (const [state, limit] of limits) {
      if (limit === 0) continue
      const used = this.#entries.filter((entry) => entry.item.state === state).length
      if (used <= limit) continue
      findings.push({
        rule: 'H04',
        id: '-',
        where: state as WorkItemState,
        detail: `the ${state} column of this workspace holds ${used} items against a wip_limits of ${limit}, which G3 refuses to add to and an override or a lowered limit produces; treadle backlog --state ${state}`,
      })
    }
    return findings
  }

  get checked(): number {
    return this.#entries.length
  }
}

/** The findings of one item against its own slice of the log, in rule order. */
export function auditItem(
  item: WorkItem, events: readonly StoreEvent[], context: AuditContext,
): readonly DoctorFinding[] {
  const audit = new WorkspaceAudit(context)
  audit.record(item)
  for (const event of events) audit.event(event)
  return audit.ofOne()
}

/**
 * A `parent_id` naming a record the store does not hold (H30). The store refuses to write
 * one, so this reports what reached the files by the routes D1 permits: a hand edit, a git
 * merge, a build older than that rule. It is the same test `H24` runs for a relation's
 * target, against the same held-or-served set, and it was the neighbour of the two with no
 * finding at all - `doctor` exited 0 over a record whose parent had gone, while `show` went
 * on printing the parent as though it were there.
 */
export function auditParentOf(
  known: ReadonlySet<ItemId>, item: Pick<WorkItemSummary, 'id' | 'parent_id'>,
): readonly DoctorFinding[] {
  const parent = item.parent_id
  if (parent === undefined || known.has(parent)) return NONE
  return [{
    rule: 'H30',
    id: item.id,
    where: 'parent_id',
    detail: `parent_id names ${parent} and no record here carries that id; treadle set ${item.id} parent_id= drops it`,
  }]
}

/**
 * The edges one record stores whose other end the store does not hold (H24). A record
 * removed by hand is a legitimate edit under D1, so the edge is a finding rather than a
 * refusal: it counts for nothing on any read, because a blocker nobody can finish would
 * otherwise hold the item forever, and the detail names the command that drops it.
 */
export function auditRelationsOf(known: ReadonlySet<ItemId>, item: Pick<WorkItem, 'id' | 'relations'>): readonly DoctorFinding[] {
  return (item.relations ?? [])
    .filter((relation) => !known.has(relation.target))
    .map((relation): DoctorFinding => ({
      rule: 'H24',
      id: item.id,
      where: 'relations',
      detail: `${relation.kind} ${relation.target} names an item the store does not hold, so the edge counts for nothing; treadle relation remove ${item.id} ${relation.kind} ${relation.target} drops it`,
    }))
}

/**
 * A raised impediment that blocks nothing (H27). An impediment earns its keep through the
 * `blocks` edge, which is stored on its own record, so this needs no other record to see: one
 * raised against no work is a complaint on file, and the detail names the line that raises it
 * against something. A resolved or cancelled one is history and is not reported.
 *
 * A `draft` one is not reported either, and that is the whole of the fix for a finding that
 * used to fire between the two commands the tool itself prescribes. `file` lands an
 * impediment in `draft` and `help file` then prescribes `relation add`, so a CI job running
 * `doctor` between those two lines met exit 7, which is also what a corrupt store returns.
 * `draft` is the state for a record still being written; DOR9 is what refuses to let one
 * out of it while it holds nothing up, so this finding now reports only what a hand edit or
 * a later `relation remove` produced, which is the write-time-guard-and-load-time-finding
 * pair R2 and H25 already are. ADR-0022 carries the argument.
 */
export function auditImpediment(item: Pick<WorkItem, 'id' | 'type' | 'state' | 'relations'>): readonly DoctorFinding[] {
  if (item.type !== 'impediment' || item.state === 'draft' || item.state === 'done' || item.state === 'cancelled') return []
  if ((item.relations ?? []).some((relation) => relation.kind === 'blocks')) return []
  return [{
    rule: 'H27',
    id: item.id,
    where: 'relations',
    detail: `the impediment is ${item.state} and blocks nothing, so it is raised against no work; treadle relation add ${item.id} blocks <id> names what it holds up`,
  }]
}

/**
 * A `blocks` cycle the files carry (H25). `relation add` refuses one at write time (R2) and
 * cannot see one a hand edit or a merge put in; every item on it is blocked by itself.
 */
function storedBlockingCycle(graph: RelationGraph): readonly DoctorFinding[] {
  const path = findRelationCycle(graph, 'blocks')
  if (path === undefined) return []
  return [{
    rule: 'H25',
    id: path[0] as string,
    where: 'relations',
    detail: `blocks closes a cycle through ${path.join(' -> ')}, which no write path records; every item on it waits on itself`,
  }]
}

export async function doctor(store: Store, clock: Clock): Promise<ResultObject> {
  const identity = await store.identity()
  if (!identity.ok) return storeRefusal('doctor', 'read', identity.error, undefined)
  const workspace = identity.value.id

  const stored = await store.findings()
  if (!stored.ok) return storeRefusal('doctor', 'read', stored.error, workspace)
  // A record the store holds and refused to serve still exists, and the S-row above names it.
  // Its id is not free and nothing that points at it is dangling.
  const held = new Set(stored.value.flatMap((finding) => (finding.id === undefined ? [] : [finding.id])))
  const audit = new WorkspaceAudit({ config: identity.value.config, now: clock.now() }, held)
  // The audit reads every field of every record against its events, so this is the one
  // command that decodes the whole store; it holds one record and one event at a time.
  const records = await store.eachItem({}, (item) => audit.record(item))
  if (!records.ok) return storeRefusal('doctor', 'read', records.error, workspace)
  const events = await store.eachEvent({}, (event) => audit.event(event))
  if (!events.ok) return storeRefusal('doctor', 'read', events.error, workspace)
  // Asked again, because the log's own findings are known only once the log has been read
  // and this is the command that reads it whole. It reports them rather than refusing over
  // them: the refusal every other read prints names `doctor` as the way back, so it has to
  // answer over the file that says it (ADR-0020).
  const all = await store.findings()
  if (!all.ok) return storeRefusal('doctor', 'read', all.error, workspace)

  const audited = audit.findings()
  const rows: DoctorFinding[] = [
    ...all.value.map((finding): DoctorFinding => ({
      rule: finding.rule,
      id: finding.id === undefined ? '-' : cell(finding.id),
      where: `${cell(finding.file)}:${finding.line}`,
      detail: finding.reason,
    })),
    ...audited,
  ]
  // The verdict is not "the table is empty". `H16` and `S12` report a fact about content the
  // store still serves, and a CI job could not tell that CRLF checkout from a truncated shard,
  // because both exited 7. The predicate is `readWorkspace`'s own, so the one status that says
  // "no answer over this store is whole" is decided in one place; an audit finding is always
  // over a served record and always counts.
  // Every finding is asked the same question, whether the store raised it on load or the
  // audit derived it: does it name content this store holds and does not serve. `H03` and
  // `H04` report a threshold a team set over records that serve whole, so they print and
  // this exits 0; ADR-0026 records the classification.
  const hiding = [...all.value, ...audited].filter(hidesContent).length

  const block: Block = {
    columns: columnsOf(DOCTOR_SHAPE, 'findings'),
    shown: rows.length,
    total: rows.length,
    rows: rows.map((finding): Row => ({
      rule: finding.rule, id: finding.id, where: finding.where, detail: finding.detail,
    })),
  }

  const items = audit.checked
  const logged = events.value
  const data: Record<string, Value> = {
    store: identity.value.path ?? workspace,
    checked: items,
  }
  if (rows.length === 0) {
    data['clean'] = `checked ${items} ${items === 1 ? 'item' : 'items'} and ${logged} ${logged === 1 ? 'event' : 'events'}`
  } else if (hiding === 0) {
    data['serving'] = `${rows.length} ${rows.length === 1 ? 'finding reports' : 'findings report'} content this store still serves and the next write normalises; no record here is hidden`
  }
  data['findings'] = block
  // The table is the answer and the exit status is the verdict: a script or a CI job reads
  // "is my store intact" from the status alone, and a person reads the rows.
  return okResult(DOCTOR_SHAPE, { workspace, data, ...(hiding === 0 ? {} : { code: 'INTEGRITY' }) })
}
