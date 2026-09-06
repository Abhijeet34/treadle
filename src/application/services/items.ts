// SPDX-License-Identifier: Apache-2.0
// The three item use cases: file one, show one, list them. Each builds one result object and
// renders nothing; the shape beside each is what the schema under schemas/ is generated from.

import {
  ALLOWED_PARENT_PAIRS,
  canonicalField,
  daysOverdue,
  evaluateCommit,
  placeholderOf,
  relationsOf,
  requiredAtCreation,
  setParent,
  shellWord,
  shortField,
  validateWorkItem,
  type AcceptanceCriterion,
  type ItemId,
  type WorkItem,
  type WorkItemSummary,
  type WorkItemType,
} from '../../domain/index.ts'
import {
  columnsOf,
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
import type { Store } from '../ports/store.ts'
import { readWorkspace, readyVerdict, wholeItem, type WorkspaceView } from './context.ts'
import { AUDITED_FIELDS, diffOf, makeEvent, snapshotOf, type Actor, type Target } from './mutation.ts'
import { storeRefusal, unknownCursor } from './refusal.ts'

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
  { name: 'sev' },
]

/**
 * `sev` is in the default set because severity was required at creation and then printed
 * nowhere: a caller triaging defects had no read surface that carried it. It costs one `-`
 * cell on a non-bug row, which is what `pts` already costs an unestimated one.
 */
export const DEFAULT_BACKLOG_COLUMNS = ['id', 'type', 'state', 'pts', 'sev', 'title'] as const

/** The page size every list defaults to; `next` has its own, smaller one. */
export const DEFAULT_LIMIT = 9

type CarriedFlag = readonly [name: string, value: string | true | undefined]

/**
 * A command line the reader runs as printed, carrying every flag that shaped this answer.
 * A `page` line built from the command word and the cursor alone walked a different list
 * than the page it followed: `backlog --state draft --limit 2` printed a cursor whose page
 * was six unfiltered rows. An absent flag is one the caller left at its default, so it is
 * left off here too and the line stays the caller's own; a value is one the tool matched or
 * validated, quoted where a shell would split it.
 */
export function invocation(command: string, operands: readonly string[], flags: readonly CarriedFlag[]): string {
  const words = [`treadle ${command}`, ...operands.map(shellWord)]
  for (const [name, value] of flags) {
    if (value === undefined) continue
    words.push(`--${name}`)
    if (value !== true) words.push(shellWord(value))
  }
  return words.join(' ')
}

/** The filter, column and limit flags a list was asked with, for the line that continues it. */
export function listFlags(
  filters: readonly Filter[], columns: readonly string[], defaults: readonly string[], limit: number,
): readonly CarriedFlag[] {
  const chosen = columns.length === defaults.length && columns.every((name, at) => name === defaults[at])
  return [
    ...filters.map((filter): CarriedFlag => [filter.field, filter.value]),
    ['fields', chosen ? undefined : columns.join(',')],
    ['limit', limit === DEFAULT_LIMIT ? undefined : String(limit)],
  ]
}

