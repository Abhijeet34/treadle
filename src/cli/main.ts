// SPDX-License-Identifier: Apache-2.0
// One command, one result object, one rendering, one exit status.
//
// Every path through this file ends the same way: a result object goes to `emit`, which
// picks the rendering, writes a success to stdout and a refusal to stderr, and returns the
// exit status the result's own `code` field decides. There is no path that prints and then
// decides separately what to return, which is the class R3 exists to close.

import path from 'node:path'

import type { WorkItemState, WorkItemType } from '../domain/index.ts'
import { WORK_ITEM_STATES, WORK_ITEM_TYPES, type GuardId } from '../domain/index.ts'
import { errorResult, okResult, type ResultObject } from '../application/result.ts'
import { VERSION_SHAPE } from '../application/services/meta.ts'
import { backlog, fileItem, showItem, type Filter } from '../application/services/items.ts'
import { explain, next, status } from '../application/services/insight.ts'
import { transition } from '../application/services/lifecycle.ts'
import type { Actor, Mode } from '../application/services/mutation.ts'
import type { Store } from '../application/ports/store.ts'
import { systemClock } from '../adapters/clock.ts'
import { randomIds } from '../adapters/ids.ts'
import { LoggingStore } from '../adapters/logging-store.ts'
import { OverlayStore, SCHEMA, openWorkspace } from '../adapters/store/index.ts'
import { agentRenderer } from '../adapters/render/agent.ts'
import { contractLines } from '../adapters/render/grammar.ts'
import { humanRenderer } from '../adapters/render/human.ts'
import { jsonRenderer } from '../adapters/render/json.ts'
import { clampWidth } from '../adapters/render/human.ts'
import { RENDERINGS, isRendering, type Rendering, type Renderer } from '../adapters/render/index.ts'
import { WORKSPACE_DIR, initWorkspace, resolveStore } from '../adapters/workspace.ts'
import { Diagnostics, type Level } from './diagnostics.ts'
import { EXIT_OF, exitFor } from './exit.ts'
import { commandHelp, topLevelHelp } from './help.ts'
import { FILTER_FLAGS, parse, type FilterFlag } from './parse.ts'
import { checkRuntime } from './runtime.ts'

export const VERSION = '0.1.0'

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

export async function run(env: Environment): Promise<number> {
  const runtime = checkRuntime(env.nodeVersion)
  if (!runtime.ok) {
    env.streams.err(`err STORE_UNAVAILABLE -\ncause ${runtime.cause}\n`)
    return EXIT_OF.STORE_UNAVAILABLE
  }

  const parsed = parse(env.argv)
  if (!parsed.ok) {
    const result = validation(env.argv[0] ?? 'treadle', parsed.cause, parsed.fix)
    return emit(env, result, {})
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

  const root = flag(flags, 'workspace') ?? await resolveStore(env.cwd)
  if (root === undefined) {
    if (command === undefined) return emit(env, topLevelHelp('-'), flags)
    return emit(env, errorResult({
      code: 'STORE_UNAVAILABLE', command: command ?? 'status', workspace: '-', effect: 'read', rule: 'S1',
      cause: `no treadle workspace was found from ${env.cwd} or any directory above it`,
      fix: ['treadle init'],
    }), flags)
  }
  diagnostics.note('store', root)

  const opened = await openWorkspace(root)
  if (!opened.ok) {
    return emit(env, errorResult({
      code: 'STORE_UNAVAILABLE', command: command ?? 'status', workspace: '-', effect: 'read',
      rule: opened.error.rule, cause: opened.error.message, fix: ['treadle init'],
    }), flags)
  }

  const base: Store = level >= 3 ? new LoggingStore(opened.value, diagnostics) : opened.value
  const mode = modeOf(flags)
  const store: Store = mode === 'dry-run' ? new OverlayStore(base) : base

  try {
    const result = await dispatch(env, { command, operands, flags, filterOrder, store, mode })
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
  readonly mode: Mode
}

async function dispatch(env: Environment, input: Dispatch): Promise<ResultObject> {
  const { command, operands, flags, store, mode } = input
  const actor = actorOf(env, flags)

  if (command === undefined || command === 'status') return status(store, systemClock)

  if (command === 'backlog') {
    const columns = fieldsOf(flags, ['id', 'type', 'state', 'pts', 'title'])
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

  if (command === 'next') {
    const forActor = flag(flags, 'for')
    const absence = flag(flags, 'explain-absence')
    return next(store, systemClock, {
      limit: positiveInt(flag(flags, 'limit'), 3),
      ...(forActor === undefined ? {} : { forActor }),
      ...(absence === undefined ? {} : { explainAbsence: absence }),
    })
  }

  const id = operands[0]
  if (command === 'show') {
    if (id === undefined) return validation('show', 'show needs the id of one item', ['treadle backlog'])
    return showItem(store, id, flag(flags, 'field'))
  }
  if (command === 'explain') {
    if (id === undefined) return validation('explain', 'explain needs the id of one item', ['treadle backlog'])
    return explain(store, id)
  }

  if (command === 'file') {
    const type = operands[0]
    const title = operands[1]
    if (type === undefined || !(WORK_ITEM_TYPES as readonly string[]).includes(type)) {
      return validation('file', `file needs a type, one of ${WORK_ITEM_TYPES.join(', ')}`, ['treadle help file'])
    }
    if (title === undefined) return validation('file', 'file needs a title in quotes', ['treadle help file'])
    const chosen = flag(flags, 'id')
    return fileItem(store, systemClock, randomIds, {
      type: type as WorkItemType, title, ...(chosen === undefined ? {} : { id: chosen }),
      fields: setFieldsOf(flags), actor, mode,
    })
  }

  if (command === 'transition') {
    const target = operands[1]
    if (id === undefined || target === undefined) {
      return validation('transition', 'transition needs an id and a target state', ['treadle help transition'])
    }
    if (target !== 'resume' && !(WORK_ITEM_STATES as readonly string[]).includes(target)) {
      return validation('transition', `${target} is not a state; the targets are ${WORK_ITEM_STATES.join(', ')} and resume`, ['treadle help transition'])
    }
    const reason = flag(flags, 'reason')
    const until = flag(flags, 'until')
    const overrides = flags['override']
    return transition(store, systemClock, randomIds, {
      id,
      target: target as WorkItemState | 'resume',
      ...(reason === undefined ? {} : { reason }),
      ...(until === undefined ? {} : { until }),
      ...(Array.isArray(overrides) ? { overrides: overrides as readonly GuardId[] } : {}),
      actor,
      mode,
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
