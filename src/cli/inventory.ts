// SPDX-License-Identifier: Apache-2.0
// The machine-readable command inventory (R8). It is the single source for help, for the
// agent-facing help, and for the JSON Schema of every command's result, and a test asserts
// that the shipped schemas match what it generates.
//
// The flag matrix below is derived from six attributes per command rather than filled in
// by hand. A cell that the rules cannot decide would be a per-command special case, and the
// test that counts them is what proves there is none.

import { EVIDENCE_KINDS, RELATION_KINDS } from '../domain/index.ts'
import { RENDERINGS } from '../adapters/render/index.ts'
import { MAX_WIDTH, MIN_WIDTH } from '../adapters/render/human.ts'
import { CONTRACT } from '../adapters/render/grammar.ts'
import type { Effect, ResultShape } from '../application/result.ts'
import { BACKLOG_SHAPE, FILE_SHAPE, SHOW_SHAPE } from '../application/services/items.ts'
import { CONFIG_SHAPE } from '../application/services/config.ts'
import { DOCTOR_SHAPE } from '../application/services/doctor.ts'
import { SET_SHAPE } from '../application/services/editing.ts'
import { HISTORY_SHAPE } from '../application/services/history.ts'
import { EXPLAIN_SHAPE, NEXT_SHAPE, STATUS_SHAPE } from '../application/services/insight.ts'
import { EVIDENCE_SHAPE, MARK_SHAPE } from '../application/services/marking.ts'
import { HELP_SHAPE, VERSION_SHAPE } from '../application/services/meta.ts'
import { RELATION_SHAPE } from '../application/services/relation.ts'
import { REMOVE_SHAPE } from '../application/services/removal.ts'
import { TRANSITION_SHAPE } from '../application/services/lifecycle.ts'
import { INIT_SHAPE } from '../application/services/workspace.ts'

/** What a command produces, which decides whether a column selector can mean anything. */
export type RecordShape = 'list' | 'record' | 'none'
export type Confirmation = 'none' | 'moderate' | 'severe'

/**
 * A closed set a caller of this command has to spell exactly and can guess none of. Each is
 * generated from the domain on the page whose caller types the word, and on no other page:
 * which fields a type takes was learned only from a wrong-field refusal, and the edges and
 * the two values they record only from `explain`, one item at a time.
 */