export const FILE_SHAPE: ResultShape = {
  command: 'file',
  version: 1,
  effect: 'mutate',
  summary: 'File one work item of a type, and report the fields it was created with.',
  properties: [
    { kind: 'scalar', key: 'item', type: 'string' },
    { kind: 'scalar', key: 'type', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'text', key: 'title', whole: true },
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
    { kind: 'scalar', key: 'due', type: 'string' },
    { kind: 'scalar', key: 'overdue', type: 'integer' },
    { kind: 'scalar', key: 'resolution', type: 'string' },
    { kind: 'text', key: 'assignee' },
    { kind: 'text', key: 'title', whole: true },
    { kind: 'text', key: 'desc' },
    { kind: 'scalar', key: 'sev', type: 'string' },
    // Everything below reached no read surface at all until the field sweep, so it is
    // appended rather than placed: STABILITY's output-schema rule makes a field added at the
    // end of the property order a non-breaking change and a reordering a breaking one, and
    // the line rendering is a projection of this order. A field absent from a record is an
    // absent line, so a story pays nothing for a bug's six.
    { kind: 'scalar', key: 'hrs', type: 'integer' },
    { kind: 'scalar', key: 'labels', type: 'string' },
    { kind: 'scalar', key: 'found', type: 'string' },
    { kind: 'scalar', key: 'fixed', type: 'boolean' },
    { kind: 'scalar', key: 'timebox', type: 'integer' },
    { kind: 'scalar', key: 'hold_until', type: 'string' },
    { kind: 'scalar', key: 'held_from', type: 'string' },
    { kind: 'scalar', key: 'extra', type: 'integer' },
    { kind: 'text', key: 'reporter' },
    { kind: 'text', key: 'reviewer' },
    { kind: 'text', key: 'component' },
    { kind: 'text', key: 'hold' },
    { kind: 'text', key: 'outcome' },
    { kind: 'text', key: 'question' },
    { kind: 'text', key: 'repro' },
    { kind: 'text', key: 'expected' },
    { kind: 'text', key: 'actual' },
    { kind: 'text', key: 'findings' },
    // The impediment's own field, after the last text and before the first block, which is
    // where every text the field sweep appended went: cut at 64 cells here and printed
    // whole under `show <id> --field proposed_resolution`.
    { kind: 'text', key: 'proposed_resolution' },
    {
      kind: 'block',
      key: 'evidence',
      columns: [{ name: 'kind' }, { name: 'ref' }, { name: 'label', text: true }],
    },
    // Appended after `evidence`, which STABILITY's output-schema rule makes a non-breaking
    // addition. `ac` above stays the tick count; this is the text the count is over, which
    // no read surface carried: a story's criteria were written, committed and unreadable.
    {
      kind: 'block',
      key: 'criteria',
      columns: [{ name: 'n' }, { name: 'tick' }, { name: 'text', text: true }],
    },
    // Every edge this item is on: a stored edge under its own kind, and one stored on the
    // other record under the inverse (`blocked_by`, `duplicated_by`), so a reader sees
    // both directions and can tell from the name which record holds the edge.
    {
      kind: 'block',
      key: 'relations',
      columns: [{ name: 'kind' }, { name: 'other' }],
    },
  ],
}

export const BACKLOG_SHAPE: ResultShape = {
  command: 'backlog',
  // v2 renamed the completed-points scalar from `done` to `done_points`; schemas/README.md
  // is the rule that a change to a shape's properties bumps the shape.
  version: 2,
  effect: 'read',
  summary: 'List the items that match a filter, in one stated order.',
  properties: [
    { kind: 'scalar', key: 'filter', type: 'string' },
    { kind: 'scalar', key: 'sort', type: 'string' },
    { kind: 'scalar', key: 'points', type: 'integer' },
    { kind: 'scalar', key: 'done_points', type: 'integer' },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'narrowest', type: 'string' },
    { kind: 'scalar', key: 'absent', type: 'string' },
    { kind: 'scalar', key: 'clause', type: 'string' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'more', type: 'integer' },
    { kind: 'scalar', key: 'page', type: 'string' },
    { kind: 'block', key: 'items', columns: ITEM_COLUMNS },
  ],
}

const SLUG_TRIM = /^[^a-z0-9]+|[^a-z0-9]+$/g

/** The dictionary allows 64 characters; a slug stops here, at the last whole word under it. */
const SLUG_LIMIT = 32

/**
 * An id is the thing every command, diff and event names, and a person reads it hundreds of
 * times, so it stops at a word rather than at a byte: cutting at 24 produced ids that read
 * `saml-login-for-enterpris`. The first hyphen at or before the limit is the word boundary,
 * and a first word longer than the limit is cut at the limit because there is no boundary.
 */
