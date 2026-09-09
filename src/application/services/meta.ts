// SPDX-License-Identifier: Apache-2.0
// Shapes for the two commands whose subject is the tool rather than the work: `help`, which
// projects the command inventory, and `version`. They live beside the other shapes so the
// schema generator and the renderer registry have one list to read.

import type { ResultShape } from '../result.ts'

export const HELP_SHAPE: ResultShape = {
  command: 'help',
  version: 2,
  effect: 'read',
  summary: 'Print the command inventory, or one command\'s contract, flags and examples.',
  properties: [
    { kind: 'scalar', key: 'topic', type: 'string' },
    { kind: 'scalar', key: 'effect', type: 'string' },
    { kind: 'list', key: 'usage' },
    { kind: 'text', key: 'about', whole: true },
    /** What a caller cannot get from a usage line or a flag letter: the rule a page is read
     *  under, the closed sets its own operands come from, and what a recorded actor proves. */
    { kind: 'list', key: 'note' },
    { kind: 'list', key: 'example' },
    /** `<status> <meaning>`, on the one command whose answer is a verdict rather than a record. */
    { kind: 'list', key: 'exit' },
    {
      kind: 'block',
      key: 'commands',
      columns: [{ name: 'name' }, { name: 'effect' }, { name: 'pageable' }, { name: 'summary', text: true }],
    },
    /** The global flag table, whole, on the one page that is read once. Its `note` carries
     *  what the flag does and the predicate that decides its column, so the exceptions a
     *  command page prints and these rows together name every cell of the matrix. */
    {
      kind: 'block',
      key: 'globals',
      columns: [{ name: 'flag' }, { name: 'where' }, { name: 'note', text: true }],
    },
    /** The field dictionary, on the pages whose caller types a field name or a type. */
    {
      kind: 'block',
      key: 'types',
      columns: [{ name: 'type' }, { name: 'required' }, { name: 'fields' }],
    },
    /** The lifecycle, on the page whose caller names a target state. */
    {
      kind: 'block',
      key: 'moves',
      columns: [{ name: 'from' }, { name: 'to' }, { name: 'move' }, { name: 'guards' }, { name: 'reason' }],
    },
    /** A command page's exceptions: the flags it does not treat as `globals` says it does. */
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
