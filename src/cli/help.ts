// SPDX-License-Identifier: Apache-2.0
// Help, generated from the command inventory rather than written beside it (R8). The
// top-level page and every command page read the same table the schemas are generated from,
// so a command whose contract changes cannot keep a help page that describes the old one.
//
// What each page costs is part of what it says. The seventeen-row global flag table used to
// print whole on all eighteen command pages, and on the mean page 189 of its 306 cells said
// only that the flag behaves as it does everywhere. That table now prints once, on the index,
// with what each flag does and where it applies; a command page prints the flags it treats
// differently, and a flag absent from a page is supported there. The two surfaces together
// still name every cell.

import {
  ATTEMPT_OUTCOMES,
  RESOLUTIONS,
  TRANSITION_TABLE,
  OVERRIDABLE_GUARDS,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  fieldsOf,
  requiredAtCreation,
  type WorkItemState,
} from '../domain/index.ts'
import { columnsOf, okResult, type Block, type ResultObject, type Row } from '../application/result.ts'
import { HELP_SHAPE } from '../application/services/meta.ts'
import {
  COMMANDS, FLAG_SPECS, GLOBAL_FLAGS, commandNamed, verdictFor,
  type Command, type GlobalFlag, type Vocabulary,
} from './inventory.ts'

/**
 * The letter alone, because what each letter means as a rule is the same on all eighteen
 * pages and is stated once on the index. What is left is the clause that is not: where the
 * flag does apply, which is the only thing a caller refused one here still needs.
 */
const VERDICT_NOTE: Readonly<Record<string, string>> = {
  A: 'accepted and ignored',
  N: 'another scope',
  X: 'refused',
}

/**
 * The note a flag earns when its verdict letter is true for a reason the general note does not
 * give. `A` is one letter for several different reasons, and the general note is true of only
 * one of them: `--yes` is ignored here because the command asks nothing, not because it is
 * about presentation. A note that says the wrong reason is worse than a terse one, because a
 * caller reads it as the rule and then predicts the next command wrong.
 *
 * Keyed by flag and verdict together, because a flag that is `A` on one command is `S` on
 * another and only the `A` reading needs the specific sentence. Everything a flag does when
 * it is supported now lives in `FLAG_SPECS`, printed once on the index rather than eighteen
 * times here.
 */
const SPECIFIC_NOTE: Readonly<Record<string, string>> = {
  '--yes A': 'accepted and ignored: this command has no confirmation to answer',
  '--dry-run A': 'accepted and ignored: this command writes nothing, so there is nothing to withhold',
  '--actor A': 'accepted and ignored: this command records no event, so no actor is attributed',
  '--workspace N': 'another scope: this command opens no workspace, so there is none to name',
}

/**
 * The sentence a recorded actor does not say for itself, and the one the tool cannot let a
 * reader infer. A mutation naming nobody is refused, which makes the name on an event look
 * checked; nothing checks it. It is stated on the index because that is the page every
 * caller meets, and `src/application/services/doctor.ts` argues it beside the audit that
 * notices a record disagreeing with the log that recorded it.
 */
const ATTRIBUTION = 'the actor on an event is declared by whoever ran the command and recorded as given: treadle verifies no identity, and the signed commit carrying the file is what proves who wrote it'

const VERDICT_RULE = 'a command page grades a flag S supported, A accepted and ignored, N another scope, X refused; the rule that decides A from X is that a flag which only presents is ignored where it cannot apply, and one whose absence would change the answer is refused there'

const FLAG_RULE = `a command page names only the flags it grades other than S, and only those whose grade varies by command; a flag absent from a page behaves there as the where column below says; all ${GLOBAL_FLAGS.length} are here`

/** Counted, because a page that prints a subset has to say how big the subset is not. */
function pageRule(shown: number): string {
  return `the other ${GLOBAL_FLAGS.length - shown} global flags apply here as treadle help describes them`
}

function noteFor(flag: GlobalFlag, verdict: string): string {
  const specific = SPECIFIC_NOTE[`${flag} ${verdict}`]
  if (specific !== undefined) return specific
  return `${VERDICT_NOTE[verdict] ?? ''}; it applies to ${FLAG_SPECS[flag].scope}`
}

/**
 * True when a flag's verdict depends on which command it is passed to. A flag that grades the
 * same everywhere carries nothing a page can say that the index has not: `--version` is `N` on
 * all eighteen, and printing that row on each of them was 1,584 bytes saying one fact.
 *
 * Derived from the matrix rather than declared, so a flag that stops varying stops printing.
 */
function varies(flag: GlobalFlag): boolean {
  return new Set(COMMANDS.map((command) => verdictFor(command, flag))).size > 1
}

function commandRows(): readonly Row[] {
  return COMMANDS.map((command): Row => ({
    name: command.name,
    effect: command.effect,
    pageable: command.pageable ? 'yes' : 'no',
    summary: command.shape.summary,
  }))
}

/** The whole matrix, as the seventeen rules that decide all of its cells. */
function globalRows(): readonly Row[] {
  return GLOBAL_FLAGS.map((flag): Row => ({
    flag,
    where: FLAG_SPECS[flag].where,
    note: FLAG_SPECS[flag].does,
  }))
}

/**
 * The field dictionary, per type. A cell before the last carries no space by the row grammar,
 * so a list of field names is comma-joined rather than written as prose.
 */