function slugHead(base: string): string {
  if (base.length <= SLUG_LIMIT) return base
  if (base[SLUG_LIMIT] === '-') return base.slice(0, SLUG_LIMIT)
  const boundary = base.lastIndexOf('-', SLUG_LIMIT)
  return boundary >= 3 ? base.slice(0, boundary) : base.slice(0, SLUG_LIMIT)
}

/**
 * A readable id a person reviewing the file recognises, deduped against what is stored.
 * `kind` is the word a too-short title is prefixed with: the item's type, or `sprint`.
 */
export function slugFor(title: string, kind: string, taken: ReadonlySet<string>): ItemId {
  const base = slugHead(title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(SLUG_TRIM, ''))
    .replace(SLUG_TRIM, '')
  let head = base.length >= 3 ? base : `${kind}-${base}`.replace(SLUG_TRIM, '')
  if (head.length < 3) head = `${kind}-item`
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
}

const INT_FIELDS = new Set(['priority', 'points', 'hours_estimate', 'timebox_hours'])
const LIST_FIELDS = new Set(['labels'])
const CRITERIA_FIELDS = new Set(['acceptance_criteria'])

/**
 * A leading `[x] ` or `[ ] ` on an acceptance criterion, which is how the tick is written on
 * the one grammar that carries the list. DOD4 fails until every criterion is ticked, so the
 * list has to be settable ticked or its remedy names a command that cannot perform it.
 */
const CRITERIA_TICK = /^\[([ x])\] /

/**
 * One `<field>=<value>` string as the dictionary's own type for that field. An empty value
 * is the field's absence: no field in the dictionary accepts the empty string, and the two
 * list fields already read `labels=` as an empty list, so `<field>=` is the one clearing
 * syntax rather than a sentinel that some prose field could legitimately hold as its value.
 */
export function coerce(name: string, value: string): unknown {
  if (value === '') return undefined
  if (INT_FIELDS.has(name)) return Number.isInteger(Number(value)) ? Number(value) : value
  if (name === 'fix_confirmed') return value === 'true' ? true : value === 'false' ? false : value
  if (LIST_FIELDS.has(name)) return value.split(',').filter((part) => part.length > 0)
  if (CRITERIA_FIELDS.has(name)) {
    return value.split('|').filter((part) => part.length > 0).map((part): AcceptanceCriterion => {
      const tick = CRITERIA_TICK.exec(part)
      return tick === null
        ? { text: part, ticked: false }
        : { text: part.slice((tick[0] as string).length), ticked: tick[1] === 'x' }
    })
  }
  return value
}

/** The fields a `file` reports as set, in the field dictionary's order. */
const REPORTED = [
  'type', 'state', 'filed_at', 'description', 'priority', 'points', 'hours_estimate',
  'parent_id', 'assignee', 'reporter', 'reviewer', 'component', 'labels', 'sprint_id', 'due',
  'outcome', 'acceptance_criteria', 'severity', 'repro_steps', 'expected', 'actual',
  'found_in', 'fix_confirmed', 'question', 'timebox_hours', 'findings', 'proposed_resolution',
] as const

/** The longest a reported value prints before it is reported as its size instead. */
export const MAX_ECHO = 120

/**
 * One side of a reported change, as a line the grammar can carry. A prose field may hold
 * newlines and thousands of characters: `file` handed a multi-line `repro_steps` straight to
 * the line renderer, which refused it as a delimiter, so the caller got `err INTERNAL` and
 * exit 1 over a write that had already landed and would collide on the retry. Everything
 * that fits stays verbatim, because the point of the echo is that a caller can see what was
 * stored without a second command.
 */
export function echoed(value: string): string {
  return value.length <= MAX_ECHO && !/[\n\t]/.test(value) ? value : `${value.length} chars`
}

