// SPDX-License-Identifier: Apache-2.0
// The three item use cases: file one, show one, list them. Each builds one result object and
// renders nothing; the shape beside each is what the schema under schemas/ is generated from.

import {
  validateWorkItem,
  type AcceptanceCriterion,
  type ItemId,
  type WorkItem,
  type WorkItemState,
  type WorkItemType,
} from '../../domain/index.ts'
import {
  errorResult,
  okResult,
  type Block,
  type ColumnSpec,
  type ResultObject,
  type ResultShape,
  type Row,
  type Value,
} from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import type { Store, StoreError } from '../ports/store.ts'
import { readWorkspace, type WorkspaceView } from './context.ts'
import { diffOf, makeEvent, type Actor, type Mode } from './mutation.ts'
import { storeRefusal } from './refusal.ts'

/** Columns a list row may carry. `text` marks free text, which the renderer places last (F3). */
export const ITEM_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id' },
  { name: 'type' },
  { name: 'state' },
  { name: 'pts' },
  { name: 'pri' },
  { name: 'sprint' },
  { name: 'assignee', text: true },
  { name: 'title', text: true },
]

export const DEFAULT_BACKLOG_COLUMNS = ['id', 'type', 'state', 'pts', 'title'] as const

export const FILE_SHAPE: ResultShape = {
  command: 'file',
  version: 1,
  effect: 'mutate',
  summary: 'File one work item of a type, and report the fields it was created with.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'type', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'text', key: 'title' },
    { kind: 'list', key: 'set' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
  ],
}

export const SHOW_SHAPE: ResultShape = {
  command: 'show',
  version: 1,
  effect: 'read',
  summary: 'Print the stored fields of one item.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'type', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'scalar', key: 'filed', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'integer' },
    { kind: 'scalar', key: 'pts', type: 'integer' },
    { kind: 'scalar', key: 'pri', type: 'integer' },
    { kind: 'scalar', key: 'sprint', type: 'string' },
    { kind: 'scalar', key: 'parent', type: 'string' },
    { kind: 'scalar', key: 'ac', type: 'string' },
    { kind: 'text', key: 'assignee' },
    { kind: 'text', key: 'title' },
    { kind: 'text', key: 'desc' },
  ],
}

export const BACKLOG_SHAPE: ResultShape = {
  command: 'backlog',
  version: 1,
  effect: 'read',
  summary: 'List the items that match a filter, in one stated order.',
  properties: [
    { kind: 'list', key: 'filter' },
    { kind: 'scalar', key: 'sort', type: 'string' },
    { kind: 'block', key: 'items', columns: ITEM_COLUMNS },
    { kind: 'scalar', key: 'points', type: 'integer' },
    { kind: 'scalar', key: 'done', type: 'integer' },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'narrowest', type: 'string' },
    { kind: 'scalar', key: 'absent', type: 'string' },
    { kind: 'scalar', key: 'clause', type: 'string' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'more', type: 'integer' },
    { kind: 'scalar', key: 'page', type: 'string' },
  ],
}

const SLUG_TRIM = /^[^a-z0-9]+|[^a-z0-9]+$/g

