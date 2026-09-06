// SPDX-License-Identifier: Apache-2.0
// Argument parsing on `node:util`'s parseArgs, and nothing else (DR7).
//
// Two passes, because the command word decides which flags are legal. The first pass knows
// only the global options, so a global flag's value is never mistaken for the command word;
// the second is strict over the global set plus that command's own, so an unknown flag is a
// named refusal rather than a silently ignored token.
//
// `parseArgs` throws prose of its own, and none of it is ever emitted. Its text explains a
// `--` convention this tool does not document, it arrives with an unbalanced quote because
// it quotes the offending token, and one of its three messages is three lines long, which a
// one-line `cause` renders as a counted block. Every throw is therefore re-derived here from
// the same option table `help <command>` prints, so a refusal about a flag reads like every
// other refusal the tool writes.

import { parseArgs, type ParseArgsConfig } from 'node:util'

import { shellWord } from '../domain/index.ts'
import { GLOBAL_FLAGS, commandNamed, verdictFor, type GlobalFlag } from './inventory.ts'

type OptionConfig = NonNullable<ParseArgsConfig['options']>

const GLOBAL_OPTIONS: OptionConfig = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  contract: { type: 'boolean' },
  out: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
  color: { type: 'string' },
  'no-color': { type: 'boolean' },
  ascii: { type: 'boolean' },
  workspace: { type: 'string' },
  'dry-run': { type: 'boolean' },
  preview: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'no-input': { type: 'boolean' },
  actor: { type: 'string' },
  width: { type: 'string' },
  fields: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  'explain-absence': { type: 'string' },
  'log-values': { type: 'boolean' },
}

/**
 * The flags each command takes beyond the global set. Exported so a test can hold the rule
 * that `help <command>` names every one of them: six of `file`'s and two of `backlog`'s were
 * accepted by this table and absent from every help page, so a caller found them by being
 * refused rather than by asking.
 */
export const COMMAND_OPTIONS: Readonly<Record<string, OptionConfig>> = {
  init: { name: { type: 'string' } },
  file: {
    id: { type: 'string' },
    points: { type: 'string' },
    priority: { type: 'string' },
    assignee: { type: 'string' },
    desc: { type: 'string' },
    sprint: { type: 'string' },
    parent: { type: 'string' },
    label: { type: 'string', multiple: true },
    set: { type: 'string', multiple: true },
  },
  show: { field: { type: 'string' } },
  backlog: {
    state: { type: 'string' },
    type: { type: 'string' },
    sprint: { type: 'string' },
    assignee: { type: 'string' },
    priority: { type: 'string' },
    resolution: { type: 'string' },
  },
  board: {
    state: { type: 'string' },
    type: { type: 'string' },
    sprint: { type: 'string' },
    assignee: { type: 'string' },
    priority: { type: 'string' },
    resolution: { type: 'string' },
    all: { type: 'boolean' },
  },
  transition: {
    reason: { type: 'string' },
    until: { type: 'string' },
    resolution: { type: 'string' },
    outcome: { type: 'string' },
    override: { type: 'string', multiple: true },
  },
  set: {},
  mark: {
    severity: { type: 'string' },
    priority: { type: 'string' },
    reason: { type: 'string' },
  },
  evidence: {},
  relation: {},
  sprint: {
    id: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    goal: { type: 'string' },
  },
  sprints: {},
  doctor: {},
  next: { for: { type: 'string' } },
  explain: {},
  history: {},
  status: {},
  help: {},
  version: {},
}

/** Filter flags, in the order they were written, so a tie names the first one (A.4). */
export const FILTER_FLAGS = ['state', 'type', 'sprint', 'assignee', 'priority', 'resolution'] as const
export type FilterFlag = (typeof FILTER_FLAGS)[number]

export type Parsed = {
  readonly command: string | undefined
  readonly operands: readonly string[]
  readonly flags: Readonly<Record<string, unknown>>
  /** Filter flags in command-line order, which decides which clause is named first. */
  readonly filterOrder: readonly FilterFlag[]
  readonly passed: ReadonlySet<string>
}