export async function fileItem(
  target: Target, clock: Clock, ids: IdGenerator, request: FileRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('file', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id

  const now = clock.now()
  const id = request.id ?? slugFor(request.title, request.type, new Set([...view.value.byId.keys(), ...view.value.sprintById.keys()]))
  // The same rule `sprint open` holds from its side: an id names one thing, and the log
  // that `history` reads is keyed by id alone.
  if (view.value.sprintById.has(id)) {
    return errorResult({
      code: 'VALIDATION', command: 'file', workspace, effect: 'mutate', rule: 'I5', entity: id,
      cause: `${id} is a sprint here, and an id names one thing: an item cannot share a sprint's id`,
      fix: [`treadle sprints ${id}`, `treadle file ${request.type} "<title>" --id <slug>`],
    })
  }
  const draft: Record<string, unknown> = {
    id, type: request.type, state: 'draft', title: request.title, filed_at: now, version: 1,
  }
  // Through `canonicalField`, so the spelling a read surface printed is a spelling a write
  // takes: `--set desc=` and `--set description=` are the same field.
  for (const [name, value] of Object.entries(request.fields)) {
    const field = canonicalField(name)
    draft[field] = coerce(field, value)
  }

  const item = draft as unknown as WorkItem
  const valid = validateWorkItem(item, { now })
  if (!valid.ok) {
    return errorResult({
      code: 'VALIDATION', command: 'file', workspace, effect: 'mutate',
      rule: valid.error.rule ?? 'V4', entity: id, cause: valid.error.message,
      fix: [`treadle help file`],
    })
  }

  if (item.parent_id !== undefined) {
    const refused = parentRefusal('file', workspace, view.value, item, item.parent_id)
    if (refused !== undefined) return refused
  }

  // `--sprint` at creation is a commit, and it is held to the commit's rules: the sprint
  // exists and is open, and the item is ready to be worked. Before sprints were records the
  // flag stored any string, which is the one narrowing this change makes to the surface.
  if (item.sprint_id !== undefined) {
    const sprint = view.value.sprintById.get(item.sprint_id)
    if (sprint === undefined) {
      return errorResult({
        code: 'NOT_FOUND', command: 'file', workspace, effect: 'mutate', rule: 'I5', entity: item.sprint_id,
        cause: `${item.sprint_id} is no sprint here; this workspace holds ${view.value.sprints.length} ${view.value.sprints.length === 1 ? 'sprint' : 'sprints'}`,
        near: nearIds(view.value.sprintById.keys(), item.sprint_id),
        fix: ['treadle sprints'],
      })
    }
    const outcome = evaluateCommit({ sprint, item: { ...item, sprint_id: undefined }, current: undefined, readyGate: readyVerdict(view.value, item) })
    if (outcome.outcome === 'refused') {
      // Nothing was filed, so the commit's own fixes, which name the item, would each exit
      // NOT_FOUND. The line offered files it without the sprint, with the fields its type
      // cannot be filed without, and the commit is the second line once it is ready.
      const required = requiredAtCreation(request.type).map((field) => ` --set ${field}=${placeholderOf(field)}`).join('')
      return errorResult({
        code: 'GUARD_REFUSED', command: 'file', workspace, effect: 'mutate',
        rule: outcome.error.rule ?? 'I4', entity: id,
        cause: `${outcome.error.message}; nothing was filed, so file it without --sprint and commit it once it is ready`,
        fix: [`treadle file ${request.type} "<title>"${required}`, `treadle sprint commit ${sprint.id} <id>`],
      })
    }
  }

  const txn = ids.txn()
  const eventId = ids.event()
  const changes = diffOf(undefined, item, REPORTED)
  const data: Record<string, Value> = {
    item: id,
    type: request.type,
    state: 'draft',
    title: request.title,
    set: changes.map((change) => `${change.field} ${echoed(change.before)} -> ${echoed(change.after)}`),
  }

  if (mode === 'preview') {
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
      // The file event used to carry `state` and `type` alone, so the severity and the
      // priority an item was created with were nowhere in the log and `history` could never
      // say who set them. It now carries every audited field the confirmation prints.
      id: eventId, at: now, actor: request.actor, entity: id, op: 'item.file',
      after: snapshotOf(diffOf(undefined, item, AUDITED_FIELDS), 'after'), txn, command: 'file',
    })],
  })
  if (!applied.ok) return storeRefusal('file', 'mutate', applied.error, workspace)

  if (mode === 'dry-run') {
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

/**
 * The criteria a story's `ac` tally is a tally of, built only when the caller asks for that
 * field by name. `show --field ac` returned `ac 0/1` and nothing else, so a checklist a team wrote
 * and committed was readable through no command in the tool.
 *
 * It is a projection rather than a line of the whole record because the whole record has a
 * budget: `show` is 310 B against A.3's figure with no headroom, and two criteria cost 52 B
 * on every read of every story. This is the shape `desc` already takes, which is cut at 64
 * cells in the record and printed whole under `show <id> --field desc`.
 */
function criteriaBlock(item: WorkItem): Block | undefined {
  const criteria = item.acceptance_criteria ?? []
  if (criteria.length === 0) return undefined
  return {
    columns: columnsOf(SHOW_SHAPE, 'criteria'),
    shown: criteria.length,
    total: criteria.length,
    rows: criteria.map((criterion, at): Row => ({
      n: at + 1, tick: criterion.ticked ? 'x' : '-', text: criterion.text,
    })),
  }
}

export async function showItem(
  store: Store, clock: Clock, id: ItemId, field?: string,
): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('show', 'read', view.error, undefined)
  const workspace = view.value.identity.id
  const whole = await wholeItem(store, view.value, id)
  if (!whole.ok) return storeRefusal('show', 'read', whole.error, workspace)
  const item = whole.value
  if (item === undefined) return notFound('show', workspace, view.value, id)

  const data: Record<string, Value> = {
    item: item.id,
    type: item.type,
    state: item.state,
    filed: item.filed_at,
    v: item.version,
  }
  if (item.points !== undefined) data['pts'] = item.points
  if (item.priority !== undefined) data['pri'] = item.priority
  if (item.sprint_id !== undefined) data['sprint'] = item.sprint_id
  if (item.parent_id !== undefined) data['parent'] = item.parent_id
  const ticked = tickedOf(item.acceptance_criteria)
  if (ticked !== undefined) data['ac'] = ticked
  if (item.due !== undefined) data['due'] = item.due
  const overdue = daysOverdue(item, clock.now())
  if (overdue > 0) data['overdue'] = overdue
  if (item.resolution !== undefined) data['resolution'] = item.resolution
  if (item.assignee !== undefined) data['assignee'] = item.assignee
  data['title'] = item.title
  if (item.description !== undefined) data['desc'] = item.description
  if (item.severity !== undefined) data['sev'] = item.severity

  // The rest of the field dictionary, in the shape's own appended order. Each was stored on
  // every write and printed by nothing, which is the defect class the sweep in
  // test/architecture/field-visibility.test.ts now holds the whole dictionary to.
  if (item.hours_estimate !== undefined) data['hrs'] = item.hours_estimate
  if (item.labels !== undefined && item.labels.length > 0) data['labels'] = item.labels.join(',')
  if (item.found_in !== undefined) data['found'] = item.found_in
  if (item.fix_confirmed !== undefined) data['fixed'] = item.fix_confirmed
  if (item.timebox_hours !== undefined) data['timebox'] = item.timebox_hours
  if (item.hold_until !== undefined) data['hold_until'] = item.hold_until
  if (item.held_from !== undefined) data['held_from'] = item.held_from
  // A count and not the values: `extra` holds keys a newer writer produced that this build
  // has no meaning for (DR3), and printing one as if it were a field of the record invites a
  // caller to act on a value nothing here can validate. The count says the record carries
  // them, which is the part a reader of this version can act on.
  if (item.extra !== undefined && item.extra.size > 0) data['extra'] = item.extra.size
  if (item.reporter !== undefined) data['reporter'] = item.reporter
  if (item.reviewer !== undefined) data['reviewer'] = item.reviewer
  if (item.component !== undefined) data['component'] = item.component
  if (item.hold_reason !== undefined) data['hold'] = item.hold_reason
  if (item.outcome !== undefined) data['outcome'] = item.outcome
  if (item.question !== undefined) data['question'] = item.question
  if (item.repro_steps !== undefined) data['repro'] = item.repro_steps
  if (item.expected !== undefined) data['expected'] = item.expected
  if (item.actual !== undefined) data['actual'] = item.actual
  if (item.findings !== undefined) data['findings'] = item.findings
  if (item.proposed_resolution !== undefined) data['proposed_resolution'] = item.proposed_resolution

  const evidence = item.evidence ?? []
  if (evidence.length > 0) {
    data['evidence'] = {
      columns: columnsOf(SHOW_SHAPE, 'evidence'),
      shown: evidence.length,
      total: evidence.length,
      rows: evidence.map((pointer): Row => ({
        kind: pointer.kind, ref: pointer.ref, label: pointer.label ?? null,
      })),
    }
  }

  const relations = relationsOf(view.value.relations, item.id)
  if (relations.length > 0) {
    data['relations'] = {
      columns: columnsOf(SHOW_SHAPE, 'relations'),
      shown: relations.length,
      total: relations.length,
      rows: relations.map((relation): Row => ({ kind: relation.kind, other: relation.other })),
    }
  }

  if (field === undefined) return okResult(SHOW_SHAPE, { workspace, data })
  // Either spelling reaches the same key, and the refusal offers both back: a caller who read
  // `desc` off a record and asked for `description` was told the record had no such field.
  const key = shortField(field)
  if (!(key in data)) {
    // A key a newer version wrote is on the record and is not a field this build has, and the
    // two are different answers. Saying the record carries no such field is false about the
    // file, which is the same defect this function already closed for `desc`; the value stays
    // unprinted for the reason `extra` is a count above.
    if (item.extra?.has(field) === true || item.extra?.has(key) === true) {
      return errorResult({
        code: 'VALIDATION', command: 'show', workspace, effect: 'read', rule: 'C2', entity: item.id,
        cause: `${item.id} carries ${field} and this build has no field of that name; a newer version wrote it, and it is preserved on the record and counted by extra`,
        fix: [`treadle show ${item.id}`],
      })
    }
    const known = SHOW_SHAPE.properties
      .map((property) => property.key)
      .filter((name) => name !== 'item' && name in data)
      .map((name) => (canonicalField(name) === name ? name : `${name}/${canonicalField(name)}`))
    return errorResult({
      code: 'VALIDATION', command: 'show', workspace, effect: 'read', rule: 'C2', entity: item.id,
      cause: `${item.id} carries no field named ${field}; this record has ${known.join(', ')}`,
      fix: [`treadle show ${item.id}`],
    })
  }
  const projection: Record<string, Value> = { item: item.id, [key]: data[key] as Value }
  const detail = key === 'ac' ? criteriaBlock(item) : undefined
  if (detail !== undefined) projection['criteria'] = detail
  return okResult(SHOW_SHAPE, { workspace, data: projection })
}

