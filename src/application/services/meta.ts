// SPDX-License-Identifier: Apache-2.0
// Shapes for the two commands whose subject is the tool rather than the work: `help`, which
// projects the command inventory, and `version`. They live beside the other shapes so the
// schema generator and the renderer registry have one list to read.

import type { ResultShape } from '../result.ts'

export const HELP_SHAPE: ResultShape = {
  command: 'help',
  version: 1,
  effect: 'read',
  summary: 'Print the command inventory, or one command\'s contract, flags and examples.',
  properties: [
    { kind: 'scalar', key: 'topic', type: 'string' },
    { kind: 'scalar', key: 'effect', type: 'string' },
    { kind: 'list', key: 'usage' },
    { kind: 'text', key: 'about', whole: true },
    { kind: 'list', key: 'example' },
    {
      kind: 'block',
      key: 'commands',
      columns: [{ name: 'name' }, { name: 'effect' }, { name: 'pageable' }, { name: 'summary', text: true }],
    },
    {
      kind: 'block',
      key: 'flags',
      columns: [{ name: 'flag' }, { name: 'verdict' }, { name: 'note', text: true }],
    },
  ],
}

export const VERSION_SHAPE: ResultShape = {
  command: 'version',
  version: 1,
  effect: 'read',
  summary: 'Print the tool version, the store schema version and the agent contract version.',
  properties: [
    { kind: 'scalar', key: 'name', type: 'string' },
    { kind: 'scalar', key: 'version', type: 'string' },
    { kind: 'scalar', key: 'store_schema', type: 'integer' },
    { kind: 'scalar', key: 'contract', type: 'string' },
    { kind: 'scalar', key: 'node', type: 'string' },
  ],
}
