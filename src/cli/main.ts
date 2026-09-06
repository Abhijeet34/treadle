// SPDX-License-Identifier: Apache-2.0
// One command, one result object, one rendering, one exit status.
//
// Every path through this file ends the same way: a result object goes to `emit`, which
// picks the rendering, writes a success to stdout and a refusal to stderr, and returns the
// exit status the result's own `code` field decides. There is no path that prints and then
// decides separately what to return, which is the class R3 exists to close.

import path from 'node:path'

import type { AttemptOutcome, Resolution, WorkItemState, WorkItemType } from '../domain/index.ts'
import { WORK_ITEM_STATES, WORK_ITEM_TYPES, type GuardId } from '../domain/index.ts'
import { errorResult, okResult, type ResultObject } from '../application/result.ts'
import { VERSION_SHAPE } from '../application/services/meta.ts'
import { doctor } from '../application/services/doctor.ts'
import { setFields } from '../application/services/editing.ts'
import { DEFAULT_BACKLOG_COLUMNS, backlog, fileItem, showItem, type Filter } from '../application/services/items.ts'
import { DEFAULT_BOARD_COLUMNS, board } from '../application/services/board.ts'
import { addEvidence, markItem } from '../application/services/marking.ts'
import { history } from '../application/services/history.ts'
import { explain, next, status } from '../application/services/insight.ts'
import { RELATION_VERBS, relate, type RelationVerb } from '../application/services/relation.ts'
import { transition } from '../application/services/lifecycle.ts'
import { closeSprint, commitItems, openSprint, reopenSprint, sprints, uncommitItems } from '../application/services/sprints.ts'
import { actorRefusal, type Actor, type Mode, type Target } from '../application/services/mutation.ts'
import type { Store } from '../application/ports/store.ts'
import { systemClock } from '../adapters/clock.ts'
import { randomIds } from '../adapters/ids.ts'
import { LoggingStore } from '../adapters/logging-store.ts'
import { SCHEMA, openWorkspace } from '../adapters/store/index.ts'
import { agentRenderer } from '../adapters/render/agent.ts'
import { contractLines } from '../adapters/render/grammar.ts'
import { humanRenderer } from '../adapters/render/human.ts'
import { jsonRenderer } from '../adapters/render/json.ts'
import { clampWidth } from '../adapters/render/human.ts'
import { RENDERINGS, isRendering, type Rendering, type Renderer } from '../adapters/render/index.ts'
import { targetFor } from '../adapters/target.ts'
import { WORKSPACE_DIR, WorkspaceUnreadable, initWorkspace, resolveStore } from '../adapters/workspace.ts'
import { Diagnostics, type Level } from './diagnostics.ts'
import { exitFor } from './exit.ts'
import { commandHelp, topLevelHelp } from './help.ts'
import { commandNamed } from './inventory.ts'
import { FILTER_FLAGS, parse, presentationFlags, type FilterFlag } from './parse.ts'
import { checkRuntime } from './runtime.ts'

// The one place the product's version is written. release-please rewrites this line on a
// release through the `generic` updater the marker below selects, and a test asserts it
// still equals package.json's version, so `treadle version` cannot drift from the tag.
export const VERSION = '0.1.0' // x-release-please-version

const RENDERERS: Readonly<Record<Rendering, Renderer>> = {
  agent: agentRenderer,
  json: jsonRenderer,
  human: humanRenderer,
}