/** One filter clause, kept in the order it was written so a tie names the first (A.4). */
export type Filter = {
  readonly field: 'state' | 'type' | 'sprint' | 'assignee' | 'priority' | 'resolution'
  readonly value: string
}

function fieldOf(item: WorkItemSummary, field: Filter['field']): string | undefined {
  if (field === 'state') return item.state
  if (field === 'type') return item.type
  if (field === 'sprint') return item.sprint_id
  if (field === 'assignee') return item.assignee
  if (field === 'resolution') return item.resolution
  return item.priority === undefined ? undefined : String(item.priority)
}

export function matches(item: WorkItemSummary, filters: readonly Filter[]): boolean {
  return filters.every((filter) => fieldOf(item, filter.field) === filter.value)
}

const NO_PRIORITY = 6

export function backlogOrder(a: WorkItemSummary, b: WorkItemSummary): number {
  const priority = (a.priority ?? NO_PRIORITY) - (b.priority ?? NO_PRIORITY)
  if (priority !== 0) return priority
  if (a.filed_at !== b.filed_at) return a.filed_at < b.filed_at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function rowFor(item: WorkItemSummary, columns: readonly string[]): Row {
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
    else if (column === 'sev') row[column] = item.severity ?? null
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

/**
 * The two refusals a chosen column set can earn, shared by every list that takes `--fields`.
 * C2 is a name the list does not have. C3 is F3: the row grammar splits on the first
 * arity-1 spaces, so exactly one column may carry a value with a space in it; two of them is
 * a set no ordering can rescue, and a row that parses into the wrong fields with no error
 * is worse than a refusal.
 */
export function columnRefusal(
  command: string, workspace: string, columns: readonly string[], known: readonly ColumnSpec[],
): ResultObject | undefined {
  const unknown = columns.find((name) => !known.some((column) => column.name === name))
  if (unknown !== undefined) {
    return errorResult({
      code: 'VALIDATION', command, workspace, effect: 'read', rule: 'C2',
      cause: `${unknown} is not a column of this list; the columns are ${known.map((c) => c.name).join(', ')}`,
      fix: [`treadle help ${command}`],
    })
  }
  const free = columns.filter((name) => known.some((column) => column.name === name && column.text === true))
  if (free.length > 1) {
    return errorResult({
      code: 'VALIDATION', command, workspace, effect: 'read', rule: 'C3',
      cause: `${free.join(' and ')} both carry free text, and a row can carry one such column; every field after the first would be read wrong`,
      fix: [`treadle ${command} --fields ${columns.filter((name) => name !== free[0]).join(',')}`],
    })
  }
  return undefined
}

export async function backlog(store: Store, request: BacklogRequest): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('backlog', 'read', view.error, undefined)
  const workspace = view.value.identity.id

  const refused = columnRefusal('backlog', workspace, request.columns, ITEM_COLUMNS)
  if (refused !== undefined) return refused

  const line = (cursor?: string): string =>
    invocation('backlog', [], [...listFlags(request.filters, request.columns, DEFAULT_BACKLOG_COLUMNS, request.limit), ['cursor', cursor]])
  const matched = view.value.items.filter((item) => matches(item, request.filters)).sort(backlogOrder)
  const from = request.cursor === undefined ? 0 : matched.findIndex((item) => item.id === request.cursor)
  if (from < 0) return unknownCursor('backlog', workspace, request.cursor as string, request.cursor as string, line())
  const page = matched.slice(from, from + request.limit)
  const block: Block = {
    columns: columnsFor(request.columns),
    shown: page.length,
    total: matched.length,
    rows: page.map((item) => rowFor(item, request.columns)),
  }

  const data: Record<string, Value> = {}
  if (request.filters.length > 0) {
    data['filter'] = request.filters.map((filter) => `${filter.field} ${filter.value}`).join(' ')
  }
  // A sort and an aggregate over nothing are noise; the `none` line is the answer there.
  if (page.length > 0) data['sort'] = 'priority,filed,id'
  if (page.length > 0) {
    data['points'] = page.reduce((sum, item) => sum + (item.points ?? 0), 0)
    // `done` was this key's name, and beside a list where one of two items is in state
    // `done` a `done 0` line reads as a count of items rather than of their estimates.
    // Both aggregates now say what they aggregate over.
    data['done_points'] = page
      .filter((item) => item.state === 'done')
      .reduce((sum, item) => sum + (item.points ?? 0), 0)
  }

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
    if (next !== undefined) data['page'] = line(next.id)
  }
  data['items'] = block
  return okResult(BACKLOG_SHAPE, { workspace, data })
}