export type ParseFailure = { readonly ok: false; readonly cause: string; readonly fix: readonly string[] }
export type ParseSuccess = { readonly ok: true; readonly value: Parsed }

function passedFlags(argv: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>()
  for (const token of argv) {
    if (token === '--') break
    if (token.startsWith('--')) seen.add(token.slice(2).split('=')[0] as string)
    else if (token.startsWith('-') && token.length > 1) for (const letter of token.slice(1)) seen.add(letter)
  }
  return seen
}

function filterOrderOf(argv: readonly string[]): readonly FilterFlag[] {
  const out: FilterFlag[] = []
  for (const token of argv) {
    if (token === '--') break
    if (!token.startsWith('--')) continue
    const name = token.slice(2).split('=')[0] as string
    if ((FILTER_FLAGS as readonly string[]).includes(name) && !out.includes(name as FilterFlag)) {
      out.push(name as FilterFlag)
    }
  }
  return out
}

/** A flag as written, resolved to the option name parseArgs would look up. */
type FlagToken = {
  /** The token as the caller wrote it, which is what a refusal names. */
  readonly raw: string
  readonly name: string
  /** Written `--name=value`, so the value travels in the token itself. */
  readonly inline: boolean
  /** The next argv entry, which is where a non-inline value would have to come from. */
  readonly next: string | undefined
}

/** Every flag on the line, in order, with a short letter resolved through the option table. */
function flagTokens(argv: readonly string[], options: OptionConfig): readonly FlagToken[] {
  const shorts = new Map<string, string>()
  for (const [name, config] of Object.entries(options)) {
    const short = (config as { short?: string }).short
    if (short !== undefined) shorts.set(short, name)
  }
  const out: FlagToken[] = []
  for (const [index, token] of argv.entries()) {
    if (token === '--') break
    const next = argv[index + 1]
    if (token.startsWith('--') && token.length > 2) {
      const name = token.slice(2).split('=')[0] as string
      out.push({ raw: `--${name}`, name, inline: token.includes('='), next })
      continue
    }
    if (!token.startsWith('-') || token.length < 2) continue
    // A cluster is one flag per letter and only its last letter can carry a value, so that
    // is the only letter an inline value or a following token belongs to.
    const body = token.slice(1)
    const equals = body.indexOf('=')
    const letters = [...(equals < 0 ? body : body.slice(0, equals))]
    for (const [at, letter] of letters.entries()) {
      const last = at === letters.length - 1
      out.push({
        raw: `-${letter}`,
        name: shorts.get(letter) ?? letter,
        inline: equals >= 0 && last,
        next: last ? next : undefined,
      })
    }
  }
  return out
}

/**
 * The first flag on the line the option table refuses, and why, in the tool's own words.
 * `undefined` means the line is well formed against that table.
 *
 * The three shapes are the three `parseArgs` throws: a name the table does not carry, a
 * value on a flag that takes none, and a flag whose value is missing or would be read as the
 * next flag. Each is found from the table rather than from the thrown message, which is what
 * keeps the message out of the output.
 */
function flagFault(
  argv: readonly string[], options: OptionConfig, command: string | undefined,
): ParseFailure | undefined {
  const scope = command ?? 'treadle'
  const fix = [command === undefined ? 'treadle help' : `treadle help ${command}`]
  for (const token of flagTokens(argv, options)) {
    const config = options[token.name] as { type?: string } | undefined
    if (config === undefined) {
      return { ok: false, cause: `${token.raw} is not a flag of ${scope}`, fix }
    }
    if (config.type === 'boolean' && token.inline) {
      return { ok: false, cause: `${token.raw} takes no value`, fix }
    }
    if (config.type !== 'string' || token.inline) continue
    if (token.next === undefined) {
      return { ok: false, cause: `${token.raw} needs a value`, fix }
    }
    if (token.next.startsWith('-') && token.next.length > 1) {
      return {
        ok: false,
        cause: `${token.raw} needs a value, and one starting with a dash is written ${token.raw}=${token.next}`,
        fix,
      }
    }
  }
  return undefined
}