/** A readable id a person reviewing the file recognises, deduped against what is stored. */
export function slugFor(title: string, type: WorkItemType, taken: ReadonlySet<string>): ItemId {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(SLUG_TRIM, '')
    .slice(0, 24)
    .replace(SLUG_TRIM, '')
  let head = base.length >= 3 ? base : `${type}-${base}`.replace(SLUG_TRIM, '')
  if (head.length < 3) head = `${type}-item`
  if (!taken.has(head)) return head
  for (let n = 2; ; n += 1) {
    const candidate = `${head}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export type FileRequest = {
  readonly type: WorkItemType
  readonly title: string
  /** A caller-chosen id; absent, the id is a slug of the title, deduped against the store. */
  readonly id?: ItemId
  readonly fields: Readonly<Record<string, string>>
  readonly actor: Actor
  readonly mode: Mode
}

const INT_FIELDS = new Set(['priority', 'points', 'hours_estimate', 'timebox_hours'])
const LIST_FIELDS = new Set(['labels'])
const CRITERIA_FIELDS = new Set(['acceptance_criteria'])

function coerce(name: string, value: string): unknown {
  if (INT_FIELDS.has(name)) return Number.isInteger(Number(value)) ? Number(value) : value
  if (name === 'fix_confirmed') return value === 'true' ? true : value === 'false' ? false : value
  if (LIST_FIELDS.has(name)) return value.split(',').filter((part) => part.length > 0)
  if (CRITERIA_FIELDS.has(name)) {
    return value.split('|').filter((part) => part.length > 0).map((text): AcceptanceCriterion => ({ text, ticked: false }))
  }
  return value
}

/** The fields a `file` reports as set, in the field dictionary's order. */
const REPORTED = [
  'type', 'state', 'filed_at', 'priority', 'points', 'hours_estimate', 'parent_id',
  'assignee', 'reporter', 'reviewer', 'component', 'labels', 'sprint_id',
  'outcome', 'target_date', 'severity', 'repro_steps', 'expected', 'actual', 'found_in',
  'fix_confirmed', 'question', 'timebox_hours', 'findings',
] as const

export async function fileItem(
  store: Store, clock: Clock, ids: IdGenerator, request: FileRequest,
): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('file', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id

  const now = clock.now()
  const id = request.id ?? slugFor(request.title, request.type, new Set(view.value.byId.keys()))
  const draft: Record<string, unknown> = {
    id, type: request.type, state: 'draft', title: request.title, filed_at: now, version: 1,
  }
  for (const [name, value] of Object.entries(request.fields)) draft[name] = coerce(name, value)

  const item = draft as unknown as WorkItem
  const valid = validateWorkItem(item, { now })
  if (!valid.ok) {
    return errorResult({
      code: 'VALIDATION', command: 'file', workspace, effect: 'mutate',
      rule: valid.error.rule ?? 'V4', entity: id, cause: valid.error.message,
      fix: [`treadle help file`],
    })
  }

  const txn = ids.txn()
  const eventId = ids.event()
  const changes = diffOf(undefined, item, REPORTED)
  const data: Record<string, Value> = {
    item: id,
    type: request.type,
    state: 'draft',
    title: request.title,
    set: changes.map((change) => `${change.field} ${change.before} -> ${change.after}`),
  }

  if (request.mode === 'preview') {
    return okResult(FILE_SHAPE, {
      workspace, txn: null, changed: 0,
      data: {
        item: id, type: request.type, title: request.title, preview: 1,
        store: view.value.identity.path ?? '-',
        note: 'guards not evaluated; use --dry-run for the outcome',
      },
    })
  }

  const applied = await store.apply({
    txn,
    writes: [{ item }],
    events: [makeEvent({
      id: eventId, at: now, actor: request.actor, entity: id, op: 'item.file',
      after: { state: 'draft', type: request.type }, txn, command: 'file',
    })],
  })
  if (!applied.ok) return storeRefusal('file', 'mutate', applied.error, workspace)

  if (request.mode === 'dry-run') {
    return okResult(FILE_SHAPE, {
      workspace, txn: null, changed: 0,
      data: { ...data, dry_run: 1, would_exit: 0 },
    })
  }
  return okResult(FILE_SHAPE, {
    workspace, txn, changed: 1,
    data: { ...data, event: eventId },
  })
}

function tickedOf(criteria: readonly AcceptanceCriterion[] | undefined): string | undefined {
  if (criteria === undefined || criteria.length === 0) return undefined
  return `${criteria.filter((criterion) => criterion.ticked).length}/${criteria.length}`
}

export async function showItem(store: Store, id: ItemId, field?: string): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('show', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  const item = view.value.byId.get(id)
  if (item === undefined) return notFound('show', workspace, view.value, id)

  const data: Record<string, Value> = {
    item: item.id,
    type: item.type,
    state: item.state,
    filed: item.filed_at,
    v: item.version,
    title: item.title,
  }
  if (item.points !== undefined) data['pts'] = item.points
  if (item.priority !== undefined) data['pri'] = item.priority
  if (item.sprint_id !== undefined) data['sprint'] = item.sprint_id
  if (item.parent_id !== undefined) data['parent'] = item.parent_id
  const ticked = tickedOf(item.acceptance_criteria)
  if (ticked !== undefined) data['ac'] = ticked
  if (item.assignee !== undefined) data['assignee'] = item.assignee
  if (item.description !== undefined) data['desc'] = item.description

  if (field === undefined) return okResult(SHOW_SHAPE, { workspace, data })
  if (!(field in data)) {
    const known = SHOW_SHAPE.properties.map((property) => property.key).filter((key) => key !== 'item')
    return errorResult({
      code: 'VALIDATION', command: 'show', workspace, effect: 'read', rule: 'C2', entity: item.id,
      cause: `${item.id} carries no field named ${field}; this record has ${known.filter((key) => key in data).join(', ')}`,
      fix: [`treadle show ${item.id}`],
    })
  }
  return okResult(SHOW_SHAPE, { workspace, data: { item: item.id, [field]: data[field] as Value } })
}

/** One filter clause, kept in the order it was written so a tie names the first (A.4). */
export type Filter = {
  readonly field: 'state' | 'type' | 'sprint' | 'assignee' | 'priority'
  readonly value: string
}

function fieldOf(item: WorkItem, field: Filter['field']): string | undefined {
  if (field === 'state') return item.state
  if (field === 'type') return item.type
  if (field === 'sprint') return item.sprint_id
  if (field === 'assignee') return item.assignee
  return item.priority === undefined ? undefined : String(item.priority)
}

function matches(item: WorkItem, filters: readonly Filter[]): boolean {
  return filters.every((filter) => fieldOf(item, filter.field) === filter.value)
}

const NO_PRIORITY = 6

export function backlogOrder(a: WorkItem, b: WorkItem): number {
  const priority = (a.priority ?? NO_PRIORITY) - (b.priority ?? NO_PRIORITY)
  if (priority !== 0) return priority
  if (a.filed_at !== b.filed_at) return a.filed_at < b.filed_at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function rowFor(item: WorkItem, columns: readonly string[]): Row {
  const row: Record<string, string | number | null> = {}
  for (const column of columns) {
    if (column === 'id') row[column] = item.id
    else if (column === 'type') row[column] = item.type
    else if (column === 'state') row[column] = item.state
    else if (column === 'pts') row[column] = item.points ?? null
    else if (column === 'pri') row[column] = item.priority ?? null
    else if (column === 'sprint') row[column] = item.sprint_id ?? null
    else if (column === 'assignee') row[column] = item.assignee ?? null
    else if (column === 'title') row[column] = item.title
    else row[column] = null
  }
  return row
}

export type BacklogRequest = {
  readonly filters: readonly Filter[]
  readonly columns: readonly string[]
  readonly limit: number
  readonly cursor?: string
  readonly explainAbsence?: ItemId
}

export function columnsFor(names: readonly string[]): readonly ColumnSpec[] {
  return names.map((name) => ITEM_COLUMNS.find((column) => column.name === name) ?? { name })
}

export async function backlog(store: Store, request: BacklogRequest): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('backlog', 'read', view.error, undefined)
  const workspace = view.value.identity.id

  const unknown = request.columns.find((name) => !ITEM_COLUMNS.some((column) => column.name === name))
  if (unknown !== undefined) {
    return errorResult({
      code: 'VALIDATION', command: 'backlog', workspace, effect: 'read', rule: 'C2',
      cause: `${unknown} is not a column of this list; the columns are ${ITEM_COLUMNS.map((c) => c.name).join(', ')}`,
      fix: ['treadle help backlog'],
    })
  }

  const matched = view.value.items.filter((item) => matches(item, request.filters)).sort(backlogOrder)
  const start = request.cursor === undefined ? 0 : matched.findIndex((item) => item.id === request.cursor)
  const from = start < 0 ? 0 : start
  const page = matched.slice(from, from + request.limit)
  const block: Block = {
    columns: columnsFor(request.columns),
    shown: page.length,
    total: matched.length,
    rows: page.map((item) => rowFor(item, request.columns)),
  }

  const data: Record<string, Value> = {}
  if (request.filters.length > 0) {
    data['filter'] = request.filters.map((filter) => `${filter.field} ${filter.value}`)
  }
  data['sort'] = 'priority, filed, id'
  data['items'] = block
  data['points'] = page.reduce((sum, item) => sum + (item.points ?? 0), 0)
  data['done'] = page
    .filter((item) => item.state === 'done')
    .reduce((sum, item) => sum + (item.points ?? 0), 0)

  if (matched.length === 0) {
    data['none'] = `searched ${view.value.items.length} matched 0`
    const narrowest = narrowestClause(view.value.items, request.filters)
    if (narrowest !== undefined) data['narrowest'] = narrowest
  }

  if (request.explainAbsence !== undefined) {
    Object.assign(data, absence(view.value, request.filters, request.explainAbsence))
  }

  const remaining = matched.length - (from + page.length)
  if (remaining > 0) {
    data['more'] = remaining
    const next = matched[from + page.length]
    if (next !== undefined) data['page'] = `treadle backlog --cursor ${next.id}`
  }
  return okResult(BACKLOG_SHAPE, { workspace, data })
}

/** The clause whose own selectivity was lowest, so a caller learns which term to relax. */
function narrowestClause(items: readonly WorkItem[], filters: readonly Filter[]): string | undefined {
  let best: { readonly filter: Filter; readonly hits: number } | undefined
  for (const filter of filters) {
    const hits = items.filter((item) => fieldOf(item, filter.field) === filter.value).length
    if (best === undefined || hits < best.hits) best = { filter, hits }
  }
  return best === undefined ? undefined : `${best.filter.field} ${best.filter.value} ${best.hits}`
}

/** The first clause that excluded the id, or the store that was searched when it is nowhere. */
function absence(
  view: WorkspaceView, filters: readonly Filter[], id: ItemId,
): Readonly<Record<string, Value>> {
  const item = view.byId.get(id)
  if (item === undefined) {
    return { absent: id, store: view.identity.path ?? view.identity.id, clause: `unknown searched ${view.items.length}` }
  }
  for (const filter of filters) {
    const got = fieldOf(item, filter.field)
    if (got !== filter.value) {
      return { absent: id, clause: `${filter.field} want ${filter.value} got ${got ?? '-'}` }
    }
  }
  return { absent: id, clause: 'none; it matched every clause' }
}

/** Up to three candidates by edit distance then id order, never auto-corrected (A.6 rule 4). */
export function nearIds(known: Iterable<ItemId>, wanted: ItemId): readonly ItemId[] {
  return [...known]
    .map((id) => ({ id, distance: editDistance(id, wanted) }))
    .filter((candidate) => candidate.distance <= Math.max(2, Math.floor(wanted.length / 3)))
    .sort((a, b) => (a.distance === b.distance ? (a.id < b.id ? -1 : 1) : a.distance - b.distance))
    .slice(0, 3)
    .map((candidate) => candidate.id)
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current.push(Math.min(substitution, (previous[j] as number) + 1, (current[j - 1] as number) + 1))
    }
    previous = current
  }
  return previous[b.length] as number
}

export function notFound(
  command: string, workspace: string, view: WorkspaceView, id: ItemId,
): ResultObject {
  return errorResult({
    code: 'NOT_FOUND', command, workspace, effect: 'read', rule: 'S1', entity: id,
    cause: `${id} is in no record file of ${view.identity.path ?? view.identity.id}, which holds ${view.items.length} items`,
    near: nearIds(view.byId.keys(), id),
    fix: ['treadle backlog'],
  })
}

export type { StoreError, WorkItemState }
