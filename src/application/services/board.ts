// SPDX-License-Identifier: Apache-2.0
// The board: `backlog` grouped by state, scoped to a sprint by default, with the work that
// cannot move at the top of every column. It stores nothing and derives everything from the
// one read every command performs, so there is no board to be on and no column to be over.
//
// A backlog answers "what is there"; a board answers "where is the work stuck". The second
// question is why one column per live state is a block of its own, why an empty column is
// still printed, and why a blocked row sorts above an unblocked one whatever its priority:
// a column is capped, and the row a reader came for must be inside the cap. ADR-0018 argues
// each of those against the alternatives.

import { dayOfSprint, type ItemId, type WorkItemState, type WorkItemSummary } from '../../domain/index.ts'
import { errorResult, okResult, type Block, type ColumnSpec, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { Store } from '../ports/store.ts'
import { activeBlockerIndex, readWorkspace, type WorkspaceView } from './context.ts'
import { ITEM_COLUMNS, absence, backlogOrder, columnRefusal, matches, narrowestClause, rowFor, type Filter } from './items.ts'
import { storeRefusal } from './refusal.ts'

/**
 * The columns, in flow order. `done` and `cancelled` are counts rather than columns: finished
 * work is not stuck anywhere, and unscoped it is the whole history of the workspace.
 */
export const BOARD_STATES: readonly WorkItemState[] = ['draft', 'ready', 'in_progress', 'in_review', 'on_hold']

/** Every column `backlog` has, and `blocked`: the active blockers of the row, which needs the graph. */
export const BOARD_COLUMNS: readonly ColumnSpec[] = [...ITEM_COLUMNS, { name: 'blocked' }]

/** State is the grouping key, so it is not a default column; `blocked` is the board's reason to exist. */
export const DEFAULT_BOARD_COLUMNS = ['id', 'type', 'pts', 'sev', 'blocked', 'title'] as const

export const BOARD_SHAPE: ResultShape = {
  command: 'board',
  version: 1,
  effect: 'read',
  summary: 'Group the live work by state, scoped to the open sprint, with blocked work first in every column.',
  properties: [
    { kind: 'scalar', key: 'scope', type: 'string' },
    { kind: 'scalar', key: 'whole', type: 'string' },
    { kind: 'scalar', key: 'filter', type: 'string' },
    { kind: 'scalar', key: 'sort', type: 'string' },
    { kind: 'scalar', key: 'blocked', type: 'integer' },
    { kind: 'scalar', key: 'done', type: 'integer' },
    { kind: 'scalar', key: 'cancelled', type: 'integer' },
    { kind: 'scalar', key: 'none', type: 'string' },
    { kind: 'scalar', key: 'narrowest', type: 'string' },
    { kind: 'scalar', key: 'absent', type: 'string' },
    { kind: 'scalar', key: 'clause', type: 'string' },
    { kind: 'scalar', key: 'store', type: 'string' },
    ...BOARD_STATES.map((state) => ({ kind: 'block', key: state, columns: BOARD_COLUMNS } as const)),
  ],
}

export type BoardRequest = {
  readonly filters: readonly Filter[]
  readonly columns: readonly string[]
  /** Rows per column; the block header carries the column's total. */
  readonly limit: number
  /** The whole workspace, even while a sprint is open. */
  readonly all: boolean
  readonly explainAbsence?: ItemId
}

type Scope =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'sprint'; readonly id: string; readonly defaulted: boolean }

/**
 * `--sprint` names the scope, `--all` is the whole workspace, and with neither the board is
 * the one open sprint: a board over the workspace while a sprint runs mixes the team's
 * history into its current work. Two open sprints is a question the tool cannot answer for
 * the caller, so it names both and refuses.
 */
