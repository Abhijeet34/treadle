// SPDX-License-Identifier: Apache-2.0
// The two bounded facts an agent may add to an item after it is filed: how serious it is,
// and what it points at.
//
// Both are here rather than in a general field editor because both are audited. `mark`
// records a reason and an event carrying before and after, which is what makes lowering a
// defect's severity a thing the history can answer for; `evidence add` appends a pointer
// and never edits one, so the sequence in the log is the record of what was claimed when.
//
// Neither writes prose. A reason is bounded at MAX_REASON and an evidence label at
// MAX_EVIDENCE_LABEL, so the cheapest way to say "I tested it" stops being a paragraph.

import {
  BUG_SEVERITIES,
  EVIDENCE_KINDS,
  MAX_EVIDENCE_ENTRIES,
  MAX_REASON,
  fieldsOf,
  overLength,
  placeholderOf,
  validateWorkItem,
  writeCommand,
  type BugSeverity,
  type EvidenceKind,
  type EvidencePointer,
  type ItemId,
  type WorkItem,
} from '../../domain/index.ts'
import { errorResult, okResult, type ResultObject, type ResultShape, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import { readWorkspace, wholeItem } from './context.ts'
import { echoed, notFound } from './items.ts'
import { diffOf, makeEvent, snapshotOf, type Actor, type Target } from './mutation.ts'
import { storeRefusal } from './refusal.ts'

export const MARK_SHAPE: ResultShape = {
  command: 'mark',
  version: 1,
  effect: 'mutate',
  summary: 'Set the severity or the priority of one item, with the reason and both values in the log.',
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

export const EVIDENCE_SHAPE: ResultShape = {
  command: 'evidence',
  version: 1,
  effect: 'mutate',
  summary: 'Append one bounded pointer at an artefact a third party can open.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'string' },
    { kind: 'scalar', key: 'kind', type: 'string' },
    { kind: 'scalar', key: 'ref', type: 'string' },
    { kind: 'text', key: 'label' },
    { kind: 'scalar', key: 'entries', type: 'string' },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
  ],
}

/** The fields `mark` may move, which is the closed set the audit is over. */
const MARKED = ['severity', 'priority'] as const

export type MarkRequest = {
  readonly id: ItemId
  readonly severity?: string
  readonly priority?: string
  readonly reason?: string
  readonly actor: Actor
}

function refusal(command: string, workspace: string, rule: string, entity: string, cause: string, fix: readonly string[]): ResultObject {
  return errorResult({ code: 'VALIDATION', command, workspace, effect: 'mutate', rule, entity, cause, fix })
}

export async function markItem(
  target: Target, clock: Clock, ids: IdGenerator, request: MarkRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('mark', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const whole = await wholeItem(store, view.value, request.id)
  if (!whole.ok) return storeRefusal('mark', 'mutate', whole.error, workspace)
  const item = whole.value
  if (item === undefined) return notFound('mark', 'mutate', workspace, view.value, request.id)

  // Severity is a field of a bug and an impediment only, so the line offered names the one
  // this type carries: `--severity` on a task was refused as printed.
  if (request.severity === undefined && request.priority === undefined) {
    const field = fieldsOf(item.type).includes('severity') ? 'severity' : 'priority'
    return refusal('mark', workspace, 'C1', item.id,
      'mark sets a severity or a priority, and neither was given',
      [writeCommand(field, item.id, placeholderOf(field)) as string])
  }
  if (request.severity !== undefined && !(BUG_SEVERITIES as readonly string[]).includes(request.severity)) {
    return refusal('mark', workspace, 'C1', item.id,
      `${request.severity} is not a severity; the severities are ${BUG_SEVERITIES.join(', ')}`,
      ['treadle help mark'])
  }

  const draft: Record<string, unknown> = { ...item }
  if (request.severity !== undefined) draft['severity'] = request.severity as BugSeverity
  if (request.priority !== undefined) {
    draft['priority'] = Number.isInteger(Number(request.priority)) ? Number(request.priority) : request.priority
  }
  const after = draft as unknown as WorkItem
  const changes = diffOf(item, after, MARKED)

  if (changes.length === 0) {
    return okResult(MARK_SHAPE, {
      workspace, txn: null, changed: 0,
      data: { already: item.id, v: String(item.version) },
    })
  }

  // The reason is required only when something actually moves, so re-asserting the value an
  // item already carries stays the idempotent no-op above rather than a refusal for prose.
  if (request.reason === undefined || request.reason.trim() === '') {
    return refusal('mark', workspace, 'C1', item.id,
      `a change to ${changes.map((change) => change.field).join(' and ')} records a reason, and none was given`,
      [`treadle mark ${item.id} ${changes.map((c) => `--${c.field === 'severity' ? 'severity' : 'priority'} ${c.after}`).join(' ')} --reason "<why>"`])
  }
  if (request.reason.length > MAX_REASON) {
    return refusal('mark', workspace, 'T7', item.id, overLength('a reason', MAX_REASON, request.reason.length),
      ['treadle help mark'])
  }

  const now = clock.now()
  const valid = validateWorkItem(after, { now })
  if (!valid.ok) {
    return refusal('mark', workspace, valid.error.rule ?? 'V4', item.id, valid.error.message,
      [`treadle show ${item.id}`])
  }

  const set = changes.map((change) => `${change.field} ${echoed(change.before)} -> ${echoed(change.after)}`)
  if (mode === 'preview') {
    return okResult(MARK_SHAPE, {
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
      id: eventId, at: now, actor: request.actor, entity: item.id, op: 'item.mark',
      before: snapshotOf(changes, 'before'), after: snapshotOf(changes, 'after'),
      reason: request.reason, txn, command: 'mark',
    })],
  })
  if (!applied.ok) return storeRefusal('mark', 'mutate', applied.error, workspace)

  const written = applied.value.writes[0]
  const data: Record<string, Value> = {
    item: item.id,
    v: `${item.version} -> ${written?.version ?? item.version + 1}`,
    set,
  }
  if (mode === 'dry-run') {
    return okResult(MARK_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, dry_run: 1, would_exit: 0 } })
  }
  return okResult(MARK_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}

