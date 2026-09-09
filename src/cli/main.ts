// SPDX-License-Identifier: Apache-2.0
// One command, one result object, one rendering, one exit status.
//
// Every path through this file ends the same way: a result object goes to `emit`, which
// picks the rendering, writes a success to stdout and a refusal to stderr, and returns the
// exit status the result's own `code` field decides. There is no path that prints and then
// decides separately what to return, which is the class R3 exists to close.

import path from 'node:path'

import type { AttemptOutcome, Resolution, WorkItemState, WorkItemType } from '../domain/index.ts'
import { MAX_LINE, WORK_ITEM_STATES, WORK_ITEM_TYPES, asInstant, canonicalField, findUnsafeCharacter, shellWord, type GuardId } from '../domain/index.ts'
import { errorResult, okResult, type ResultObject } from '../application/result.ts'
import { VERSION_SHAPE } from '../application/services/meta.ts'
import { readConfig, setConfig } from '../application/services/config.ts'
import { doctor } from '../application/services/doctor.ts'
import { setFields } from '../application/services/editing.ts'
import { DEFAULT_BACKLOG_COLUMNS, DEFAULT_LIMIT, backlog, fileItem, invocation, showItem, type Filter } from '../application/services/items.ts'
import { addEvidence, markItem } from '../application/services/marking.ts'
import { history } from '../application/services/history.ts'
import { DEFAULT_NEXT_LIMIT, explain, next, status } from '../application/services/insight.ts'
import { RELATION_VERBS, relate, type RelationVerb } from '../application/services/relation.ts'
import { removeItem } from '../application/services/removal.ts'
import { transition } from '../application/services/lifecycle.ts'
import { actorKindRefusal, actorRefusal, type Actor, type Mode, type Target } from '../application/services/mutation.ts'
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
import { arityRefusal, operandRefusal } from './operands.ts'
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

/**
 * The actor this line names, from the flag or the environment, or `undefined` for neither.
 *
 * An exported `TREADLE_ACTOR=` is neither: a variable set to nothing names nobody exactly as
 * an unset one does, and it is what a CI job produces from an unpopulated secret. Left as a
 * value it earned `an actor must be a name with no leading or trailing whitespace`, a sentence
 * about a rule the caller did not break, whose fix line named the flag and never the variable
 * that was actually empty. An explicit `--actor ""` is left a value, because there the caller
 * wrote the flag and the flag is what the refusal already names.
 */
function namedActor(env: Environment, flags: Readonly<Record<string, unknown>>): string | undefined {
  const exported = env.env['TREADLE_ACTOR']
  return flag(flags, 'actor') ?? (exported === undefined || exported.trim() === '' ? undefined : exported)
}

/**
 * The actor a write is recorded under. The empty string is unreachable on a write: `records`
 * below refuses a recording line that names nobody, and a read is handed this and ignores it
 * per the inventory's own 'A' verdict for `--actor`.
 *
 * It used to fall back to the literal `unknown`, which is the defect: a log whose product is
 * who-did-what stored a name nobody wrote, indistinguishable from an actor really called
 * that, and `history` printed it as `by unknown` for ever.
 */
function actorOf(env: Environment, flags: Readonly<Record<string, unknown>>): Actor {
  return {
    id: namedActor(env, flags) ?? '',
    kind: env.env['TREADLE_ACTOR_KIND'] === 'agent' ? 'agent' : 'human',
  }
}

/**
 * Whether this line will write an event, which is the only place an actor is recorded.
 *
 * It is not the command's declared effect alone, because `config` declares `mutate` over both
 * a read and a write (ADR-0026): the bare read records nothing, so demanding an identity for
 * it would refuse a read over a field it would never store.
 */
function records(command: string | undefined, operands: readonly string[]): boolean {
  if (commandNamed(command ?? 'status')?.effect !== 'mutate') return false
  return command !== 'config' || operands[0] === 'set'
}

