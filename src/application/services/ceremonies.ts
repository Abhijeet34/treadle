// SPDX-License-Identifier: Apache-2.0
// The read over the third record kind: every retrospective, or one whole.
//
// It is the only surface T4a ships over ceremony records, and it is a read: `ceremonies`
// lists and prints, and the verb that files one is `ceremony retro`, which is the
// `sprint`/`sprints` split the command inventory already uses (interface DB-1).
//
// What a retrospective holds that nothing else does is the two prose halves and the action
// list, so both come back here: the list is where a reader learns which retro produced which
// chore, and the prose is the judgement no transition reconstructs.

import { columnsOf, errorResult, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Ceremony } from '../../domain/index.ts'
import type { Store } from '../ports/store.ts'
import { readWorkspace, type WorkspaceView } from './context.ts'
import { nearIds } from './items.ts'
import { storeRefusal } from './refusal.ts'

export const CEREMONIES_SHAPE: ResultShape = {
  command: 'ceremonies',
  version: 1,
  effect: 'read',
  summary: 'List the retrospectives, or print one with its prose and the chores it produced.',
  properties: [
    { kind: 'scalar', key: 'ceremony', type: 'string' },
    { kind: 'scalar', key: 'state', type: 'string' },
    { kind: 'scalar', key: 'filed', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'integer' },
    { kind: 'scalar', key: 'sprint', type: 'string' },
    { kind: 'scalar', key: 'actions', type: 'string' },
    { kind: 'scalar', key: 'extra', type: 'integer' },
    { kind: 'scalar', key: 'none', type: 'string' },
    // F12: the three below end in text the caller wrote, so they carry the
    // untrusted-content marker rather than reading as the tool's own speech.
    { kind: 'text', key: 'title', whole: true },
    { kind: 'text', key: 'well', whole: true },
    { kind: 'text', key: 'badly', whole: true },
    {
      kind: 'block',
      key: 'ceremonies',
      columns: [{ name: 'id' }, { name: 'filed' }, { name: 'sprint' }, { name: 'actions' }, { name: 'title', text: true }],
    },
  ],
}

function rowOf(ceremony: Ceremony): Row {
  return {
    id: ceremony.id,
    filed: ceremony.filed_at,
    sprint: ceremony.sprint_id ?? '-',
    actions: String((ceremony.actions ?? []).length),
    title: ceremony.title,
  }
}

/**
 * `notFound`'s mirror for a ceremony id nothing here carries, answering from either side as
 * `noSprint` does: an id that names an item or a sprint is told which read serves it, rather
 * than being reported as an absence the caller then has to go looking for.
 */
function noCeremony(view: WorkspaceView, workspace: string, id: string): ResultObject {
  for (const [kind, has, fix] of [
    ['an item', view.byId.has(id), [`treadle show ${id}`, 'treadle ceremonies']],
    ['a sprint', view.sprintById.has(id), [`treadle sprints ${id}`, 'treadle ceremonies']],
  ] as const) {
    if (!has) continue
    return errorResult({
      code: 'NOT_FOUND', command: 'ceremonies', workspace, effect: 'read', rule: 'I5', entity: id,
      cause: `${id} is ${kind} here, not a ceremony, and ceremonies takes a ceremony id`,
      fix,
    })
  }
  const held = view.ceremonies.length
  return errorResult({
    code: 'NOT_FOUND', command: 'ceremonies', workspace, effect: 'read', rule: 'I5', entity: id,
    cause: `${id} is no ceremony here; this workspace holds ${held} ${held === 1 ? 'ceremony' : 'ceremonies'}`,
    near: nearIds([...view.ceremonyById.keys(), ...view.byId.keys(), ...view.sprintById.keys()], id),
    fix: ['treadle ceremonies'],
  })
}

/** Every retrospective, oldest first, or the one named: its fields, its prose and its actions. */
export async function ceremonies(store: Store, id?: string): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('ceremonies', 'read', view.error, undefined)
  const workspace = view.value.identity.id

  if (id === undefined) {
    const rows = view.value.ceremonies.map(rowOf)
    const data: Record<string, Value> = {}
    if (rows.length === 0) data['none'] = 'no ceremony has been recorded here'
    data['ceremonies'] = { columns: columnsOf(CEREMONIES_SHAPE, 'ceremonies'), shown: rows.length, total: rows.length, rows } satisfies Block
    return okResult(CEREMONIES_SHAPE, { workspace, data })
  }

  const ceremony = view.value.ceremonyById.get(id)
  if (ceremony === undefined) return noCeremony(view.value, workspace, id)
  const data: Record<string, Value> = {
    ceremony: ceremony.id, state: ceremony.state, filed: ceremony.filed_at, v: ceremony.version,
  }
  if (ceremony.sprint_id !== undefined) data['sprint'] = ceremony.sprint_id
  if (ceremony.actions !== undefined) data['actions'] = ceremony.actions.join(',')
  if (ceremony.extra !== undefined && ceremony.extra.size > 0) data['extra'] = ceremony.extra.size
  data['title'] = ceremony.title
  if (ceremony.well !== undefined) data['well'] = ceremony.well
  if (ceremony.badly !== undefined) data['badly'] = ceremony.badly
  return okResult(CEREMONIES_SHAPE, { workspace, data })
}
