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
// reaches no read surface.
//
// The audit is one pass over the records and one over the log, and holds neither. It held
// both: 50,000 decoded records and 500,000 decoded events, 1,442 MiB allocated and a
// 1,043,456 KiB peak against a 102,400 KiB budget, to look at each once. What it keeps per
// item is the summary a scan reads plus the few findings decided off the whole record, and
// what it keeps per event is nothing; ADR-0021 carries the profile.

import {
  MAX_DESCRIPTION,
  findRelationCycle,
  relationGraphFrom,
  summaryOf,
  type ItemId,
  type RelationGraph,
  type WorkItem,
  type WorkItemSummary,
} from '../../domain/index.ts'
import { columnsOf, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Store, StoreEvent } from '../ports/store.ts'
import { hasReviewStep } from './context.ts'
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
    {
      kind: 'block',
      key: 'findings',
      columns: [{ name: 'rule' }, { name: 'id' }, { name: 'where' }, { name: 'detail', text: true }],
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
 * One item under audit: what a scan reads of it, the findings decided off its whole record
 * before the log is read, and what the log said about it once it has been.
 */
type Audited = {
  readonly item: WorkItemSummary
  /** H26 and H18, in that order. */
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
  /** H23 and H19, in log order. */
  fromLog?: DoctorFinding[]
}

/**
 * The audit, fed one record at a time and then one event at a time, and read once both
 * passes are over. The whole record is seen exactly once, at `record`, and the two findings
 * that need more of it than a summary carries are decided there.
 */
export class WorkspaceAudit {
  readonly #sprintIds: ReadonlySet<string>
  readonly #entries: Audited[] = []
  readonly #byId = new Map<ItemId, Audited>()

  constructor(sprintIds: ReadonlySet<string>) {
    this.#sprintIds = sprintIds
  }

  record(item: WorkItem): void {
    const before: DoctorFinding[] = []
    // No write path points an item at a sprint that is not a record: `file --sprint` and
    // `sprint commit` both resolve the id first. A value written before sprints were records,
    // or by hand, is reported rather than refused, because the item still serves.
    if (item.sprint_id !== undefined && !this.#sprintIds.has(item.sprint_id)) {
      before.push({
        rule: 'H26',
        id: item.id,
        where: 'sprint_id',
        detail: `sprint_id is ${item.sprint_id} and no sprint record carries that id; open one with --id ${item.sprint_id}, or commit the item to a sprint that exists`,
      })
    }
    if (item.description !== undefined && item.description.length > MAX_DESCRIPTION) {
      before.push({
        rule: 'H18',
        id: item.id,
        where: 'description',
        detail: `the stored description is ${item.description.length} characters and the bound is ${MAX_DESCRIPTION}; the long form belongs in a file this record points at`,
      })
    }
    const after = item.state === 'done' && hasReviewStep(item.type) && (item.evidence ?? []).length === 0
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
    const entry = this.#byId.get(event.entity)
    if (entry === undefined) return
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
    if (Date.parse(event.at) < Date.parse(item.filed_at)) {
      (entry.fromLog ??= []).push({
        rule: 'H23',
        id: item.id,
        where: cell(event.id),
        detail: `event ${event.id} is dated ${event.at}, before the item was filed at ${item.filed_at}; no write path records a change to an item that does not exist yet`,
      })
    }
    if (event.op !== 'item.mark') return
    if (item.assignee === undefined || event.actor !== item.assignee) return
    const changed = typeof after === 'object' && after !== null ? Object.keys(after).join(' and ') : 'a marked field'
    ;(entry.fromLog ??= []).push({
      rule: 'H19',
      id: item.id,
      where: cell(event.id),
      detail: `${event.actor} changed ${changed} on an item they are assigned; the audit says who and a reader decides`,
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
    findings.push(...(entry.fromLog ?? NONE), ...entry.after)
    return findings
  }

  /** The findings of the one item `record` was given, which is what `explain` reads. */
  ofOne(): readonly DoctorFinding[] {
    const only = this.#entries[0]
    return only === undefined ? NONE : this.#ofItem(only)
  }

  /** Every finding over the workspace, in item then rule order, the cycle check last. */
  findings(): readonly DoctorFinding[] {
    const known = new Set(this.#byId.keys())
    return [
      ...this.#entries.flatMap((entry) => [
        ...this.#ofItem(entry),
        ...auditRelationsOf(known, entry.item),
        ...auditImpediment(entry.item),
      ]),
      ...storedBlockingCycle(relationGraphFrom(this.#entries.map((entry) => entry.item))),
    ]
  }

  get checked(): number {
    return this.#entries.length
  }
}

/** The findings of one item against its own slice of the log, in rule order. */
export function auditItem(
  item: WorkItem, events: readonly StoreEvent[], sprintIds: ReadonlySet<string>,
): readonly DoctorFinding[] {
  const audit = new WorkspaceAudit(sprintIds)
  audit.record(item)
  for (const event of events) audit.event(event)
  return audit.ofOne()
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

export async function doctor(store: Store): Promise<ResultObject> {
  const identity = await store.identity()
  if (!identity.ok) return storeRefusal('doctor', 'read', identity.error, undefined)
  const workspace = identity.value.id

  const stored = await store.findings()
  if (!stored.ok) return storeRefusal('doctor', 'read', stored.error, workspace)
  const sprints = await store.sprints()
  if (!sprints.ok) return storeRefusal('doctor', 'read', sprints.error, workspace)
  const audit = new WorkspaceAudit(new Set(sprints.value.map((sprint) => sprint.id)))
  // The audit reads every field of every record against its events, so this is the one
  // command that decodes the whole store; it holds one record and one event at a time.
  const records = await store.eachItem({}, (item) => audit.record(item))
  if (!records.ok) return storeRefusal('doctor', 'read', records.error, workspace)
  const events = await store.eachEvent({}, (event) => audit.event(event))
  if (!events.ok) return storeRefusal('doctor', 'read', events.error, workspace)

  const rows: DoctorFinding[] = [
    ...stored.value.map((finding): DoctorFinding => ({
      rule: finding.rule,
      id: finding.id === undefined ? '-' : cell(finding.id),
      where: `${cell(finding.file)}:${finding.line}`,
      detail: finding.reason,
    })),
    ...audit.findings(),
  ]

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
  }
  data['findings'] = block
  // The table is the answer and the exit status is the verdict: a script or a CI job reads
  // "is my store intact" from the status alone, and a person reads the rows.
  return okResult(DOCTOR_SHAPE, { workspace, data, ...(rows.length === 0 ? {} : { code: 'INTEGRITY' }) })
}