function modeOf(flags: Readonly<Record<string, unknown>>): Mode {
  return flags['dry-run'] === true ? 'dry-run' : 'apply'
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

/** The plain positive integers, and nothing `Number.parseInt` would salvage a prefix from. */
const COUNT = /^[0-9]+$/

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * The flags the line bound below does not apply to, each because something else already bounds
 * it and says so better: `--desc`, `--goal`, `--reason` and every `--set <field>=` carry a
 * field's prose and are held to that field's own check, `--actor` to `actorRefusal`, and
 * `--workspace` is a filesystem path rather than a value of any record.
 */
const BOUNDED_ELSEWHERE = new Set(['desc', 'goal', 'reason', 'set', 'actor', 'workspace'])

/**
 * The first flag whose value this line cannot mean, as a refusal. Two rules, both about a
 * value the tool would otherwise read past and then print back.
 *
 * A count flag is supported and read through a parser that salvages a prefix: `--width 1_0`
 * and `--width 1e9` both laid the page out at 40 cells, and `--width NaN` and `--limit abc`
 * used the default, each without a word. A supported flag that silently ignores what the
 * caller wrote is `--width`'s own help note one layer down.
 *
 * Every other flag names an entity or filters on a field, and no field of a record holds more
 * than one line. `treadle backlog --assignee <100,000 characters>` exited 0 with 200 KB of
 * stdout, because the value no record could carry came back in the `filter` and `narrowest`
 * lines and in the `page` line built from them. Refusing it here bounds all four and every
 * later reader of a filter, rather than one guard per line that prints one.
 *
 * The safe-line rule is asked of every flag on every command for the same reason G2 puts one
 * on every operand: it was asked of the eight filters alone, and `--id`, `--cursor` and
 * `--explain-absence` reached a scalar line unbounded on five commands. `backlog --cursor
 * $'a\nb'` printed `err INTERNAL` at exit 1 out of the renderer's invariant.
 */
function flagValueRefusal(
  flags: Readonly<Record<string, unknown>>, command: string | undefined,
): ResultObject | undefined {
  const help = [command === undefined ? 'treadle help' : `treadle help ${command}`]
  for (const name of ['width', 'limit'] as const) {
    const value = flag(flags, name)
    if (value === undefined) continue
    if (COUNT.test(value) && Number.parseInt(value, 10) > 0) continue
    return validation(
      command ?? 'treadle',
      `--${name} takes a whole number of at least 1, and ${shellWord(value)} is not one`,
      help,
    )
  }
  // `--for` names the actor a ranking is weighted for, so it is held to the rule that names
  // an actor anywhere else: `next --for ""` armed the assignee weight for a blank name and
  // printed `asg 8` over it, where `--actor ""` was refused by this same sentence.
  const forActor = flag(flags, 'for')
  if (forActor !== undefined) {
    const bad = actorRefusal({ id: forActor, kind: 'human' })
    if (bad !== undefined) return validation(command ?? 'treadle', bad, help)
  }
  for (const [name, value] of Object.entries(flags)) {
    if (BOUNDED_ELSEWHERE.has(name)) continue
    // The length bound reads a string flag and the safe-line bound reads a repeatable one
    // too. Widening the length bound to a repeatable flag would preempt `file --label`'s own
    // dictionary refusal, which names the slug rule rather than a line length; the safe-line
    // bound has no such sibling, because a delimiter is refused by no field dictionary
    // before the renderer has already thrown on it.
    if (typeof value === 'string' && value.length > MAX_LINE) {
      return validation(
        command ?? 'treadle',
        `--${name} is ${value.length} characters and no field of a record holds more than ${MAX_LINE}, so nothing could match it`,
        help,
      )
    }
    for (const one of valuesOf(flags, name)) {
      const found = findUnsafeCharacter(one, 'line')
      if (found === undefined) continue
      return validation(
        command ?? 'treadle',
        `--${name} carries ${found.label} at character ${found.at + 1}, and no field of a record holds one: a value on this line is a single line with no control or bidi override characters`,
        help,
      )
    }
  }
  // The rule below is about a filter's value rather than any flag's, so it is asked of the
  // one command that filters and of nothing else: on `file` the same flag names a field, and
  // the field dictionary already refuses it with a better sentence.
  if (command !== 'backlog') return undefined

  // A filter value comes back in the `filter`, `narrowest` and `page` lines, and the agent
  // rendering treats a newline as a record delimiter, so a value carrying one threw a render
  // invariant out of a read: `backlog --assignee $'kim\nfake'` printed `err INTERNAL` and
  // exited 1 on the tree before this one. It is the same class the length bound above closes
  // and it is closed in the same place, for every filter at once rather than per line printed.
  for (const name of FILTER_FLAGS) {
    for (const value of valuesOf(flags, name)) {
      // The length bound above reads a string flag, so a repeatable one is bounded here
      // instead of there, for the reason that bound's own comment gives. The safe-line half
      // of this loop moved into it, because it now covers every flag rather than these seven.
      if (value.length <= MAX_LINE) continue
      return validation(
        command,
        `--${name} is ${value.length} characters and no field of a record holds more than ${MAX_LINE}, so nothing could match it`,
        help,
      )
    }
  }

  // `--title` is the one filter that matches on words rather than on a whole value, so a
  // value with no word in it is the one filter value that would select everything instead of
  // nothing. Every other filter compares a value a record either carries or does not, and an
  // empty one there matches nothing and says so through `narrowest`.
  const title = flag(flags, 'title')
  if (title !== undefined && title.trim().length === 0) {
    return validation(
      command,
      '--title searches titles for the words it is given, and this value has none',
      help,
    )
  }
  return undefined
}

/** Every filter clause, in the order it was written on the command line. */
function filtersOf(
  flags: Readonly<Record<string, unknown>>, order: readonly FilterFlag[],
): readonly Filter[] {
  const written = order.length > 0 ? order : FILTER_FLAGS
  return written.flatMap((name) => valuesOf(flags, name).map((value) => ({ field: name, value } as Filter)))
}

/**
 * Every value a filter flag was given, in the order written. All but `--label` take one, and
 * `--label` repeats into one clause per label, so `matches` ands them like any other pair.
 */
function valuesOf(flags: Readonly<Record<string, unknown>>, name: string): readonly string[] {
  const value = flags[name]
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * A field this line assigns more than once, in the spelling the caller wrote. G1 refuses a
 * single-valued flag written twice, and an assignment is that shape without the dashes:
 * `set rotate assignee=kim assignee=bob` wrote `bob`, and no line of the answer said `kim`
 * had been read and thrown away. Through `canonicalField`, so `desc=` and `description=` are
 * the one field they name.
 *
 * A name carrying a delimiter is passed over rather than echoed: it is a field no record has,
 * and `setFields` refuses it by name one layer down with the sentence that says so.
 */
function repeatedAssignment(assignments: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const entry of assignments) {
    const at = entry.indexOf('=')
    if (at <= 0) continue
    const name = canonicalField(entry.slice(0, at))
    if (findUnsafeCharacter(name, 'line') !== undefined) continue
    if (seen.has(name)) return shellWord(name)
    seen.add(name)
  }
  return undefined
}

function fieldsOf(flags: Readonly<Record<string, unknown>>, fallback: readonly string[]): readonly string[] {
  const asked = flag(flags, 'fields')
  if (asked === undefined) return fallback
  if (asked.startsWith('+')) return [...fallback, ...asked.slice(1).split(',').filter((n) => n.length > 0)]
  return asked.split(',').filter((name) => name.length > 0)
}

/**
 * The fields `file` was given, from its title operand, its named flags and its `--set` pairs.
 * One field named twice with two values is a refusal rather than a quiet winner: `--parent
 * epic-one --set parent_id=story-wip` filed under story-wip and said nothing about the flag
 * it dropped.
 *
 * The title is seeded here because it arrives as an operand rather than as a flag, and that
 * is the one field the rule did not reach: `file task "Title A" --set title="Title B"` stored
 * `Title B`, confirmed `title Title A`, and left no event carrying either.
 */
function setFieldsOf(
  flags: Readonly<Record<string, unknown>>, title: string,
): { readonly fields: Readonly<Record<string, string>> } | { readonly refusal: ResultObject } {
  const fields: Record<string, string> = {}
  const spelled = new Map<string, { readonly by: string; readonly value: string }>([
    ['title', { by: 'the title operand', value: title }],
  ])
  const direct: readonly (readonly [string, string])[] = [
    ['priority', 'priority'], ['assignee', 'assignee'],
    ['desc', 'description'], ['parent', 'parent_id'],
  ]
  for (const [name, field] of direct) {
    const value = flag(flags, name)
    if (value !== undefined) { fields[field] = value; spelled.set(field, { by: `--${name}`, value }) }
  }
  const labels = flags['label']
  if (Array.isArray(labels) && labels.length > 0) {
    fields['labels'] = labels.join(',')
    spelled.set('labels', { by: '--label', value: fields['labels'] })
  }
  const sets = flags['set']
  if (Array.isArray(sets)) {
    for (const entry of sets as readonly string[]) {
      const at = entry.indexOf('=')
      if (at <= 0) continue
      const name = canonicalField(entry.slice(0, at))
      const value = entry.slice(at + 1)
      const before = spelled.get(name)
      if (before !== undefined && before.value !== value) {
        return { refusal: validation('file', `${before.by} and --set ${entry.slice(0, at)}= both set ${name}, and a field is set once on one line`, ['treadle help file']) }
      }
      fields[name] = value
      spelled.set(name, { by: `--set ${entry.slice(0, at)}=`, value })
    }
  }
  return { fields }
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

  // Before `--contract`, `--help` and `version`, which are the three lines that answer
  // without reaching a dispatch arm: an operand no usage line takes is refused wherever it
  // was written, and `treadle version extra` was one of the twelve that swallowed it.
  const badArity = arityRefusal(command, operands)
  if (badArity !== undefined) return emit(env, badArity, flags)

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

  const badFlag = flagValueRefusal(flags, command)
  if (badFlag !== undefined) return emit(env, badFlag, flags)

  // Beside its sibling above, and for the same reason: both bound a caller's word before any
  // service reads it, and both run before the workspace is resolved so that a line no store
  // could answer is refused by what it says rather than by where it was run.
  const badOperand = operandRefusal(command, operands)
  if (badOperand !== undefined) return emit(env, badOperand, flags)

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
  if (records(command, operands)) {
    // Before the shape of the actor is weighed, because a line that names nobody has no shape
    // to weigh: `actorRefusal` would report the empty name as whitespace, which is a sentence
    // about a value the caller never wrote.
    if (namedActor(env, flags) === undefined) {
      return emit(env, validation(
        command ?? 'treadle',
        `${command ?? 'treadle'} records who made the change, and neither TREADLE_ACTOR nor --actor names anyone; the record would carry a name nobody wrote`,
        ['export TREADLE_ACTOR=<your-name>', 'treadle --actor <name>'],
      ), flags)
    }
    const badActor = actorRefusal(actorOf(env, flags))
    if (badActor !== undefined) {
      return emit(env, validation(command ?? 'treadle', badActor, ['treadle --actor <name>']), flags)
    }
    // The raw variable, because `actorOf` above has already resolved it to one of the two
    // words: anything else was recorded as `human` in silence, against a `help` line that
    // names the pair. There is no flag for it, so the remedy is the export itself.
    const badKind = actorKindRefusal(env.env['TREADLE_ACTOR_KIND'])
    if (badKind !== undefined) {
      return emit(env, validation(command ?? 'treadle', badKind, ['export TREADLE_ACTOR_KIND=agent']), flags)
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

  const opened = await openWorkspace(root)
  if (!opened.ok) {
    // A workspace file that is missing is `init`'s to write. One at a schema this build does
    // not read is not: `init` answers `already` there, so the line offered is the one that
    // dates the tool against the file. The other refusals carry their own instruction in the
    // cause, and no command line stands in for it.
    //
    // The code and not the rule decides the first of those, because a `workspace.md` the
    // grammar quarantined also refuses under `S1` and `init` answers `already` over it: that
    // refusal names the line to edit and there is no command that stands in for the edit,
    // so it is one of the ones that offers nothing.
    const missing = opened.error.code === 'STORE_UNAVAILABLE' && opened.error.rule === 'S1'
    const fix = missing ? ['treadle init'] : opened.error.rule === 'S8' ? ['treadle version'] : []
    return emit(env, errorResult({
      code: 'STORE_UNAVAILABLE', command: command ?? 'status', workspace: '-', effect: 'read',
      rule: opened.error.rule, cause: opened.error.message, ...(fix.length === 0 ? {} : { fix }),
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
    return backlog(store, systemClock, {
      filters: filtersOf(flags, input.filterOrder),
      columns,
      limit: positiveInt(flag(flags, 'limit'), DEFAULT_LIMIT),
      ...(cursor === undefined ? {} : { cursor }),
      ...(absence === undefined ? {} : { explainAbsence: absence }),
    })
  }

  if (command === 'doctor') return doctor(store, systemClock)

  if (command === 'config') {
    const verb = operands[0]
    if (verb === undefined) return readConfig(store)
    if (verb !== 'set') {
      return validation('config', `config takes no verb to read and set to write, and ${shellWord(verb)} is neither`, ['treadle config', 'treadle help config'])
    }
    const key = operands[1]
    const value = operands[2]
    if (key === undefined) return validation('config', 'config set needs the key to write', ['treadle config'])
    // An empty value is a real value for no key here: every key's grammar needs at least one
    // character, so the clearing syntax `set <field>=` has nothing to mean and a key is put
    // back to its default by writing the default, which the `source` column then reports.
    if (value === undefined) return validation('config', `config set needs the value to write to ${key}`, ['treadle config', `treadle help config`])
    return setConfig(target, systemClock, randomIds, { key, value, actor })
  }

  if (command === 'next') {
    const forActor = flag(flags, 'for')
    const absence = flag(flags, 'explain-absence')
    const cursor = flag(flags, 'cursor')
    return next(store, systemClock, {
      limit: positiveInt(flag(flags, 'limit'), DEFAULT_NEXT_LIMIT),
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
    return explain(store, systemClock, id, actor.id)
  }
  if (command === 'history') {
    const txn = flag(flags, 'txn')
    // The two scopes are one question each and their intersection is a third nobody asked,
    // so the line is refused rather than answered. Both readings are printed as the lines
    // that give them, which is what the caller runs next.
    if (id !== undefined && txn !== undefined) {
      return validation(
        'history',
        '--txn and an id ask different questions: an id is every change to one record, --txn is every change one command made',
        [invocation('history', [id], []), invocation('history', [], [['txn', txn]])],
      )
    }
    // `--txn=` reached the store as an empty transaction id and came back as a refusal that
    // named nothing: `cause  names no transaction here`, with no `entity` line at all,
    // because the renderer drops an empty scalar. No id is a shorter line than a wrong one.
    if (txn !== undefined && txn.length === 0) {
      return validation('history', '--txn needs the transaction id a write returned, and this line gives it no value', ['treadle help history'])
    }
    if (id === undefined && txn === undefined) {
      return validation('history', 'history needs the id of one record, or --txn with the transaction id a write returned', ['treadle backlog'])
    }
    const cursor = flag(flags, 'cursor')
    return history(store, {
      scope: txn === undefined ? { kind: 'item', id: id as string } : { kind: 'txn', txn },
      limit: positiveInt(flag(flags, 'limit'), DEFAULT_LIMIT),
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
    const given = setFieldsOf(flags, title)
    if ('refusal' in given) return given.refusal
    return fileItem(target, systemClock, randomIds, {
      type: type as WorkItemType, title, ...(chosen === undefined ? {} : { id: chosen }),
      fields: given.fields, actor,
    })
  }

  if (command === 'set') {
    if (id === undefined) return validation('set', 'set needs the id of one item', ['treadle backlog'])
    const assignments = operands.slice(1)
    const twice = repeatedAssignment(assignments)
    if (twice !== undefined) {
      return validation('set', `${twice} is assigned more than once on this line and the last would silently replace the first`, ['treadle help set'])
    }
    return setFields(target, systemClock, randomIds, { id, assignments, actor })
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

  if (command === 'remove') {
    if (id === undefined) return validation('remove', 'remove needs the id of one item', ['treadle backlog'])
    // Every other single-entity command drops an operand past the first, which costs a
    // re-run. Here it would cost a record: `remove a b` removed `a`, exited 0, and left `b`
    // filed, and no line of that answer says the second id was dropped. One id, named.
    // A.6: the ids are the caller's own unvalidated words, so the count reaches the cause
    // and neither of them reaches a fix line.
    if (operands.length > 1) {
      return validation('remove', `remove takes one id and this line names ${operands.length}; a removal is confirmed one record at a time`,
        ['treadle remove <id> --reason "<why>" --yes'])
    }
    const reason = flag(flags, 'reason')
    return removeItem(target, systemClock, randomIds, {
      id, ...(reason === undefined ? {} : { reason }), confirmed: flags['yes'] === true, actor,
    })
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
      // A hold's end is a day like a due date, and `asInstant` is where that rule lives.
      ...(until === undefined ? {} : { until: asInstant(until) }),
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
