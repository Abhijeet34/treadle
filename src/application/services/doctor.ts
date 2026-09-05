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

import { MAX_DESCRIPTION, type ItemId, type WorkItem } from '../../domain/index.ts'
import { columnsOf, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Store, StoreEvent } from '../ports/store.ts'
import { hasReviewStep, readWorkspace, type WorkspaceView } from './context.ts'
import { storeRefusal } from './refusal.ts'

export const DOCTOR_SHAPE: ResultShape = {
  command: 'doctor',
  version: 1,
  effect: 'read',
  summary: 'Report what the stored files say that no write path would have accepted.',
  properties: [
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'checked', type: 'integer' },
    {
      kind: 'block',
      key: 'findings',
      columns: [{ name: 'rule' }, { name: 'id' }, { name: 'where' }, { name: 'detail', text: true }],
    },
    { kind: 'scalar', key: 'clean', type: 'string' },
  ],
}

export type DoctorFinding = {
  readonly rule: string
  readonly id: string
  readonly where: string
  /** One sentence. It may quote a stored value, so the column is marked as third party. */
  readonly detail: string
}

/** The audited fields whose divergence from the log is a finding, in report order. */
const MARKED_FIELDS = ['severity', 'priority'] as const

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
  item: WorkItem, events: readonly StoreEvent[],
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = []

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
    if (event.entity !== item.id || event.op !== 'item.mark') continue
    if (item.assignee === undefined || event.actor !== item.assignee) continue
    const after = event.after
    const changed = typeof after === 'object' && after !== null ? Object.keys(after).join(' and ') : 'a marked field'
    findings.push({
      rule: 'H19',
      id: item.id,
      where: event.id,
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

export function auditWorkspace(
  view: WorkspaceView, events: readonly StoreEvent[],
): readonly DoctorFinding[] {
  return view.items.flatMap((item) => auditItem(item, events))
}

export async function doctor(store: Store): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('doctor', 'read', view.error, undefined)
  const workspace = view.value.identity.id

  const stored = await store.findings()
  if (!stored.ok) return storeRefusal('doctor', 'read', stored.error, workspace)
  const events = await store.events()
  if (!events.ok) return storeRefusal('doctor', 'read', events.error, workspace)

  const rows: DoctorFinding[] = [
    ...stored.value.map((finding): DoctorFinding => ({
      rule: finding.rule,
      id: finding.id ?? '-',
      where: `${finding.file}:${finding.line}`,
      detail: finding.reason,
    })),
    ...auditWorkspace(view.value, events.value),
  ]

  const block: Block = {
    columns: columnsOf(DOCTOR_SHAPE, 'findings'),
    shown: rows.length,
    total: rows.length,
    rows: rows.map((finding): Row => ({
      rule: finding.rule, id: finding.id, where: finding.where, detail: finding.detail,
    })),
  }

  const data: Record<string, Value> = {
    store: view.value.identity.path ?? workspace,
    checked: view.value.items.length,
    findings: block,
  }
  if (rows.length === 0) data['clean'] = `checked ${view.value.items.length} items and ${events.value.length} events`
  return okResult(DOCTOR_SHAPE, { workspace, data })
}
