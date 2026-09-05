// SPDX-License-Identifier: Apache-2.0
// The machine-readable command inventory (R8). It is the single source for help, for the
// agent-facing help, and for the JSON Schema of every command's result, and a test asserts
// that the shipped schemas match what it generates.
//
// The flag matrix below is derived from five attributes per command rather than filled in
// by hand. A cell that the rules cannot decide would be a per-command special case, and the
// test that counts them is what proves there is none.

import type { Effect, ResultShape } from '../application/result.ts'
import { BACKLOG_SHAPE, FILE_SHAPE, SHOW_SHAPE } from '../application/services/items.ts'
import { DOCTOR_SHAPE } from '../application/services/doctor.ts'
import { SET_SHAPE } from '../application/services/editing.ts'
import { HISTORY_SHAPE } from '../application/services/history.ts'
import { EXPLAIN_SHAPE, NEXT_SHAPE, STATUS_SHAPE } from '../application/services/insight.ts'
import { EVIDENCE_SHAPE, MARK_SHAPE } from '../application/services/marking.ts'
import { HELP_SHAPE, VERSION_SHAPE } from '../application/services/meta.ts'
import { TRANSITION_SHAPE } from '../application/services/lifecycle.ts'
import { INIT_SHAPE } from '../application/services/workspace.ts'

/** What a command produces, which decides whether a column selector can mean anything. */
export type RecordShape = 'list' | 'record' | 'none'
export type Confirmation = 'none' | 'moderate' | 'severe'

export type Command = {
  readonly name: string
  readonly shape: ResultShape
  readonly effect: Effect
  readonly record: RecordShape
  /** Can omit an entity the caller expected, so `--explain-absence` has a clause to name. */
  readonly omits: boolean
  /** A query result, so a partial answer is a short one rather than a wrong one. */
  readonly pageable: boolean
  readonly confirm: Confirmation
  /** True when the command needs no workspace, which decides `--workspace`. */
  readonly standalone: boolean
  /** True when the caller may choose this command's column set, which decides `--fields`. */
  readonly columns: boolean
  readonly usage: readonly string[]
  readonly examples: readonly (readonly [string, string])[]
  /**
   * Exit statuses that carry a verdict rather than a failure, each with its meaning. Every
   * command exits by the one table in `exit.ts`; only a command whose answer is itself a
   * verdict has anything to add here.
   */
  readonly exits?: readonly (readonly [number, string])[]
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'init', shape: INIT_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'moderate', standalone: false,
    columns: false,
    usage: ['treadle init [--name <name>] [--yes]'],
    examples: [['treadle init', 'create a workspace in .work here, and say what it created']],
  },
  {
    name: 'file', shape: FILE_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle file <type> <title> [--points <n>] [--priority <1-5>] [--set <field>=<value>]'],
    examples: [
      ['treadle file story "Refresh the access token on a 401"', 'file a story in draft'],
      ['treadle file bug "Checkout fails" --set severity=S2 --set found_in=production --set repro_steps="add to cart, pay"', 'a bug needs the three fields its type requires at creation'],
    ],
  },
  {
    name: 'show', shape: SHOW_SHAPE, effect: 'read', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle show <id> [--field <name>]'],
    examples: [
      ['treadle show auth-refresh --field desc', 'the description whole, rather than cut at 64 cells'],
      ['treadle show auth-refresh --field ac', 'the tick count and every acceptance criterion under it'],
    ],
  },
  {
    name: 'backlog', shape: BACKLOG_SHAPE, effect: 'read', record: 'list',
    omits: true, pageable: true, confirm: 'none', standalone: false,
    columns: true,
    usage: ['treadle backlog [--state <s>] [--type <t>] [--assignee <a>] [--resolution <r>] [--fields <list>] [--limit <n>] [--cursor <id>]'],
    examples: [
      ['treadle backlog --state ready', 'what is ready to pick up'],
      ['treadle backlog --state cancelled --resolution duplicate', 'count what was stopped as a duplicate, without reading any prose'],
      ['treadle backlog --state ready --explain-absence sso-saml', 'why one item you expected is not in the list'],
    ],
  },
  {
    name: 'transition', shape: TRANSITION_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: [
      'treadle transition <id> <target> [--reason <text>] [--until <instant>]',
      'treadle transition <id> cancelled --resolution <r> --reason <text>',
      'treadle transition <id> ready --outcome <failed|yielded> --reason <text>',
      'treadle transition <id> <target> --override <guard> --reason <text>',
    ],
    examples: [
      ['treadle transition sso-saml in_progress', 'start work; refused if a guard on that edge fails'],
      ['treadle transition sso-saml cancelled --resolution rejected --reason "the reviewer refused it outright"', 'stop the item and say which of the five reasons it stopped for'],
      ['treadle transition sso-saml ready --outcome failed --reason "the migration will not apply"', 'give up the attempt and put the item back in the queue, with the failure in the log'],
      ['treadle transition sso-saml in_progress --dry-run', 'the field diff and the exit status the real run would return'],
      ['treadle transition sso-saml in_progress --preview', 'which store and which guards, evaluating none of them'],
    ],
  },
  {
    name: 'set', shape: SET_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle set <id> <field>=<value> [<field>=<value> ...]'],
    examples: [
      ['treadle set checkout-500 expected="both orders are listed" actual="one is charged"', 'fill in what a bug was filed without, which is what the ready gate reads'],
      ['treadle set checkout-500 fix_confirmed=true reviewer=kim', 'the two fields the done gate reads, in one write'],
      ['treadle set save-cart acceptance_criteria="[x] a shopper reopens a saved cart|[ ] the cart expires after 30 days"', 'rewrite the whole checklist; a leading [x] ticks a criterion, which is how ac 0/2 becomes 1/2'],
    ],
  },
  {
    name: 'mark', shape: MARK_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle mark <id> [--severity <S1-S4>] [--priority <1-5>] --reason <text>'],
    examples: [
      ['treadle mark checkout-500 --severity S1 --reason "it drops paid orders"', 'raise a defect, with the before and after in the log'],
      ['treadle mark checkout-500 --priority 4 --reason "the workaround holds"', 'lower a priority; the event names who did it'],
    ],
  },
  {
    name: 'evidence', shape: EVIDENCE_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle evidence add <id> <kind> <ref> [label]'],
    examples: [
      ['treadle evidence add checkout-500 run 8813 "664 pass"', 'point at a run; the essay goes in the artefact, not here'],
      ['treadle evidence add checkout-500 pr https://example.test/pr/42', 'a pointer needs no label'],
    ],
  },
  {
    name: 'doctor', shape: DOCTOR_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle doctor'],
    examples: [['treadle doctor', 'what the files say that no write path would have accepted']],
    exits: [
      [0, 'clean: every stored record is served and the audit flagged nothing'],
      [7, 'the findings table is not empty; a record is held and not served, or the audit flagged one'],
    ],
  },
  {
    name: 'next', shape: NEXT_SHAPE, effect: 'read', record: 'list',
    omits: true, pageable: true, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle next [--limit <n>] [--cursor <id>] [--for <actor>]'],
    examples: [['treadle next', 'what to pick up, with the score components and the weights that ranked it']],
  },
  {
    name: 'explain', shape: EXPLAIN_SHAPE, effect: 'read', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle explain <id>'],
    examples: [['treadle explain sso-saml', 'why it is where it is, which gate rules fail, and what each move needs']],
  },
  {
    name: 'history', shape: HISTORY_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: true, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle history <id> [--limit <n>] [--cursor <event>]'],
    examples: [
      ['treadle history checkout-500', 'who changed this item, what they moved and when'],
      ['treadle history checkout-500 --limit 1', 'the most recent change alone'],
    ],
  },
  {
    name: 'status', shape: STATUS_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadle status', 'treadle'],
    examples: [['treadle', 'the bare invocation is status inside a workspace, and help outside one']],
  },
  {
    name: 'help', shape: HELP_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: false, confirm: 'none', standalone: true,
    columns: false,
    usage: ['treadle help [<command>]'],
    examples: [['treadle help --out agent', 'the command inventory in the line format, for an agent']],
  },
  {
    name: 'version', shape: VERSION_SHAPE, effect: 'read', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: true,
    columns: false,
    usage: ['treadle version', 'treadle --version'],
    examples: [['treadle version', 'the tool version, the store schema version and the contract version']],
  },
]