export type Vocabulary =
  /** Which fields each type owns, and which it refuses to be created without. */
  | 'fields'
  /** The edges, the guards on each, and the closed-set value two of them record. */
  | 'lifecycle'
  /** The closed sets a filter value is drawn from. */
  | 'filters'

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
  /** The closed sets this command's own line takes a word from. */
  readonly vocabulary?: readonly Vocabulary[]
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
    usage: ['treadling init [--name <name>] [--yes]'],
    examples: [['treadling init', 'create a workspace in .work here, and say what it created']],
  },
  {
    name: 'file', shape: FILE_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false, vocabulary: ['fields'],
    usage: [
      'treadling file <type> <title> [--id <slug>] [--priority <1-5>] [--assignee <name>]',
      'treadling file <type> <title> [--desc <text>] [--label <name>] [--parent <id>]',
      'treadling file <type> <title> [--set <field>=<value>]',
    ],
    examples: [
      ['treadling file story "Refresh the access token on a 401"', 'file a story in draft'],
      ['treadling file bug "Checkout fails" --set severity=S2 --set found_in=production --set repro_steps="add to cart, pay"', 'a bug needs the three fields its type requires at creation'],
      ['treadling file impediment "Staging certificate expired" --set severity=S1 --set proposed_resolution="platform renews it"', 'an impediment needs a severity and what would clear it; relation add <id> blocks <other> raises it against work'],
    ],
  },
  {
    name: 'show', shape: SHOW_SHAPE, effect: 'read', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false, vocabulary: ['fields'],
    usage: ['treadling show <id> [--field <name>]'],
    examples: [
      ['treadling show auth-refresh --field desc', 'the description whole, rather than cut at 64 cells'],
      ['treadling show auth-refresh --field ac', 'the tick count and every acceptance criterion under it'],
    ],
  },
  {
    name: 'backlog', shape: BACKLOG_SHAPE, effect: 'read', record: 'list',
    omits: true, pageable: true, confirm: 'none', standalone: false,
    columns: true, vocabulary: ['filters'],
    usage: [
      'treadling backlog [--state <s>] [--type <t>] [--assignee <a>] [--resolution <r>]',
      'treadling backlog [--priority <1-5>] [--label <slug>] [--title <words>] [--blocked <yes|no>]',
      'treadling backlog [--fields <list>] [--limit <n>] [--cursor <id>]',
    ],
    examples: [
      ['treadling backlog', 'open work: the list is scoped to what is not done or cancelled, and the filter line says so'],
      ['treadling backlog --state all', 'every state, finished work included; --state done and --state cancelled are the narrower reads'],
      ['treadling backlog --blocked no', 'what nothing is holding up, which is what can be started now'],
      ['treadling backlog --state ready', 'what is ready to pick up'],
      ['treadling backlog --title "token refresh"', 'search titles: every word, case folded, anywhere in the title and in any order; descriptions are not searched'],
      ['treadling backlog --label ux --label ui --state ready --fields +labels', 'every clause has to hold, --label included, so this is ready work carrying both labels, with the whole list as a column'],
      ['treadling backlog --state cancelled --resolution duplicate', 'count what was stopped as a duplicate, without reading any prose'],
      ['treadling backlog --state ready --explain-absence sso-saml', 'why one item you expected is not in the list'],
    ],
  },
  {
    name: 'transition', shape: TRANSITION_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false, vocabulary: ['lifecycle'],
    usage: [
      'treadling transition <id> <target> [--reason <text>] [--until <instant>]',
      'treadling transition <id> cancelled --resolution <r> --reason <text>',
      'treadling transition <id> ready --outcome <failed|yielded> --reason <text>',
      'treadling transition <id> <target> --override <guard> --reason <text>',
    ],
    examples: [
      ['treadling transition sso-saml in_progress', 'start work; refused if a guard on that edge fails'],
      ['treadling transition sso-saml in_review', 'submit for review; a story and a bug have a review step and no other type does'],
      ['treadling transition sso-saml cancelled --resolution rejected --reason "the reviewer refused it outright"', 'stop the item and say which of the five reasons it stopped for'],
      ['treadling transition sso-saml ready --outcome failed --reason "the migration will not apply"', 'give up the attempt and put the item back in the queue, with the failure in the log'],
      ['treadling transition sso-saml in_progress --dry-run', 'the field diff and the exit status the real run would return'],
    ],
  },
  {
    name: 'set', shape: SET_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false, vocabulary: ['fields'],
    usage: ['treadling set <id> <field>=<value> [<field>=<value> ...]'],
    examples: [
      ['treadling set checkout-500 expected="both orders are listed" actual="one is charged"', 'fill in what a bug was filed without, which is what the ready gate reads'],
      ['treadling set checkout-500 fix_confirmed=true reviewer=kim', 'the two fields the done gate reads, in one write'],
      ['treadling set save-cart acceptance_criteria="[x] a shopper reopens a saved cart|[ ] the cart expires after 30 days"', 'rewrite the whole checklist; a leading [x] ticks a criterion, which is how ac 0/2 becomes 1/2'],
      ['treadling set save-cart parent_id= assignee=', 'an empty value clears a field; title and the fields the type requires at creation refuse it'],
    ],
  },
  {
    name: 'mark', shape: MARK_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadling mark <id> [--severity <S1-S4>] [--priority <1-5>] --reason <text>'],
    examples: [
      ['treadling mark checkout-500 --severity S1 --reason "it drops paid orders"', 'raise a defect, with the before and after in the log'],
      ['treadling mark checkout-500 --priority 4 --reason "the workaround holds"', 'lower a priority; the event names who did it'],
    ],
  },
  {
    name: 'evidence', shape: EVIDENCE_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    // Spliced from the closed set for the reason the relation kinds are, one command down:
    // `<kind>` named a set a caller could not see, so the seven words were learned from the
    // refusal for guessing an eighth.
    usage: [`treadling evidence add <id> <${EVIDENCE_KINDS.join('|')}> <ref> [label]`],
    examples: [
      ['treadling evidence add checkout-500 run 8813 "664 pass"', 'point at a run; the essay goes in the artefact, not here'],
      ['treadling evidence add checkout-500 pr https://example.test/pr/42', 'a pointer needs no label'],
    ],
  },
  {
    name: 'relation', shape: RELATION_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    // The kinds are spliced from the closed set rather than spelled here, because this line
    // named three of them for as long as three were writable and would have gone on naming
    // three: help is generated from this inventory, so a stale list here is what a caller reads.
    usage: [
      `treadling relation add <id> <${RELATION_KINDS.join('|')}> <other>`,
      'treadling relation remove <id> <kind> <other>',
    ],
    examples: [
      ['treadling relation add auth-refresh blocks sso-saml', 'sso-saml cannot start until auth-refresh is done; explain shows both sides'],
      ['treadling relation add login-cta-2 duplicates login-cta', 'the first id is the copy; a copy of two things is refused'],
      ['treadling relation add checkout-500 caused_by cart-rewrite', 'this defect came out of that change, which is a fact worth filing with it'],
      ['treadling relation add audit-log relates-to gdpr-export', 'see also, with no rule attached, so blocks stops being used for it'],
    ],
  },
  {
    name: 'remove', shape: REMOVE_SHAPE, effect: 'mutate', record: 'record',
    omits: false, pageable: false, confirm: 'severe', standalone: false,
    columns: false,
    usage: ['treadling remove <id> --reason <text> --yes'],
    examples: [
      ['treadling remove login-cta-2 --reason "filed twice" --dry-run', 'what would go, with every guard evaluated and nothing written; --yes is what the real run needs'],
      ['treadling remove login-cta-2 --reason "filed twice by the same import" --yes', 'take a mis-filed record out of the shard; every event it earned stays in the log and treadling history login-cta-2 still reads them, so work that really stopped is transition <id> cancelled instead, which keeps the record'],
    ],
  },
  {
    // `effect` is `mutate` for both forms because one word covers a read and a write, and a
    // command that can write may not under-declare it (R6). The bare read answers with
    // `changed 0` and no transaction; the interface specification's rule that a command word
    // is always one or the other is departed from here and in ADR-0026, which says why.
    name: 'config', shape: CONFIG_SHAPE, effect: 'mutate', record: 'list',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: [
      'treadling config',
      'treadling config set <key> <value>',
    ],
    examples: [
      ['treadling config', 'every key, the value in force and whether this workspace set it or it is the built-in default'],
      ['treadling config set wip_limits "in_progress=5, in_review=2"', 'arm G3: a sixth start into a column of five is refused, and a limit of zero means unlimited'],
      ['treadling config set ready_gate "DOR1 all field_present:title The item has a title|DOR11 story field_present:reviewer A story names its reviewer"', 'replace the ready gate whole; a rule reading a field the type has not got is refused before the write'],
      ['treadling config set review_step "story"', 'which types pass through in_review, which is what G5 enforces; the default is story, bug'],
    ],
  },
  {
    name: 'doctor', shape: DOCTOR_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadling doctor'],
    examples: [['treadling doctor', 'what the files say that no write path would have accepted']],
    exits: [
      [0, 'every stored record is served; the table is empty, or its rows only report content the next write normalises'],
      [7, 'a record is held and not served, or the audit flagged a served one'],
    ],
  },
  {
    name: 'next', shape: NEXT_SHAPE, effect: 'read', record: 'list',
    omits: true, pageable: true, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadling next [--limit <n>] [--cursor <id>] [--for <actor>]'],
    examples: [['treadling next', 'what to pick up, with the score components and the weights that ranked it']],
  },
  {
    name: 'explain', shape: EXPLAIN_SHAPE, effect: 'read', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadling explain <id>'],
    examples: [['treadling explain sso-saml', 'why it is where it is, which gate rules fail, and what each move needs']],
  },
  {
    name: 'history', shape: HISTORY_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: true, confirm: 'none', standalone: false,
    columns: false,
    usage: [
      'treadling history <id> [--limit <n>] [--cursor <event>]',
      'treadling history --txn <txn> [--limit <n>] [--cursor <event>]',
    ],
    examples: [
      ['treadling history checkout-500', 'who changed this item, what they moved and when'],
      ['treadling history checkout-500 --limit 1', 'the most recent change alone'],
      ['treadling history --txn tj0vksb', 'the other scope: every event one command wrote, whichever records it touched, under the transaction id that command returned; an id and --txn are two questions and the line takes one of them'],
    ],
  },
  {
    name: 'status', shape: STATUS_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: false, confirm: 'none', standalone: false,
    columns: false,
    usage: ['treadling status', 'treadling'],
    examples: [['treadling', 'the bare invocation is status inside a workspace, and help outside one']],
  },
  {
    name: 'help', shape: HELP_SHAPE, effect: 'read', record: 'list',
    omits: false, pageable: false, confirm: 'none', standalone: true,
    columns: false,
    usage: ['treadling help [<command>]'],
    examples: [['treadling help --out agent', 'the command inventory in the line format, for an agent']],
  },
  {
    name: 'version', shape: VERSION_SHAPE, effect: 'read', record: 'record',
    omits: false, pageable: false, confirm: 'none', standalone: true,
    columns: false,
    usage: ['treadling version', 'treadling --version'],
    examples: [['treadling version', 'the tool version, the store schema version and the contract version']],
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
  '--help', '--version', '--contract', '--out', '--quiet', '--verbose', '--log-values',
  '--ascii', '--workspace', '--dry-run', '--yes',
  '--actor', '--width', '--fields', '--limit', '--cursor', '--explain-absence',
] as const
export type GlobalFlag = (typeof GLOBAL_FLAGS)[number]

