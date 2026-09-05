// SPDX-License-Identifier: Apache-2.0
// Argument parsing on `node:util`'s parseArgs, and nothing else (DR7).
//
// Two passes, because the command word decides which flags are legal. The first pass knows
// only the global options, so a global flag's value is never mistaken for the command word;
// the second is strict over the global set plus that command's own, so an unknown flag is a
// named refusal rather than a silently ignored token.

import { parseArgs, type ParseArgsConfig } from 'node:util'

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

const COMMAND_OPTIONS: Readonly<Record<string, OptionConfig>> = {
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
  transition: {
    reason: { type: 'string' },
    until: { type: 'string' },
    resolution: { type: 'string' },
    outcome: { type: 'string' },
    override: { type: 'string', multiple: true },
  },
  mark: {
    severity: { type: 'string' },
    priority: { type: 'string' },
    reason: { type: 'string' },
  },
  evidence: {},
  doctor: {},
  next: { for: { type: 'string' } },
  explain: {},
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

export function parse(argv: readonly string[]): ParseSuccess | ParseFailure {
  let first
  try {
    first = parseArgs({ args: [...argv], options: GLOBAL_OPTIONS, allowPositionals: true, strict: false })
  } catch (error) {
    return { ok: false, cause: (error as Error).message, fix: ['treadle help'] }
  }
  const command = first.positionals[0]
  if (command === undefined) {
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
  } catch (error) {
    return { ok: false, cause: (error as Error).message, fix: [`treadle help ${command}`] }
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
    return {
      ok: false,
      cause: '--dry-run and --preview ask different questions: preview resolves the target and evaluates nothing, dry run evaluates every guard',
      fix: [`treadle ${command} --preview`, `treadle ${command} --dry-run`],
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