function scopeOf(view: WorkspaceView, request: BoardRequest, workspace: string): Scope | ResultObject {
  const named = request.filters.find((filter) => filter.field === 'sprint')
  if (request.all && named !== undefined) {
    return errorResult({
      code: 'VALIDATION', command: 'board', workspace, effect: 'read', rule: 'C1',
      cause: '--all and --sprint ask different questions: all is the whole workspace, sprint is one sprint of it',
      fix: ['treadle board --all', `treadle board --sprint ${named.value}`],
    })
  }
  if (named !== undefined) return { kind: 'sprint', id: named.value, defaulted: false }
  if (request.all) return { kind: 'workspace' }
  const open = view.sprints.filter((sprint) => sprint.state === 'open')
  if (open.length === 0) return { kind: 'workspace' }
  const only = open[0]
  if (open.length === 1 && only !== undefined) return { kind: 'sprint', id: only.id, defaulted: true }
  return errorResult({
    code: 'VALIDATION', command: 'board', workspace, effect: 'read', rule: 'C1',
    cause: `${open.length} sprints are open, ${open.map((sprint) => sprint.id).join(' and ')}; a board is over one sprint or over the whole workspace`,
    fix: [...open.map((sprint) => `treadle board --sprint ${sprint.id}`), 'treadle board --all'],
  })
}

/** The sprint's own state and day beside its id, when a record carries them. */
function scopeLine(view: WorkspaceView, id: string, now: string): string {
  const sprint = view.sprintById.get(id)
  if (sprint === undefined) return id
  const at = dayOfSprint(sprint, now)
  return `${id} ${sprint.state} day ${at.day}/${at.days}`
}

export async function board(store: Store, clock: Clock, request: BoardRequest): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('board', 'read', view.error, undefined)
  const workspace = view.value.identity.id

  const refused = columnRefusal('board', workspace, request.columns, BOARD_COLUMNS)
  if (refused !== undefined) return refused

  const scope = scopeOf(view.value, request, workspace)
  if ('schema' in scope) return scope
  // The scope clause goes last so a tie among the caller's own clauses still names the
  // first one written (A.4), and an absence names the scope only when nothing else excludes.
  const filters: readonly Filter[] = scope.kind === 'sprint' && scope.defaulted
    ? [...request.filters, { field: 'sprint', value: scope.id }]
    : request.filters

  const blockers = activeBlockerIndex(view.value)
  const matched = view.value.items.filter((item) => matches(item, filters))
  const blockedFirst = (a: WorkItemSummary, b: WorkItemSummary): number => {
    const stuck = Number(blockers.has(b.id)) - Number(blockers.has(a.id))
    return stuck !== 0 ? stuck : backlogOrder(a, b)
  }
  const columns: readonly ColumnSpec[] = request.columns.map((name) =>
    BOARD_COLUMNS.find((column) => column.name === name) ?? { name })
  const rowOf = (item: WorkItemSummary): Row => ({
    ...rowFor(item, request.columns),
    ...(request.columns.includes('blocked') ? { blocked: blockers.get(item.id)?.join(',') ?? null } : {}),
  })

  const data: Record<string, Value> = {
    scope: scope.kind === 'workspace' ? 'workspace' : scopeLine(view.value, scope.id, clock.now()),
  }
  if (scope.kind === 'sprint' && scope.defaulted) data['whole'] = 'treadle board --all'
  if (request.filters.length > 0) {
    data['filter'] = request.filters.map((filter) => `${filter.field} ${filter.value}`).join(' ')
  }

  const live = matched.filter((item) => (BOARD_STATES as readonly string[]).includes(item.state))
  if (live.length > 0) data['sort'] = 'blocked,priority,filed,id'
  if (matched.length > 0) {
    data['blocked'] = live.filter((item) => blockers.has(item.id)).length
    data['done'] = matched.filter((item) => item.state === 'done').length
    data['cancelled'] = matched.filter((item) => item.state === 'cancelled').length
  } else {
    data['none'] = `searched ${view.value.items.length} matched 0`
    const narrowest = narrowestClause(view.value.items, filters)
    if (narrowest !== undefined) data['narrowest'] = narrowest
  }
  if (request.explainAbsence !== undefined) {
    Object.assign(data, absence(view.value, filters, request.explainAbsence))
  }

  for (const state of BOARD_STATES) {
    const column = live.filter((item) => item.state === state).sort(blockedFirst)
    const page = column.slice(0, request.limit)
    const block: Block = { columns, shown: page.length, total: column.length, rows: page.map(rowOf) }
    data[state] = block
  }
  return okResult(BOARD_SHAPE, { workspace, data })
}