export type EvidenceRequest = {
  readonly id: ItemId
  readonly kind: string
  readonly ref: string
  readonly label?: string
  readonly actor: Actor
}

export async function addEvidence(
  target: Target, clock: Clock, ids: IdGenerator, request: EvidenceRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('evidence', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const whole = await wholeItem(store, view.value, request.id)
  if (!whole.ok) return storeRefusal('evidence', 'mutate', whole.error, workspace)
  const item = whole.value
  if (item === undefined) return notFound('evidence', 'mutate', workspace, view.value, request.id)

  if (!(EVIDENCE_KINDS as readonly string[]).includes(request.kind)) {
    return refusal('evidence', workspace, 'C1', item.id,
      `${request.kind} is not an evidence kind; the kinds are ${EVIDENCE_KINDS.join(', ')}`,
      ['treadle help evidence'])
  }

  const existing = item.evidence ?? []
  if (existing.length >= MAX_EVIDENCE_ENTRIES) {
    return refusal('evidence', workspace, 'V4', item.id,
      `${item.id} already carries ${existing.length} evidence entries and the limit is ${MAX_EVIDENCE_ENTRIES}`,
      [`treadle show ${item.id}`])
  }
  // Appended and never edited, so the same pointer twice is noise the list cannot shed.
  const duplicate = existing.find((entry) => entry.kind === request.kind && entry.ref === request.ref)
  if (duplicate !== undefined) {
    return refusal('evidence', workspace, 'V4', item.id,
      `${item.id} already points at ${request.kind} ${request.ref}`,
      [`treadle show ${item.id}`])
  }

  const pointer: EvidencePointer = request.label === undefined
    ? { kind: request.kind as EvidenceKind, ref: request.ref }
    : { kind: request.kind as EvidenceKind, ref: request.ref, label: request.label }
  const after = { ...item, evidence: [...existing, pointer] } as WorkItem

  const now = clock.now()
  const valid = validateWorkItem(after, { now })
  if (!valid.ok) {
    return refusal('evidence', workspace, valid.error.rule ?? 'V4', item.id, valid.error.message,
      ['treadle help evidence'])
  }

  const data: Record<string, Value> = {
    item: item.id,
    kind: pointer.kind,
    ref: pointer.ref,
    entries: `${after.evidence?.length ?? 0}/${MAX_EVIDENCE_ENTRIES}`,
  }
  if (pointer.label !== undefined) data['label'] = pointer.label

  if (mode === 'preview') {
    return okResult(EVIDENCE_SHAPE, {
      workspace, txn: null, changed: 0,
      data: {
        preview: 1, item: item.id, store: view.value.identity.path ?? workspace,
        note: 'nothing evaluated; use --dry-run for the outcome',
      },
    })
  }

  const txn = ids.txn()
  const eventId = ids.event()
  const applied = await store.apply({
    txn,
    writes: [{ item: after, ifVersion: item.version }],
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: item.id, op: 'item.evidence.add',
      after: pointer, txn, command: 'evidence',
    })],
  })
  if (!applied.ok) return storeRefusal('evidence', 'mutate', applied.error, workspace)

  const written = applied.value.writes[0]
  const versions = `${item.version} -> ${written?.version ?? item.version + 1}`
  if (mode === 'dry-run') {
    return okResult(EVIDENCE_SHAPE, {
      workspace, txn: null, changed: 0, data: { ...data, v: versions, dry_run: 1, would_exit: 0 },
    })
  }
  return okResult(EVIDENCE_SHAPE, { workspace, txn, changed: 1, data: { ...data, v: versions, event: eventId } })
}