function typeRows(): readonly Row[] {
  return WORK_ITEM_TYPES.map((type): Row => {
    const required = requiredAtCreation(type)
    const own = fieldsOf(type).filter((field) => !COMMON_FIELDS.includes(field))
    return {
      type,
      required: required.length === 0 ? '-' : required.join(','),
      fields: own.length === 0 ? '-' : own.join(','),
    }
  })
}

/** Common to every type, so it is named once rather than repeated down the `fields` column. */
const COMMON_FIELDS: readonly string[] = fieldsOf('task')

/**
 * One row per edge, ordered by the state a caller is standing in, because that is the one
 * fact they have when they read this: they name a target, not a move.
 *
 * Folding the four `hold` edges into one row was shorter and unreadable: `from` then held
 * five comma-joined states, and every row of the table wrapped onto two lines in the human
 * rendering at 100 cells. Twenty-three narrow rows cost 285 bytes more and lay out flat.
 */
function moveRows(): readonly Row[] {
  const order = (state: string): number => WORK_ITEM_STATES.indexOf(state as WorkItemState)
  return [...TRANSITION_TABLE]
    .sort((one, other) => order(one.from) - order(other.from) || order(one.to) - order(other.to))
    .map((edge): Row => ({
      from: edge.from,
      to: edge.to,
      move: edge.name,
      guards: edge.guards.length === 0 ? '-' : edge.guards.join(','),
      reason: edge.requiresReason ? 'required' : 'optional',
    }))
}

/**
 * The closed sets a page's own caller types a word from, generated from the domain so a set
 * that gains a member cannot leave a page naming the old one.
 */
const VOCABULARY_NOTE: Readonly<Record<Vocabulary, () => readonly string[]>> = {
  // The clearing rule is not here: `set`'s own last example carries it, and a note that
  // repeats an example on the same page is the duplication this file exists to remove.
  fields: () => [`every type also carries ${COMMON_FIELDS.join(', ')}`],
  lifecycle: () => [
    `the target is a state, not the move name: ${WORK_ITEM_STATES.join(', ')}`,
    `cancelled takes --resolution, one of ${RESOLUTIONS.join(', ')}; ready from in_progress takes --outcome, one of ${ATTEMPT_OUTCOMES.join(', ')}`,
    `--override takes ${OVERRIDABLE_GUARDS.join(', ')} and a reason; every other guard is fixed by fixing the item`,
  ],
  filters: () => [
    `--state takes ${WORK_ITEM_STATES.join(', ')}, or open for the default scope, or all`,
    `--type takes ${WORK_ITEM_TYPES.join(', ')}; --resolution takes ${RESOLUTIONS.join(', ')}`,
  ],
}

function examplesOf(command: Command): readonly string[] {
  return command.examples.map(([run, why]) => `${run} # ${why}`)
}

function block(key: string, rows: readonly Row[], total = rows.length): Block {
  return { columns: columnsOf(HELP_SHAPE, key), shown: rows.length, total, rows }
}

export function topLevelHelp(workspace: string): ResultObject {
  return okResult(HELP_SHAPE, {
    workspace,
    data: {
      topic: 'treadle',
      usage: [
        'treadle',
        'treadle <command> [args]',
        'treadle help <command>',
      ],
      // The README's own first line, and package.json's description. It read "Agile work
      // management" while README.md:9 says "It is not a Rally and not a Kanban board" and
      // ADR-0029 removed the surface that phrase named, so the first sentence the tool said
      // about itself was the one the repository spends a paragraph denying.
      about: 'The record of the work between people and agents, over files you commit to git.',
      note: [ATTRIBUTION, FLAG_RULE, VERDICT_RULE],
      // The first example of each command rather than the first six of the whole table: the
      // flat form never reached past `backlog`, so the page toured three of fifteen commands
      // and adding an example to one of them pushed another command's off the page entirely.
      example: COMMANDS.map((command) => examplesOf(command)[0])
        .filter((example): example is string => example !== undefined)
        .slice(0, 6),
      commands: block('commands', commandRows()),
      globals: block('globals', globalRows()),
    },
  })
}

export function commandHelp(name: string, workspace: string): ResultObject | undefined {
  const command = commandNamed(name)
  if (command === undefined) return undefined
  const vocabulary = command.vocabulary ?? []
  const exceptions = GLOBAL_FLAGS
    .map((flag): Row => {
      const verdict = verdictFor(command, flag)
      return { flag, verdict, note: noteFor(flag, verdict) }
    })
    .filter((row) => row.verdict !== 'S' && varies(row.flag))
  return okResult(HELP_SHAPE, {
    workspace,
    data: {
      topic: command.name,
      effect: command.effect,
      usage: command.usage,
      about: command.shape.summary,
      note: [...vocabulary.flatMap((topic) => VOCABULARY_NOTE[topic]()), pageRule(exceptions.length)],
      example: examplesOf(command),
      ...(command.exits === undefined ? {} : { exit: command.exits.map(([status, meaning]) => `${status} ${meaning}`) }),
      ...(vocabulary.includes('fields') ? { types: block('types', typeRows()) } : {}),
      ...(vocabulary.includes('lifecycle') ? { moves: block('moves', moveRows()) } : {}),
      flags: block('flags', exceptions, GLOBAL_FLAGS.length),
    },
  })
}
