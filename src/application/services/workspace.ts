// SPDX-License-Identifier: Apache-2.0
// `init`'s result, and the shape it is generated from. The directory creation itself is an
// adapter (src/adapters/init.ts) because it is filesystem work; what a workspace reports
// having created, and what it reports NOT having created, is contract and lives here.
//
// The `not_created` line is not decoration. A tool an agent runs under someone else's
// account has to make its blast radius checkable, and a negative that is never printed
// cannot be checked (A.8, B.9).

import { columnsOf, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'

export const INIT_SHAPE: ResultShape = {
  command: 'init',
  version: 1,
  effect: 'mutate',
  summary: 'Create a workspace here, and say what it created and what it did not.',
  properties: [
    { kind: 'scalar', key: 'already', type: 'string' },
    { kind: 'scalar', key: 'created', type: 'string' },
    { kind: 'scalar', key: 'actor', type: 'string' },
    { kind: 'scalar', key: 'schema', type: 'integer' },
    { kind: 'scalar', key: 'not_created', type: 'string' },
    { kind: 'list', key: 'next' },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'preview', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
    { kind: 'block', key: 'files', columns: [{ name: 'name' }, { name: 'note', text: true }] },
  ],
}

export const CREATED_FILES: readonly (readonly [string, string])[] = [
  ['workspace.md', 'the workspace record: its id, its name and the instant it was created'],
  ['items/', 'one record file per month; this is what you commit and review'],
  ['events/', 'the append-only event log, one file per month'],
  ['.gitignore', 'ignores .index/ and .lock, which are derived and safe to delete'],
  ['.gitattributes', 'merges the event log by union, and marks it generated so a review reads the records'],
]

export const NEXT_STEPS: readonly string[] = [
  'treadle file story "The first thing you want to fix"',
  'treadle status',
]

export type InitInput = {
  readonly workspace: string
  readonly path: string
  readonly actor: string
  readonly schema: number
  readonly txn: string | null
  readonly already?: true
}

export function initResult(input: InitInput): ResultObject {
  if (input.already === true) {
    return okResult(INIT_SHAPE, {
      workspace: input.workspace, txn: null, changed: 0,
      data: { already: input.workspace, created: input.path, schema: input.schema },
    })
  }
  const files: Block = {
    columns: columnsOf(INIT_SHAPE, 'files'),
    shown: CREATED_FILES.length,
    total: CREATED_FILES.length,
    rows: CREATED_FILES.map(([name, note]): Row => ({ name, note })),
  }
  const data: Record<string, Value> = {
    created: input.path,
    actor: input.actor,
    schema: input.schema,
    not_created: 'nothing outside this directory: no shell profile, no editor config, no agent config',
    next: NEXT_STEPS,
    files,
  }
  return okResult(INIT_SHAPE, { workspace: input.workspace, txn: input.txn, changed: 1, data })
}
