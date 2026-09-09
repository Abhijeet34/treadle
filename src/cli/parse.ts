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

import { findUnsafeCharacter } from '../domain/index.ts'
import { GLOBAL_FLAGS, commandNamed, verdictFor, type GlobalFlag } from './inventory.ts'

type OptionConfig = NonNullable<ParseArgsConfig['options']>

/**
 * The flags every command takes. Exported so a test can hold the rule that `help <command>`
 * names every one of them: `--contract`, `--ascii` and `--log-values` were accepted by this
 * table and printed by no help page, and `--contract` is the grammar an agent needs before
 * it can parse anything else.
 */
export const GLOBAL_OPTIONS: OptionConfig = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  contract: { type: 'boolean' },
  out: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
  ascii: { type: 'boolean' },
  workspace: { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
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
    priority: { type: 'string' },
    assignee: { type: 'string' },
    desc: { type: 'string' },
    parent: { type: 'string' },
    label: { type: 'string', multiple: true },
    set: { type: 'string', multiple: true },
  },
  show: { field: { type: 'string' } },
  backlog: {
    state: { type: 'string' },
    type: { type: 'string' },
    assignee: { type: 'string' },
    priority: { type: 'string' },
    resolution: { type: 'string' },
    // Repeatable, and every one has to hold. `file --label` already repeats, so a caller who
    // learned it there would otherwise write `backlog --label a --label b` and silently get
    // `b` alone; and an item carries a list, so "carrying both" is the question to ask of it.
    label: { type: 'string', multiple: true },
    title: { type: 'string' },
    // A value rather than a bare switch, so it is the equality clause every filter beside it
    // is: the page line prints `--blocked yes` and the line runs as printed, and
    // `--explain-absence` names it with a `got` like any other. A bare `--blocked` would need
    // one special case where the clause is built and a second where the page line is written.
    // `--blocked no` is the other half of the question, which is what can be started now.
    blocked: { type: 'string' },
  },
  transition: {
    reason: { type: 'string' },
    until: { type: 'string' },
    resolution: { type: 'string' },
    outcome: { type: 'string' },
    override: { type: 'string', multiple: true },
  },
  set: {},
  config: {},
  mark: {
    severity: { type: 'string' },
    priority: { type: 'string' },
    reason: { type: 'string' },
  },
  evidence: {},
  relation: {},
  remove: { reason: { type: 'string' } },
  doctor: {},
  next: { for: { type: 'string' } },
  explain: {},
  history: { txn: { type: 'string' } },
  status: {},
  help: {},
  version: {},
}

/**
 * Filter flags, in the order they were written, so a tie names the first one (A.4). `label`
 * and `title` are appended rather than placed, because this order is what a line that names
 * no flag falls back to and moving an existing entry would change which clause an existing
 * caller's `narrowest` and `--explain-absence` lines name. `blocked` is appended on that rule.
 */
export const FILTER_FLAGS = ['state', 'type', 'assignee', 'priority', 'resolution', 'label', 'title', 'blocked'] as const
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
  /**
   * The whole argv entry this token came from. A short cluster explodes one entry into one
   * `FlagToken` per letter, so `raw` alone would name `-1` for the entry `-100` - a token the
   * caller never wrote. A refusal that names the argv token names this instead.
   */
  readonly source: string
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
      out.push({ raw: `--${name}`, name, inline: token.includes('='), next, source: token })
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
        source: token,
      })
    }
  }
  return out
}

/** A token no option table could carry a name for, because a short flag is never a digit. */
const NEGATIVE_NUMBER = /^-[0-9]/

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
      // A negative number is never a flag of anything: no short letter is a digit. `config
      // set aging_days -1` was refused as `-1 is not a flag of config`, which is a true
      // sentence about the wrong thing - the caller wrote a value, and the sentence sent
      // them to a flag list that could not hold one. `--` is what carries it through, and
      // the value is then refused by the key's own rule, which is the answer they asked for.
      if (NEGATIVE_NUMBER.test(token.source)) {
        // Naming the whole argv entry is what makes this refusal true, and an argv entry is
        // the caller's own bytes: `-1<CR>evil` reached the agent rendering's delimiter
        // invariant and came back `err INTERNAL` at exit 1 with no rule id. So the entry is
        // echoed only when it is a single safe line, and otherwise the character is named by
        // code point and no byte of it reaches the stream, which is what `operandRefusal`
        // does for the same class one file over.
        const found = findUnsafeCharacter(token.source, 'line')
        return {
          ok: false,
          cause: found === undefined
            ? `${token.source} was read as a flag of ${scope}, and an operand beginning with a dash is written after --`
            : `an operand of ${scope} beginning with a dash carries ${found.label} at character ${found.at + 1}, and no value of a record holds one; a value beginning with a dash is written after --`,
          fix,
        }
      }
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

/**
 * A single-valued flag written more than once, as a refusal (G1).
 *
 * `parseArgs` keeps the last value and drops the rest without a word, so `backlog --state
 * draft --state ready` answered about `ready` alone and no line of that answer said `draft`
 * had been read and thrown away. It is the same fault as an id the renderer could not carry:
 * the line says two things, the tool can represent one, and it picks in silence. A repeat is
 * refused rather than and-ed or or-ed, because what a caller meant by two states is not
 * knowable from the line and a wrong guess is worse than a question.
 *
 * A repeatable flag is exempt by its own option table entry: `--label`, `--set`, `--override`
 * and `-v` each mean something as a repeat, and that is declared where the flag is declared
 * rather than listed again here. A boolean is exempt too, because writing `--yes --yes`
 * discards no value: this refuses a dropped argument, not a redundant token.
 */
function repeatRefusal(
  argv: readonly string[], options: OptionConfig, command: string | undefined,
): ParseFailure | undefined {
  const seen = new Set<string>()
  for (const token of flagTokens(argv, options)) {
    const config = options[token.name] as { type?: string; multiple?: boolean } | undefined
    if (config === undefined || config.type !== 'string' || config.multiple === true) continue
    if (seen.has(token.name)) {
      return {
        ok: false,
        cause: `${token.raw} takes one value and this line writes it more than once; the last would silently replace the first`,
        fix: [command === undefined ? 'treadle help' : `treadle help ${command}`],
      }
    }
    seen.add(token.name)
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

/** The global flags `emit` in main.ts reads to render a result, and nothing else. */
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
    const fault = flagFault(argv, GLOBAL_OPTIONS, undefined) ?? repeatRefusal(argv, GLOBAL_OPTIONS, undefined)
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

  const repeated = repeatRefusal(argv, { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[command] ?? {}) }, command)
  if (repeated !== undefined) return repeated

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