/** A `parseArgs` throw as a refusal of this tool's own, never as the message it threw. */
function flagRefusal(
  argv: readonly string[], options: OptionConfig, command: string | undefined,
): ParseFailure {
  const scope = command ?? 'treadle'
  return flagFault(argv, options, command) ?? {
    ok: false,
    cause: `${scope} cannot read the flags on this line`,
    fix: [command === undefined ? 'treadle help' : `treadle help ${command}`],
  }
}

/**
 * The global flags `emit` in main.ts reads to render a result, and nothing else. `--color`
 * and `--no-color` are parsed and read by no renderer, so naming them here would promise a
 * refusal something no other path delivers either.
 */
const PRESENTATION = ['out', 'width', 'quiet', 'ascii'] as const

/**
 * The presentation flags on a line the parser refused, read leniently so the refusal is
 * still rendered the way the caller asked. Three parse-level refusals under `--out json`
 * came back in the default rendering, because the refusal was raised before any flag was
 * read; a caller parsing stderr as JSON then had no object at all.
 */
export function presentationFlags(argv: readonly string[]): Readonly<Record<string, unknown>> {
  let values: Record<string, unknown>
  try {
    values = parseArgs({ args: [...argv], options: GLOBAL_OPTIONS, allowPositionals: true, strict: false }).values
  } catch {
    return {}
  }
  const kept: Record<string, unknown> = {}
  for (const name of PRESENTATION) if (values[name] !== undefined) kept[name] = values[name]
  return kept
}

export function parse(argv: readonly string[]): ParseSuccess | ParseFailure {
  let first
  try {
    first = parseArgs({ args: [...argv], options: GLOBAL_OPTIONS, allowPositionals: true, strict: false })
  } catch {
    return flagRefusal(argv, GLOBAL_OPTIONS, undefined)
  }
  const command = first.positionals[0]
  if (command === undefined) {
    // The first pass is not strict, so it accepts an unknown flag rather than throwing, and
    // with no command word there is no second pass to catch it. Without this the invariant
    // at the top of the file held for every line but the shortest one: `treadle --nope` ran
    // the default command and said nothing about the flag it dropped.
    const fault = flagFault(argv, GLOBAL_OPTIONS, undefined)
    if (fault !== undefined) return fault
    return {
      ok: true,
      value: {
        command: undefined, operands: [], flags: first.values as Record<string, unknown>,
        filterOrder: [], passed: passedFlags(argv),
      },
    }
  }
  const known = commandNamed(command)
  if (known === undefined) {
    return {
      ok: false,
      cause: `${command} is not a treadle command`,
      fix: ['treadle help'],
    }
  }

  let second
  try {
    second = parseArgs({
      args: [...argv],
      options: { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[command] ?? {}) },
      allowPositionals: true,
      strict: true,
    })
  } catch {
    return flagRefusal(argv, { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[command] ?? {}) }, command)
  }

  const passed = passedFlags(argv)
  const refused = GLOBAL_FLAGS.find((flag: GlobalFlag) => {
    const name = flag.slice(2)
    if (!passed.has(name)) return false
    const verdict = verdictFor(known, flag)
    return verdict === 'X' || verdict === 'N'
  })
  if (refused !== undefined) {
    const verdict = verdictFor(known, refused)
    return {
      ok: false,
      cause: verdict === 'N'
        ? `${refused} belongs to another scope and ${command} does not take it`
        : `${refused} cannot apply to ${command}, and ignoring it would answer a question you did not ask`,
      fix: [`treadle help ${command}`],
    }
  }

  if (passed.has('dry-run') && passed.has('preview')) {
    // The caller's own line with one of the two flags taken off, operands and all: a fix that
    // named the command word alone was refused for having no id and no target.
    const without = (flag: string): string => `treadle ${argv.filter((token) => token !== flag).map(shellWord).join(' ')}`
    return {
      ok: false,
      cause: '--dry-run and --preview ask different questions: preview resolves the target and evaluates nothing, dry run evaluates every guard',
      fix: [without('--dry-run'), without('--preview')],
    }
  }

  return {
    ok: true,
    value: {
      command,
      operands: second.positionals.slice(1),
      flags: second.values as Record<string, unknown>,
      filterOrder: filterOrderOf(argv),
      passed,
    },
  }
}
