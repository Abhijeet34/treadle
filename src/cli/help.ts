// SPDX-License-Identifier: Apache-2.0
// Help, generated from the command inventory rather than written beside it (R8). The
// top-level page and every command page read the same table the schemas are generated from,
// so a command whose contract changes cannot keep a help page that describes the old one.

import { RENDERINGS } from '../adapters/render/index.ts'
import { CONTRACT } from '../adapters/render/grammar.ts'
import { columnsOf, okResult, type Block, type ResultObject, type Row } from '../application/result.ts'
import { HELP_SHAPE } from '../application/services/meta.ts'
import { COMMANDS, GLOBAL_FLAGS, commandNamed, verdictFor, type Command } from './inventory.ts'

const VERDICT_NOTE: Readonly<Record<string, string>> = {
  S: 'supported: it changes what this command does or shows',
  A: 'accepted and ignored: it only changes presentation, and here there is nothing to present',
  N: 'another scope: passing it here is a validation error naming the correct form',
  X: 'refused: ignoring it would answer a question the caller did not ask',
}

/**
 * The note a flag earns when its verdict letter is true for a reason the general note does not
 * give. `A` is one letter for four different reasons, and the general note is true of only one
 * of them: `--yes` is ignored here because the command asks nothing, not because it is about
 * presentation. A note that says the wrong reason is worse than a terse one, because a caller
 * reads it as the rule and then predicts the next command wrong. Three `S` flags need the same
 * treatment for the opposite reason: what they support is not this command's answer, and a
 * caller who has never seen the flag learns nothing from "it changes what this command shows".
 *
 * Keyed by flag and verdict together, because a flag that is `A` on one command is `S` on
 * another and only the `A` reading needs the specific sentence.
 */
const SPECIFIC_NOTE: Readonly<Record<string, string>> = {
  '--yes A': 'accepted and ignored: this command has no confirmation to answer',
  '--no-input A': 'accepted and ignored: this command has no confirmation to suppress',
  '--dry-run A': 'accepted and ignored: this command writes nothing, so there is nothing to withhold',
  '--preview A': 'accepted and ignored: this command writes nothing, so there is nothing to preview',
  '--actor A': 'accepted and ignored: this command records no event, so no actor is attributed',
  '--contract S': `supported: it prints the ${CONTRACT} line grammar and runs no command`,
  '--out S': `supported: it selects the rendering, one of ${RENDERINGS.join(', ')}`,
  '--ascii S': 'supported: it writes the human rendering truncation mark as three dots, not an ellipsis',
  '--log-values S': 'supported: it lets -vvv print field values, reported by name and size without it',
}

function noteFor(flag: string, verdict: string): string {
  return SPECIFIC_NOTE[`${flag} ${verdict}`] ?? VERDICT_NOTE[verdict] ?? ''
}

function commandRows(): readonly Row[] {
  return COMMANDS.map((command): Row => ({
    name: command.name,
    effect: command.effect,
    pageable: command.pageable ? 'yes' : 'no',
    summary: command.shape.summary,
  }))
}

function examplesOf(command: Command): readonly string[] {
  return command.examples.map(([run, why]) => `${run} # ${why}`)
}

export function topLevelHelp(workspace: string): ResultObject {
  const commands: Block = {
    columns: columnsOf(HELP_SHAPE, 'commands'),
    shown: COMMANDS.length,
    total: COMMANDS.length,
    rows: commandRows(),
  }
  return okResult(HELP_SHAPE, {
    workspace,
    data: {
      topic: 'treadle',
      usage: [
        'treadle',
        'treadle <command> [args]',
        'treadle help <command>',
      ],
      about: 'Agile work management for a team and its agents, over files you commit to git.',
      // The first example of each command rather than the first six of the whole table: the
      // flat form never reached past `backlog`, so the page toured three of fifteen commands
      // and adding an example to one of them pushed another command's off the page entirely.
      example: COMMANDS.map((command) => examplesOf(command)[0])
        .filter((example): example is string => example !== undefined)
        .slice(0, 6),
      commands,
    },
  })
}

export function commandHelp(name: string, workspace: string): ResultObject | undefined {
  const command = commandNamed(name)
  if (command === undefined) return undefined
  const flags: Block = {
    columns: columnsOf(HELP_SHAPE, 'flags'),
    shown: GLOBAL_FLAGS.length,
    total: GLOBAL_FLAGS.length,
    rows: GLOBAL_FLAGS.map((flag): Row => {
      const verdict = verdictFor(command, flag)
      return { flag, verdict, note: noteFor(flag, verdict) }
    }),
  }
  return okResult(HELP_SHAPE, {
    workspace,
    data: {
      topic: command.name,
      effect: command.effect,
      usage: command.usage,
      about: command.shape.summary,
      example: examplesOf(command),
      ...(command.exits === undefined ? {} : { exit: command.exits.map(([status, meaning]) => `${status} ${meaning}`) }),
      flags,
    },
  })
}