/** The clause whose own selectivity was lowest, so a caller learns which term to relax. */
export function narrowestClause(items: readonly WorkItemSummary[], filters: readonly Filter[]): string | undefined {
  let best: { readonly filter: Filter; readonly hits: number } | undefined
  for (const filter of filters) {
    const hits = items.filter((item) => fieldOf(item, filter.field) === filter.value).length
    if (best === undefined || hits < best.hits) best = { filter, hits }
  }
  return best === undefined ? undefined : `${best.filter.field} ${best.filter.value} ${best.hits}`
}

/** The first clause that excluded the id, or the store that was searched when it is nowhere. */
export function absence(
  view: WorkspaceView, filters: readonly Filter[], id: ItemId,
): Readonly<Record<string, Value>> {
  const item = view.byId.get(id)
  if (item === undefined) {
    return { absent: id, clause: `unknown searched ${view.items.length}`, store: view.identity.path ?? view.identity.id }
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
    .filter((candidate) => candidate.distance <= Math.max(2, Math.ceil(wanted.length * 0.4)))
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

/**
 * The one refusal for an id no command could resolve. It can say "in no record here" without
 * checking, because `readWorkspace` has already refused any view over a store that holds a
 * record it does not serve: an ambiguous or quarantined id never reaches a lookup, so a miss
 * here is a genuine absence and not the silent first-match wearing a different hat.
 */
export function notFound(
  command: string, workspace: string, view: WorkspaceView, id: ItemId,
): ResultObject {
  const held = view.items.length
  return errorResult({
    code: 'NOT_FOUND', command, workspace, effect: 'read', entity: id,
    cause: `${id} is in no record here; this workspace holds ${held} ${held === 1 ? 'item' : 'items'}`,
    near: nearIds(view.byId.keys(), id),
    fix: ['treadle backlog'],
  })
}

/**
 * The hierarchy's three rules, applied where a parent edge is written, or `undefined` when
 * the edge is legal. `setParent` refused a disallowed pair, a cycle and an unknown parent
 * from the start and no command called it, so `set` wrote `draft-task -> draft-task` and
 * `doctor` then blamed a hand edit for it, while `file --parent nope` was reported nowhere.
 * The child is added to the graph's type index when it is not yet filed, which is `file`.
 *
 * A fix line lists the types that may parent this one rather than `parent_id=<id>`: the
 * reader's own workspace is what filled `<id>` with the guess that was just refused.
 */
export function parentRefusal(
  command: string, workspace: string, view: WorkspaceView,
  child: { readonly id: ItemId; readonly type: WorkItemType }, parentId: ItemId,
): ResultObject | undefined {
  const graph = view.hierarchy.typeOf.has(child.id)
    ? view.hierarchy
    : { ...view.hierarchy, typeOf: new Map(view.hierarchy.typeOf).set(child.id, child.type) }
  const edge = setParent(graph, child.id, parentId)
  if (edge.ok) return undefined
  const parents = ALLOWED_PARENT_PAIRS.filter((pair) => pair.child === child.type)
    .map((pair) => `treadle backlog --type ${pair.parent}`)
  const unknown = edge.error.rule === 'P4'
  // A chain that already closes a cycle above the parent is the store's finding, not this write's.
  const fix = edge.error.code === 'INTEGRITY' ? ['treadle doctor'] : parents.length > 0 ? parents : [`treadle show ${child.id}`]
  return errorResult({
    code: unknown ? 'NOT_FOUND' : edge.error.code, command, workspace, effect: 'mutate',
    rule: edge.error.rule ?? 'P1', entity: child.id, cause: edge.error.message,
    ...(unknown ? { near: nearIds(view.byId.keys(), parentId) } : {}),
    fix,
  })
}
