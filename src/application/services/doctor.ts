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

import {
  MAX_DESCRIPTION,
  findRelationCycle,
  relationGraphFrom,
  type ItemId,
  type RelationGraph,
  type WorkItem,
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

function renderField(item: WorkItem, field: string): string {
  const value = (item as unknown as Record<string, unknown>)[field]
  return value === undefined || value === null ? '-' : String(value)
}

/**
 * The value the log last recorded for one field of one item, folded forward over every
 * event that named it. `undefined` means the log never carried the field, which is what a
 * workspace written before the file event carried its fields looks like: silence there is
 * not evidence of an edit, so no finding is raised on it.
 */
function loggedValue(events: readonly StoreEvent[], id: ItemId, field: string): string | undefined {
  let seen: string | undefined
  for (const event of events) {
    if (event.entity !== id) continue
    const after = event.after
    if (typeof after !== 'object' || after === null) continue
    const value = (after as Record<string, unknown>)[field]
    if (typeof value === 'string') seen = value
  }
  return seen
}

/** Every audit finding over one workspace, in item then rule order. */
export function auditItem(
  item: WorkItem, events: readonly StoreEvent[], sprintIds: ReadonlySet<string>,
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = []

  // No write path points an item at a sprint that is not a record: `file --sprint` and
  // `sprint commit` both resolve the id first. A value written before sprints were records,
  // or by hand, is reported rather than refused, because the item still serves.
  if (item.sprint_id !== undefined && !sprintIds.has(item.sprint_id)) {
    findings.push({
      rule: 'H26',
      id: item.id,
      where: 'sprint_id',
      detail: `sprint_id is ${item.sprint_id} and no sprint record carries that id; open one with --id ${item.sprint_id}, or commit the item to a sprint that exists`,
    })
  }

  if (item.description !== undefined && item.description.length > MAX_DESCRIPTION) {
    findings.push({
      rule: 'H18',
      id: item.id,
      where: 'description',
      detail: `the stored description is ${item.description.length} characters and the bound is ${MAX_DESCRIPTION}; the long form belongs in a file this record points at`,
    })
  }

  for (const field of MARKED_FIELDS) {
    const logged = loggedValue(events, item.id, field)
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

  for (const event of events) {
    if (event.entity !== item.id) continue
    if (Date.parse(event.at) < Date.parse(item.filed_at)) {
      findings.push({
        rule: 'H23',
        id: item.id,
        where: cell(event.id),
        detail: `event ${event.id} is dated ${event.at}, before the item was filed at ${item.filed_at}; no write path records a change to an item that does not exist yet`,
      })
    }
    if (event.op !== 'item.mark') continue
    if (item.assignee === undefined || event.actor !== item.assignee) continue
    const after = event.after
    const changed = typeof after === 'object' && after !== null ? Object.keys(after).join(' and ') : 'a marked field'
    findings.push({
      rule: 'H19',
      id: item.id,
      where: cell(event.id),
      detail: `${event.actor} changed ${changed} on an item they are assigned; the audit says who and a reader decides`,
    })
  }

  if (item.state === 'done' && hasReviewStep(item.type) && (item.evidence ?? []).length === 0) {
    findings.push({
      rule: 'H21',
      id: item.id,
      where: 'evidence',
      detail: 'the item is done and points at no evidence, which DOD7 refuses; it was closed by a hand edit or before that rule',
    })
  }

  return findings
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
 * An open impediment that blocks nothing (H27). An impediment earns its keep through the
 * `blocks` edge, which is stored on its own record, so this needs no other record to see: one
 * raised against no work is a complaint on file, and the detail names the line that raises it
 * against something. A resolved or cancelled one is history and is not reported.
 */
export function auditImpediment(item: Pick<WorkItem, 'id' | 'type' | 'state' | 'relations'>): readonly DoctorFinding[] {
  if (item.type !== 'impediment' || item.state === 'done' || item.state === 'cancelled') return []
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

/**
 * One pass over the log, then one pass over each item's own slice of it. `auditItem` filters
 * by entity itself, so handing every item the whole log made this O(items x events): measured
 * on the bench corpora, `doctor` took 375 ms at 100 items and 1,000 events, 1,338 ms at 1,000
 * and 10,000, 273,554 ms at 10,000 and 100,000, and did not finish inside ten minutes at
 * 50,000 and 500,000. The buckets cost one map of the log and make it linear in both.
 */
export function auditWorkspace(
  items: readonly WorkItem[], events: readonly StoreEvent[], sprintIds: ReadonlySet<string>,
): readonly DoctorFinding[] {
  const byEntity = new Map<string, StoreEvent[]>()
  for (const event of events) {
    const bucket = byEntity.get(event.entity)
    if (bucket === undefined) byEntity.set(event.entity, [event])
    else bucket.push(event)
  }
  const known = new Set(items.map((item) => item.id))
  return [
    ...items.flatMap((item) => [
      ...auditItem(item, byEntity.get(item.id) ?? [], sprintIds),
      ...auditRelationsOf(known, item),
      ...auditImpediment(item),
    ]),
    ...storedBlockingCycle(relationGraphFrom(items)),
  ]
}

export async function doctor(store: Store): Promise<ResultObject> {
  const identity = await store.identity()
  if (!identity.ok) return storeRefusal('doctor', 'read', identity.error, undefined)
  const workspace = identity.value.id

  const stored = await store.findings()
  if (!stored.ok) return storeRefusal('doctor', 'read', stored.error, workspace)
  const events = await store.events()
  if (!events.ok) return storeRefusal('doctor', 'read', events.error, workspace)
  // The audit reads every field of every record against its events, so this is the one
  // command that decodes the whole store rather than reading the view every other one does.
  const records = await store.list()
  if (!records.ok) return storeRefusal('doctor', 'read', records.error, workspace)
  const sprints = await store.sprints()
  if (!sprints.ok) return storeRefusal('doctor', 'read', sprints.error, workspace)
  const sprintIds = new Set(sprints.value.map((sprint) => sprint.id))

  const rows: DoctorFinding[] = [
    ...stored.value.map((finding): DoctorFinding => ({
      rule: finding.rule,
      id: finding.id === undefined ? '-' : cell(finding.id),
      where: `${cell(finding.file)}:${finding.line}`,
      detail: finding.reason,
    })),
    ...auditWorkspace(records.value, events.value, sprintIds),
  ]

  const block: Block = {
    columns: columnsOf(DOCTOR_SHAPE, 'findings'),
    shown: rows.length,
    total: rows.length,
    rows: rows.map((finding): Row => ({
      rule: finding.rule, id: finding.id, where: finding.where, detail: finding.detail,
    })),
  }

  const items = records.value.length
  const logged = events.value.length
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