/**
 * One flag's whole column of the matrix, as the pair that decides every cell of it: the
 * commands it is supported on, and the verdict it earns on the rest. `scope` is that
 * predicate in words and `does` is what the flag does, and both live here rather than in
 * `help.ts` because they are what lets seventeen rows printed once reconstruct all
 * 306 cells: a command page prints its exceptions, and a flag absent from that page is
 * supported there.
 *
 * A flag supported on every command never reaches `otherwise` and carries `S` in it, so the
 * field needs no absent case and the table needs no second shape.
 */
export type FlagSpec = {
  readonly applies: (command: Command) => boolean
  readonly otherwise: Verdict
  /**
   * `applies` as one word, for the column the index prints it in. A cell before the last of a
   * row carries no space by the row grammar, and the phrase below costs the index 770 bytes
   * of "it applies to" where a token costs 240.
   */
  readonly where: string
  /** The same predicate as a phrase, read after "it applies to" by a page refusing the flag. */
  readonly scope: string
  readonly does: string
}

const EVERY_COMMAND = 'every command'
const anywhere = (): boolean => true

export const FLAG_SPECS: Readonly<Record<GlobalFlag, FlagSpec>> = {
  '--help': {
    applies: anywhere, otherwise: 'S', where: 'every', scope: EVERY_COMMAND,
    does: 'prints this page and runs nothing',
  },
  '--version': {
    applies: () => false, otherwise: 'N', where: 'none', scope: 'no command, because it is a program-level flag',
    does: 'prints the tool version; treadling version is the command form',
  },
  // `--contract` replaces the command's output with the line grammar, exactly as `--help`
  // replaces it with the help page, so it is supported wherever `--help` is. It was the
  // worst of the four flags this table did not carry: it is what an agent reads before it
  // can parse anything else, and AGENTS.md, a contributing file, was its only home.
  '--contract': {
    applies: anywhere, otherwise: 'S', where: 'every', scope: EVERY_COMMAND,
    does: `prints the ${CONTRACT} line grammar and the exit table, and runs no command`,
  },
  '--out': {
    applies: (command) => command.record !== 'none', otherwise: 'N',
    where: 'answers-a-record', scope: 'every command that answers with a record or a list',
    does: `selects the rendering, one of ${RENDERINGS.join(', ')}; without it a terminal gets human and a pipe gets agent`,
  },
  '--quiet': {
    applies: anywhere, otherwise: 'S', where: 'every', scope: EVERY_COMMAND,
    does: 'drops the header and the footer and keeps the records; a refusal still prints whole',
  },
  '--verbose': {
    applies: anywhere, otherwise: 'S', where: 'every', scope: EVERY_COMMAND,
    does: '-v, -vv and -vvv put resolution, timings and store operations on stderr; stdout is unchanged',
  },
  // `--log-values` is not presentation. `-vvv` reports every field by name and size, and
  // this is the opt-in that puts the values themselves on stderr, where a CI job and an
  // agent transcript keep them; a caller cannot weigh that disclosure against an unnamed flag.
  '--log-values': {
    applies: anywhere, otherwise: 'S', where: 'every', scope: EVERY_COMMAND,
    does: 'lets -vvv print field values, which it reports by name and size without it',
  },
  // `--ascii` reaches the human rendering's truncation mark and nothing else, so it is
  // supported rather than ignored: the answer is the same, the bytes are not.
  '--ascii': {
    applies: anywhere, otherwise: 'S', where: 'every', scope: EVERY_COMMAND,
    does: 'writes the human rendering truncation mark as three dots, not an ellipsis',
  },
  '--workspace': {
    applies: (command) => !command.standalone, otherwise: 'N',
    where: 'opens-a-workspace', scope: 'every command that opens a workspace',
    does: 'names the store to run against, instead of the search upward from the working directory',
  },
  '--dry-run': {
    applies: (command) => command.effect === 'mutate', otherwise: 'A', where: 'mutation', scope: 'every mutation',
    does: 'evaluates every guard and prints the field diff and the exit status the real run would return, writing nothing',
  },
  '--yes': {
    applies: (command) => command.confirm !== 'none', otherwise: 'A',
    where: 'asks-to-confirm', scope: 'the mutations that ask for a confirmation',
    does: 'answers the confirmation; without it such a command refuses and prints the line that carries it',
  },
  '--actor': {
    applies: (command) => command.effect === 'mutate', otherwise: 'A', where: 'mutation', scope: 'every mutation',
    does: 'names who the event records; TREADLING_ACTOR and TREADLING_ACTOR_KIND=human|agent set it for every command, and a mutation naming nobody is refused',
  },
  // The human rendering lays every line of every command out at this width and refuses to
  // exceed it (interface B.4), so it is supported wherever a command answers at all. It was
  // `A` here while `emit` passed it to the renderer on every call, which told a caller the
  // one knob the rendering has does nothing.
  '--width': {
    applies: anywhere, otherwise: 'S', where: 'every', scope: EVERY_COMMAND,
    does: `lays the human rendering out at that many display cells, clamped to ${MIN_WIDTH} to ${MAX_WIDTH}`,
  },
  '--fields': {
    applies: (command) => command.columns, otherwise: 'X',
    where: 'chooses-columns', scope: 'the commands whose column set the caller chooses',
    does: 'replaces the default columns, or adds to them with a leading plus',
  },
  '--limit': {
    applies: (command) => command.pageable, otherwise: 'X', where: 'pageable', scope: 'every pageable command',
    does: 'bounds one page; the page line the answer ends with carries the cursor for the next',
  },
  // `--cursor` was missing from this table entirely, so `help <command>` never named a flag
  // the tool prints itself in every `page` line, and `treadling version --cursor x` was
  // accepted in silence where `--limit` was refused. It scopes exactly as `--limit` does.
  '--cursor': {
    applies: (command) => command.pageable, otherwise: 'X', where: 'pageable', scope: 'every pageable command',
    does: 'resumes from the page line a previous call printed, with the same filters it was asked with',
  },
  '--explain-absence': {
    applies: (command) => command.omits, otherwise: 'X',
    where: 'may-omit', scope: 'the commands that can omit an entity the caller expected',
    does: 'names one entity and says which clause of the filter excluded it',
  },
}

export function verdictFor(command: Command, flag: GlobalFlag): Verdict {
  const spec = FLAG_SPECS[flag]
  return spec.applies(command) ? 'S' : spec.otherwise
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