export type Streams = {
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

export type Environment = {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly isTTY: boolean
  readonly nodeVersion: string
  readonly streams: Streams
}

function flag(flags: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

function actorOf(env: Environment, flags: Readonly<Record<string, unknown>>): Actor {
  const named = flag(flags, 'actor') ?? env.env['TREADLE_ACTOR']
  return { id: named ?? 'unknown', kind: env.env['TREADLE_ACTOR_KIND'] === 'agent' ? 'agent' : 'human' }
}

function modeOf(flags: Readonly<Record<string, unknown>>): Mode {
  if (flags['preview'] === true) return 'preview'
  if (flags['dry-run'] === true) return 'dry-run'
  return 'apply'
}

function levelOf(flags: Readonly<Record<string, unknown>>): Level {
  const verbose = flags['verbose']
  const count = Array.isArray(verbose) ? verbose.length : verbose === true ? 1 : 0
  return Math.min(3, count) as Level
}

function renderingOf(flags: Readonly<Record<string, unknown>>, isTTY: boolean): Rendering | undefined {
  const asked = flag(flags, 'out')
  if (asked === undefined) return isTTY ? 'human' : 'agent'
  return isRendering(asked) ? asked : undefined
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Every filter clause, in the order it was written on the command line. */
function filtersOf(
  flags: Readonly<Record<string, unknown>>, order: readonly FilterFlag[],
): readonly Filter[] {
  const written = order.length > 0 ? order : FILTER_FLAGS
  return written.flatMap((name) => {
    const value = flag(flags, name)
    return value === undefined ? [] : [{ field: name, value } as Filter]
  })
}

function fieldsOf(flags: Readonly<Record<string, unknown>>, fallback: readonly string[]): readonly string[] {
  const asked = flag(flags, 'fields')
  if (asked === undefined) return fallback
  if (asked.startsWith('+')) return [...fallback, ...asked.slice(1).split(',').filter((n) => n.length > 0)]
  return asked.split(',').filter((name) => name.length > 0)
}

function setFieldsOf(flags: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {}
  const direct: readonly (readonly [string, string])[] = [
    ['points', 'points'], ['priority', 'priority'], ['assignee', 'assignee'],
    ['desc', 'description'], ['sprint', 'sprint_id'], ['parent', 'parent_id'],
  ]
  for (const [name, field] of direct) {
    const value = flag(flags, name)
    if (value !== undefined) fields[field] = value
  }
  const labels = flags['label']
  if (Array.isArray(labels) && labels.length > 0) fields['labels'] = labels.join(',')
  const sets = flags['set']
  if (Array.isArray(sets)) {
    for (const entry of sets as readonly string[]) {
      const at = entry.indexOf('=')
      if (at > 0) fields[entry.slice(0, at)] = entry.slice(at + 1)
    }
  }
  return fields
}

function validation(command: string, cause: string, fix: readonly string[]): ResultObject {
  return errorResult({ code: 'VALIDATION', command, workspace: '-', effect: 'read', rule: 'C1', cause, fix })
}

function versionResult(env: Environment): ResultObject {
  return okResult(VERSION_SHAPE, {
    workspace: '-',
    data: {
      name: 'treadle',
      version: VERSION,
      store_schema: SCHEMA,
      contract: 'agent/1',
      node: env.nodeVersion,
    },
  })
}

/**
 * The one boundary every command crosses, and the only place an exception may be turned into
 * an exit status. R2 asks for a structured error on every failure path, and an exception is
 * one: a thrown `Error` that escaped here printed a Node stack trace on stderr with no
 * envelope, which is a second output grammar for a caller to parse and the one thing the
 * contract says never happens. A stack trace on stderr also names absolute paths and internal
 * frames, which is finding F10's class.
 */
export async function run(env: Environment): Promise<number> {
  try {
    return await execute(env)
  } catch (error) {
    const parsed = parse(env.argv)
    const flags = parsed.ok ? parsed.value.flags : presentationFlags(env.argv)
    const command = parsed.ok ? parsed.value.command : undefined
    return emit(env, internal(command, error), flags)
  }
}

/** The refusal an escaped exception becomes. It names what failed, never how it was thrown. */
function internal(command: string | undefined, error: unknown): ResultObject {
  const named = command ?? 'treadle'
  const thrown = error instanceof Error ? error : undefined
  const said = thrown === undefined ? String(error) : `${thrown.name}: ${thrown.message}`
  return errorResult({
    code: 'INTERNAL',
    command: named,
    workspace: '-',
    effect: commandNamed(named)?.effect ?? 'read',
    // A message from anywhere in the runtime is not held to the store's safe-text class, and
    // a bare carriage return in one would make the renderer throw on the path that exists to
    // stop a throw. Newlines survive, because the renderer puts a multi-line cause in a
    // counted block; nothing else the grammar treats as a delimiter does.
    cause: `${named} did not complete: ${said.replaceAll('\r\n', '\n').replaceAll('\r', ' ')}`,
    fix: ['treadle version'],
  })
}

async function execute(env: Environment): Promise<number> {
  // Both refusals below are raised before the flags are read, so the rendering the caller
  // asked for is read on its own: a refusal is a result object like any other (R2), and the
  // one thing it may not do is arrive in a format the caller did not ask for.
  const runtime = checkRuntime(env.nodeVersion)
  if (!runtime.ok) {
    const result = errorResult({
      code: 'STORE_UNAVAILABLE', command: 'treadle', workspace: '-', effect: 'read', cause: runtime.cause,
    })
    return emit(env, result, presentationFlags(env.argv))
  }

  const parsed = parse(env.argv)
  if (!parsed.ok) {
    const result = validation(env.argv[0] ?? 'treadle', parsed.cause, parsed.fix)
    return emit(env, result, presentationFlags(env.argv))
  }
  const { command, operands, flags, filterOrder } = parsed.value

  if (flags['contract'] === true) {
    env.streams.out(`${contractLines().join('\n')}\n`)
    return 0
  }
  if (command === undefined && flags['version'] === true) return emit(env, versionResult(env), flags)
  if (command === 'version') return emit(env, versionResult(env), flags)

  const rendering = renderingOf(flags, env.isTTY)
  if (rendering === undefined) {
    return emit(env, validation('treadle', `--out takes one of ${RENDERINGS.join(', ')}`, ['treadle help']), flags)
  }

  if (command === 'help' || flags['help'] === true) {
    const topic = command === 'help' ? operands[0] : command
    if (topic === undefined) return emit(env, topLevelHelp('-'), flags)
    const help = commandHelp(topic, '-')
    if (help === undefined) {
      return emit(env, validation('help', `${topic} is not a treadle command`, ['treadle help']), flags)
    }
    return emit(env, help, flags)
  }

  const level = levelOf(flags)
  const diagnostics = new Diagnostics({
    level,
    logValues: flags['log-values'] === true,
    write: (line) => env.streams.err(`${line}\n`),
  })

  // The actor lands whole in the append-only log, which is the third unbounded prose door
  // this tool has closed: T7 bounded a transition's reason for the same reason, and the log
  // is now read back by `history`, so an unbounded identity would be unbounded output too.
  // The bound applies only where the actor is recorded: a mutating command writes it into an
  // event, while a read command accepts and ignores it, per the inventory's own 'A' verdict.
  if (commandNamed(command ?? 'status')?.effect === 'mutate') {
    const badActor = actorRefusal(actorOf(env, flags))
    if (badActor !== undefined) {
      return emit(env, validation(command ?? 'treadle', badActor, ['treadle --actor <name>']), flags)
    }
  }

  if (command === 'init') {
    const at = flag(flags, 'workspace') ?? path.join(env.cwd, WORKSPACE_DIR)
    const name = flag(flags, 'name')
    const result = await initWorkspace(systemClock, randomIds, {
      at,
      ...(name === undefined ? {} : { name }),
      actor: actorOf(env, flags),
      ...(flags['yes'] === true ? { yes: true } : {}),
    })
    return emit(env, result, flags)
  }

  let root: string | undefined
  try {
    root = flag(flags, 'workspace') ?? await resolveStore(env.cwd)
  } catch (error) {
    if (!(error instanceof WorkspaceUnreadable)) throw error
    return emit(env, errorResult({
      code: 'STORE_UNAVAILABLE', command: command ?? 'status', workspace: '-', effect: 'read', rule: 'S13',
      cause: `${error.message}; make it readable, or name another store with --workspace`,
    }), flags)
  }
  if (root === undefined) {
    if (command === undefined) return emit(env, topLevelHelp('-'), flags)
    return emit(env, errorResult({
      code: 'STORE_UNAVAILABLE', command: command ?? 'status', workspace: '-', effect: 'read', rule: 'S1',
      cause: `no treadle workspace was found from ${env.cwd} or any directory above it`,
      fix: ['treadle init'],
    }), flags)
  }
  diagnostics.note('store', root)

  // `doctor` answers from the files and never from what the index held: the refusal every
  // other command prints names it as the fix, so it has to be the way back (ADR-0020).
  const opened = await openWorkspace(root, command === 'doctor' ? { rederive: true } : {})
  if (!opened.ok) {
    return emit(env, errorResult({
      code: 'STORE_UNAVAILABLE', command: command ?? 'status', workspace: '-', effect: 'read',
      rule: opened.error.rule, cause: opened.error.message, fix: ['treadle init'],
    }), flags)
  }

  const store: Store = level >= 3 ? new LoggingStore(opened.value, diagnostics) : opened.value
  const target = targetFor(store, modeOf(flags))

  try {
    const started = performance.now()
    const result = await dispatch(env, { command, operands, flags, filterOrder, store, target })
    diagnostics.timing(command ?? 'status', Math.round(performance.now() - started))
    return emit(env, result, flags)
  } finally {
    await opened.value.close()
  }
}

type Dispatch = {
  readonly command: string | undefined
  readonly operands: readonly string[]
  readonly flags: Readonly<Record<string, unknown>>
  readonly filterOrder: readonly FilterFlag[]
  readonly store: Store
  readonly target: Target
}

async function dispatch(env: Environment, input: Dispatch): Promise<ResultObject> {
  const { command, operands, flags, store, target } = input
  const actor = actorOf(env, flags)

  if (command === undefined || command === 'status') return status(store, systemClock)

  if (command === 'backlog') {
    const columns = fieldsOf(flags, DEFAULT_BACKLOG_COLUMNS)
    const absence = flag(flags, 'explain-absence')
    const cursor = flag(flags, 'cursor')
    return backlog(store, {
      filters: filtersOf(flags, input.filterOrder),
      columns,
      limit: positiveInt(flag(flags, 'limit'), 9),
      ...(cursor === undefined ? {} : { cursor }),
      ...(absence === undefined ? {} : { explainAbsence: absence }),
    })
  }

  if (command === 'board') {
    const absence = flag(flags, 'explain-absence')
    return board(store, systemClock, {
      filters: filtersOf(flags, input.filterOrder),
      columns: fieldsOf(flags, DEFAULT_BOARD_COLUMNS),
      limit: positiveInt(flag(flags, 'limit'), 9),
      all: flags['all'] === true,
      ...(absence === undefined ? {} : { explainAbsence: absence }),
    })
  }

  if (command === 'doctor') return doctor(store)

  if (command === 'next') {
    const forActor = flag(flags, 'for')
    const absence = flag(flags, 'explain-absence')
    const cursor = flag(flags, 'cursor')
    return next(store, systemClock, {
      limit: positiveInt(flag(flags, 'limit'), 3),
      ...(cursor === undefined ? {} : { cursor }),
      ...(forActor === undefined ? {} : { forActor }),
      ...(absence === undefined ? {} : { explainAbsence: absence }),
    })
  }

  const id = operands[0]
  if (command === 'show') {
    if (id === undefined) return validation('show', 'show needs the id of one item', ['treadle backlog'])
    return showItem(store, systemClock, id, flag(flags, 'field'))
  }
  if (command === 'explain') {
    if (id === undefined) return validation('explain', 'explain needs the id of one item', ['treadle backlog'])
    return explain(store, id)
  }
  if (command === 'history') {
    if (id === undefined) return validation('history', 'history needs the id of one item', ['treadle backlog'])
    const cursor = flag(flags, 'cursor')
    return history(store, id, {
      limit: positiveInt(flag(flags, 'limit'), 9),
      ...(cursor === undefined ? {} : { cursor }),
    })
  }

  if (command === 'file') {
    const type = operands[0]
    const title = operands[1]
    if (type === undefined || !(WORK_ITEM_TYPES as readonly string[]).includes(type)) {
      return validation('file', `file needs a type, one of ${WORK_ITEM_TYPES.join(', ')}`, ['treadle help file'])
    }
    if (title === undefined) return validation('file', 'file needs a title in quotes', ['treadle help file'])
    const chosen = flag(flags, 'id')
    return fileItem(target, systemClock, randomIds, {
      type: type as WorkItemType, title, ...(chosen === undefined ? {} : { id: chosen }),
      fields: setFieldsOf(flags), actor,
    })
  }

  if (command === 'set') {
    if (id === undefined) return validation('set', 'set needs the id of one item', ['treadle backlog'])
    return setFields(target, systemClock, randomIds, { id, assignments: operands.slice(1), actor })
  }

  if (command === 'mark') {
    if (id === undefined) return validation('mark', 'mark needs the id of one item', ['treadle backlog'])
    const severity = flag(flags, 'severity')
    const priority = flag(flags, 'priority')
    const reason = flag(flags, 'reason')
    return markItem(target, systemClock, randomIds, {
      id,
      ...(severity === undefined ? {} : { severity }),
      ...(priority === undefined ? {} : { priority }),
      ...(reason === undefined ? {} : { reason }),
      actor,
    })
  }

  if (command === 'evidence') {
    // One subcommand today, and it is named rather than assumed: `evidence add` is append,
    // and a later `evidence list` or `evidence drop` must not silently inherit this path.
    const [verb, entity, kind, ref, label] = operands
    if (verb !== 'add') {
      return validation('evidence', `evidence takes one subcommand, add, not ${verb ?? 'nothing'}`, ['treadle help evidence'])
    }
    if (entity === undefined || kind === undefined || ref === undefined) {
      return validation('evidence', 'evidence add needs an id, a kind and a ref', ['treadle help evidence'])
    }
    return addEvidence(target, systemClock, randomIds, {
      id: entity, kind, ref, ...(label === undefined ? {} : { label }), actor,
    })
  }

  if (command === 'relation') {
    const [verb, entity, kind, other] = operands
    if (verb === undefined || !(RELATION_VERBS as readonly string[]).includes(verb)) {
      return validation('relation', `relation takes one of ${RELATION_VERBS.join(', ')}, not ${verb ?? 'nothing'}`, ['treadle help relation'])
    }
    if (entity === undefined || kind === undefined || other === undefined) {
      return validation('relation', `relation ${verb} needs an id, a kind and the other id`, ['treadle help relation'])
    }
    return relate(target, systemClock, randomIds, { verb: verb as RelationVerb, id: entity, kind, other, actor })
  }

  if (command === 'sprints') return sprints(store, systemClock, operands[0])

  if (command === 'sprint') {
    // Five verbs, each named: the read is `sprints`, so nothing here is reached by omission.
    const [verb, first, ...rest] = operands
    if (verb === 'open') {
      if (first === undefined) return validation('sprint', 'sprint open needs a title in quotes', ['treadle help sprint'])
      const end = flag(flags, 'end')
      if (end === undefined) return validation('sprint', 'sprint open needs --end <date>, the last day of the sprint', ['treadle help sprint'])
      const chosen = flag(flags, 'id')
      const start = flag(flags, 'start')
      const goal = flag(flags, 'goal')
      return openSprint(target, systemClock, randomIds, {
        title: first, end, actor,
        ...(chosen === undefined ? {} : { id: chosen }),
        ...(start === undefined ? {} : { start }),
        ...(goal === undefined ? {} : { goal }),
      })
    }
    if (verb === 'commit') {
      if (first === undefined) return validation('sprint', 'sprint commit needs a sprint id and then one or more item ids', ['treadle help sprint'])
      return commitItems(target, systemClock, randomIds, { sprint: first, items: rest, actor })
    }
    if (verb === 'uncommit') return uncommitItems(target, systemClock, randomIds, { items: first === undefined ? [] : [first, ...rest], actor })
    if (verb === 'close' || verb === 'reopen') {
      if (first === undefined) return validation('sprint', `sprint ${verb} needs the id of one sprint`, ['treadle sprints'])
      const request = { sprint: first, actor }
      return verb === 'close'
        ? closeSprint(target, systemClock, randomIds, request)
        : reopenSprint(target, systemClock, randomIds, request)
    }
    return validation('sprint', `sprint takes one of open, commit, uncommit, close, reopen, not ${verb ?? 'nothing'}`, ['treadle help sprint'])
  }

  if (command === 'transition') {
    const targetState = operands[1]
    if (id === undefined || targetState === undefined) {
      return validation('transition', 'transition needs an id and a target state', ['treadle help transition'])
    }
    if (targetState !== 'resume' && !(WORK_ITEM_STATES as readonly string[]).includes(targetState)) {
      return validation('transition', `${targetState} is not a state; the targets are ${WORK_ITEM_STATES.join(', ')} and resume`, ['treadle help transition'])
    }
    const reason = flag(flags, 'reason')
    const until = flag(flags, 'until')
    const overrides = flags['override']
    // Both are closed sets the domain owns (`T6`), so they are carried through unchecked
    // here: a second copy of the set in the command layer is a second thing to keep in step.
    const resolution = flag(flags, 'resolution') as Resolution | undefined
    const outcome = flag(flags, 'outcome') as AttemptOutcome | undefined
    return transition(target, systemClock, randomIds, {
      id,
      target: targetState as WorkItemState | 'resume',
      ...(reason === undefined ? {} : { reason }),
      ...(until === undefined ? {} : { until }),
      ...(resolution === undefined ? {} : { resolution }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(Array.isArray(overrides) ? { overrides: overrides as readonly GuardId[] } : {}),
      actor,
    })
  }

  return validation(command, `${command} is not wired to a use case yet`, ['treadle help'])
}

function emit(env: Environment, result: ResultObject, flags: Readonly<Record<string, unknown>>): number {
  const rendering = renderingOf(flags, env.isTTY) ?? 'agent'
  const renderer = RENDERERS[rendering]
  const page = pageFor(result)
  const bytes = renderer.render(result, {
    width: clampWidth(Number.parseInt(flag(flags, 'width') ?? '', 10) || widthOf(env)),
    ...(flag(flags, 'field') === undefined ? {} : { fieldLimit: null }),
    ...(page === undefined ? {} : { page }),
    ...(flags['quiet'] === true ? { quiet: true } : {}),
    ...(flags['ascii'] === true ? { ascii: true } : {}),
  })
  if (result.ok) env.streams.out(bytes)
  else env.streams.err(bytes)
  return exitFor(result)
}

/** The command a truncation sentinel points at, built from the command and a validated id. */
function pageFor(result: ResultObject): string | undefined {
  const item = result.data['item']
  if (result.command !== 'show' || typeof item !== 'string') return undefined
  return `treadle show ${item}`
}

function widthOf(env: Environment): number {
  const columns = Number.parseInt(env.env['COLUMNS'] ?? '', 10)
  return Number.isInteger(columns) && columns > 0 ? columns : 80
}
