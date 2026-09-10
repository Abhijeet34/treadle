// SPDX-License-Identifier: Apache-2.0
// The two configuration use cases: read every key with the value in force and where it came
// from, and write one key with the refusal arriving before the file is wrong.
//
// The command is thin and the storage under it is not, which is the honest shape: six
// consumers read `WorkspaceConfig` off the view and this file is where a team puts a value
// there. What `config set` adds over editing `workspace.md` by hand is stated rather than
// left to be inferred - the refusal arrives before the write instead of as a `doctor`
// finding after it, the log records who changed a gate and when, which a hand edit never
// does, and the read prints the value in force where the file prints only what was written.
//
// `effect` is `mutate` for both forms, because one word covers a read and a write and the
// envelope has to be able to carry a transaction id (R4). The bare read answers `changed 0`
// with `txn` null, which is the envelope every mutation gives when nothing moved. Declaring
// the read effect instead would have been the dangerous direction to be wrong in.

import {
  CONFIG_KEYS,
  configLine,
  isConfigKey,
  parseConfigValue,
  withConfigKey,
  type ConfigKey,
} from '../../domain/index.ts'
import { columnsOf, errorResult, okResult, type Block, type ResultObject, type ResultShape, type Row, type Value } from '../result.ts'
import type { Clock } from '../ports/clock.ts'
import type { IdGenerator } from '../ports/ids.ts'
import { readWorkspace } from './context.ts'
import { echoed } from './items.ts'
import { makeEvent, type Actor, type Target } from './mutation.ts'
import { storeRefusal } from './refusal.ts'

export const CONFIG_SHAPE: ResultShape = {
  command: 'config',
  // v2 dropped the `preview` scalar with the `--preview` flag.
  version: 2,
  effect: 'mutate',
  summary: 'Read every configuration key with the value in force and its source, or set one.',
  properties: [
    { kind: 'scalar', key: 'key', type: 'string' },
    { kind: 'scalar', key: 'v', type: 'string' },
    // Every entry ends in a value the caller wrote, so the line carries the untrusted-content
    // marker rather than reading as the tool's own speech (F12).
    { kind: 'list', key: 'set', data: true },
    { kind: 'scalar', key: 'already', type: 'string' },
    { kind: 'scalar', key: 'dry_run', type: 'integer' },
    { kind: 'scalar', key: 'would_exit', type: 'integer' },
    { kind: 'scalar', key: 'store', type: 'string' },
    { kind: 'scalar', key: 'event', type: 'string' },
    { kind: 'scalar', key: 'note', type: 'string' },
    // The count of field keys on the workspace record this build has no meaning for, printed
    // for the reason `show` prints an item's: a key nobody here can read is either a newer
    // writer's or a typo, and a reading that showed neither made the two the same file.
    { kind: 'scalar', key: 'extra', type: 'integer' },
    {
      kind: 'block',
      key: 'config',
      // `source` is the tool's own closed set of two words; `value` is what a team wrote,
      // carries spaces on four of the nine keys, and is therefore the row's one text column.
      columns: [{ name: 'key' }, { name: 'source' }, { name: 'value', text: true }],
    },
  ],
}

function refusal(
  workspace: string, code: 'VALIDATION', rule: string, entity: string, cause: string, fix: readonly string[],
): ResultObject {
  return errorResult({ code, command: 'config', workspace, effect: 'mutate', rule, entity, cause, fix })
}

/**
 * Every key, the value in force and where it came from. The interface specifies four links
 * of precedence - a flag, an environment variable, the file, the default - and two of them
 * exist, because no key has a flag or a variable; adding either is additive and the column
 * already has room for the word.
 */
export async function readConfig(store: Target['store']): Promise<ResultObject> {
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('config', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const config = view.value.config

  const rows: Row[] = CONFIG_KEYS.map((key): Row => ({
    key,
    source: config.from.has(key) ? 'file' : 'default',
    value: configLine(key, config),
  }))
  const block: Block = {
    columns: columnsOf(CONFIG_SHAPE, 'config'),
    shown: rows.length,
    total: rows.length,
    rows,
  }
  return okResult(CONFIG_SHAPE, {
    workspace, txn: null, changed: 0,
    // In the shape's declared order, which is what the JSON rendering emits and what the
    // conformance suite holds every result object to.
    data: {
      v: String(view.value.identity.version),
      store: view.value.identity.path ?? workspace,
      ...(view.value.identity.extra === 0 ? {} : { extra: view.value.identity.extra }),
      config: block,
    },
  })
}

export type ConfigSetRequest = {
  readonly key: string
  readonly value: string
  readonly actor: Actor
}

export async function setConfig(
  target: Target, clock: Clock, ids: IdGenerator, request: ConfigSetRequest,
): Promise<ResultObject> {
  const { store, mode } = target
  const view = await readWorkspace(store)
  if (!view.ok) return storeRefusal('config', 'mutate', view.error, undefined)
  const workspace = view.value.identity.id
  const before = view.value.config

  // The key set is closed at the one place a caller types a key. A key the file carries and
  // this build does not know is a different question and is carried forward untouched, which
  // is the forward-compatibility rule every record in this store keeps (DR3).
  if (!isConfigKey(request.key)) {
    return refusal(workspace, 'VALIDATION', 'C1', request.key,
      `${request.key} is not a configuration key; they are ${CONFIG_KEYS.join(', ')}`,
      ['treadling config'])
  }
  const key: ConfigKey = request.key

  // The refusal arrives before the file is wrong. It is the same check the load path runs,
  // so a value this refuses is exactly a value a hand edit would have made a `doctor`
  // finding of, and the rule id is the same on both sides.
  const parsed = parseConfigValue(key, request.value)
  if (!parsed.ok) {
    return refusal(workspace, 'VALIDATION', parsed.error.rule ?? 'V8', key, parsed.error.message,
      [`treadling config`, `treadling help config`])
  }

  const after = withConfigKey(before, key, parsed.value)
  const was = configLine(key, before)
  const now = configLine(key, after)
  if (was === now && before.from.has(key)) {
    return okResult(CONFIG_SHAPE, { workspace, txn: null, changed: 0, data: { already: key, v: String(view.value.identity.version) } })
  }

  const version = view.value.identity.version
  const data: Record<string, Value> = {
    key,
    v: `${version} -> ${version + 1}`,
    set: [`${key} ${echoed(was)} -> ${echoed(now)}`],
  }
  const txn = ids.txn()
  const eventId = ids.event()
  // Both sides verbatim, which is what makes the change reversible from the log and what
  // `doctor` would compare a hand edit against. A gate's value is its rules, so the log
  // carries the rules rather than a count of them; `history` is where that is projected.
  const applied = await store.apply({
    txn,
    writes: [],
    workspace: { config: after, ifVersion: version },
    events: [makeEvent({
      id: eventId, at: clock.now(), actor: request.actor, entity: workspace, entityKind: 'workspace',
      op: 'workspace.config', before: { [key]: was }, after: { [key]: now }, txn, command: 'config',
    })],
  })
  if (!applied.ok) return storeRefusal('config', 'mutate', applied.error, workspace)
  if (mode === 'dry-run') {
    return okResult(CONFIG_SHAPE, { workspace, txn: null, changed: 0, data: { ...data, dry_run: 1, would_exit: 0 } })
  }
  return okResult(CONFIG_SHAPE, { workspace, txn, changed: 1, data: { ...data, event: eventId } })
}