export function commandNamed(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name)
}

/**
 * S supported, A accepted with no effect, N belongs to another scope, X refused.
 * The rule that decides A from X, once: a flag that only changes presentation is accepted
 * and ignored where it cannot apply; a flag whose absence would change the answer is
 * refused where it cannot apply.
 */
export type Verdict = 'S' | 'A' | 'N' | 'X'

export const GLOBAL_FLAGS = [
  '--help', '--version', '--out', '--quiet', '--verbose', '--color', '--workspace',
  '--dry-run', '--preview', '--yes', '--no-input', '--actor', '--width', '--fields',
  '--limit', '--cursor', '--explain-absence',
] as const
export type GlobalFlag = (typeof GLOBAL_FLAGS)[number]

export function verdictFor(command: Command, flag: GlobalFlag): Verdict {
  switch (flag) {
    case '--help': return 'S'
    case '--version': return 'N'
    case '--out': return command.record === 'none' ? 'N' : 'S'
    case '--quiet': return 'S'
    case '--verbose': return 'S'
    case '--color': return 'A'
    case '--width': return 'A'
    // Only a command that can prompt has anything to suppress. `init` is the one with a
    // confirmation class today; interface B.5's severe class lands with `undo`.
    case '--no-input': return command.confirm === 'none' ? 'A' : 'S'
    case '--workspace': return command.standalone ? 'N' : 'S'
    case '--dry-run': return command.effect === 'mutate' ? 'S' : 'A'
    case '--preview': return command.effect === 'mutate' ? 'S' : 'A'
    case '--yes': return command.confirm === 'none' ? 'A' : 'S'
    case '--actor': return command.effect === 'mutate' ? 'S' : 'A'
    case '--fields': return command.columns ? 'S' : 'X'
    case '--limit': return command.pageable ? 'S' : 'X'
    // `--cursor` was missing from this table entirely, so `help <command>` never named a flag
    // the tool prints itself in every `page` line, and `treadle version --cursor x` was
    // accepted in silence where `--limit` was refused. It scopes exactly as `--limit` does.
    case '--cursor': return command.pageable ? 'S' : 'X'
    case '--explain-absence': return command.omits ? 'S' : 'X'
  }
}

export type MatrixCell = {
  readonly command: string
  readonly flag: GlobalFlag
  readonly verdict: Verdict
}

export function matrix(): readonly MatrixCell[] {
  return COMMANDS.flatMap((command) =>
    GLOBAL_FLAGS.map((flag) => ({ command: command.name, flag, verdict: verdictFor(command, flag) })))
}
