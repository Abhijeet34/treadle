// SPDX-License-Identifier: Apache-2.0
// Help, generated from the command inventory rather than written beside it (R8). The
// top-level page and every command page read the same table the schemas are generated from,
// so a command whose contract changes cannot keep a help page that describes the old one.

import { columnsOf, okResult, type Block, type ResultObject, type Row } from '../application/result.ts'
import { HELP_SHAPE } from '../application/services/meta.ts'
import { COMMANDS, GLOBAL_FLAGS, commandNamed, verdictFor, type Command } from './inventory.ts'

const VERDICT_NOTE: Readonly<Record<string, string>> = {
  S: 'supported: it changes what this command does or shows',
  A: 'accepted and ignored: it only changes presentation, and here there is nothing to present',
  N: 'another scope: passing it here is a validation error naming the correct form',
  X: 'refused: ignoring it would answer a question the caller did not ask',
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
      commands,
      example: COMMANDS.flatMap(examplesOf).slice(0, 6),
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
      return { flag, verdict, note: VERDICT_NOTE[verdict] ?? '' }
    }),
  }
  return okResult(HELP_SHAPE, {
    workspace,
    data: {
      topic: command.name,
      effect: command.effect,
      usage: command.usage,
      about: command.shape.summary,
      flags,
      example: examplesOf(command),
    },
  })
}
