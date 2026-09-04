// SPDX-License-Identifier: Apache-2.0
// The inventory is the single source for help and the schemas (R8), and its flag matrix is
// derived from the command attributes rather than filled in by hand. A cell the rules cannot
// decide would be a per-command special case, so the count of them is the evidence there is
// none, and help being generated is what stops a page describing a contract that has moved.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SHAPES } from '../../src/application/shapes.ts'
import { COMMANDS, GLOBAL_FLAGS, matrix, verdictFor } from '../../src/cli/inventory.ts'
import { commandHelp, topLevelHelp } from '../../src/cli/help.ts'
import { isBlock, type Row } from '../../src/application/result.ts'

describe('the command inventory', () => {
  it('names a shape that the registry knows, for every command', () => {
    for (const command of COMMANDS) {
      assert.ok(
        SHAPES.includes(command.shape),
        `${command.name} names a shape that shapes.ts does not register`,
      )
    }
  })

  it('has one command per name and no duplicate', () => {
    const names = COMMANDS.map((command) => command.name)
    assert.deepEqual([...new Set(names)].length, names.length)
  })

  it('declares the effect class every command reports in its own output (R6)', () => {
    for (const command of COMMANDS) assert.equal(command.effect, command.shape.effect)
  })
})

describe('the command-by-flag matrix', () => {
  const cells = matrix()

  it('is complete: every command against every global flag, with no gap', () => {
    assert.equal(cells.length, COMMANDS.length * GLOBAL_FLAGS.length)
    assert.equal(cells.filter((cell) => !'SANX'.includes(cell.verdict)).length, 0)
  })

  it('is derived, so no command carries a special case for a flag', () => {
    for (const command of COMMANDS) {
      for (const flag of GLOBAL_FLAGS) {
        const cell = cells.find((entry) => entry.command === command.name && entry.flag === flag)
        assert.equal(cell?.verdict, verdictFor(command, flag))
      }
    }
  })

  it('refuses a flag whose absence would change the answer, and accepts one that only presents', () => {
    const backlog = COMMANDS.find((command) => command.name === 'backlog')
    const show = COMMANDS.find((command) => command.name === 'show')
    assert.equal(verdictFor(show!, '--limit'), 'X', 'a truncated single record is a wrong answer')
    assert.equal(verdictFor(backlog!, '--limit'), 'S')
    assert.equal(verdictFor(show!, '--dry-run'), 'A', 'a read already writes nothing')
    assert.equal(verdictFor(show!, '--width'), 'A')
    assert.equal(verdictFor(show!, '--version'), 'N', '--version is a program-level flag')
  })

  it('distributes over the four verdicts rather than collapsing to one', () => {
    for (const verdict of ['S', 'A', 'N', 'X']) {
      assert.ok(cells.some((cell) => cell.verdict === verdict), `no cell is ${verdict}`)
    }
  })
})

describe('help is generated from the inventory', () => {
  it('lists every command, with the summary its own shape declares', () => {
    const help = topLevelHelp('w')
    const commands = help.data['commands']
    assert.ok(isBlock(commands))
    assert.equal(commands.rows.length, COMMANDS.length)
    for (const command of COMMANDS) {
      const row: Row | undefined = commands.rows.find((entry) => entry['name'] === command.name)
      assert.equal(row?.['summary'], command.shape.summary, `${command.name}'s summary is not its shape's`)
      assert.equal(row?.['effect'], command.effect)
    }
  })

  it('gives one page per command, carrying that command\'s own verdict for every global flag', () => {
    for (const command of COMMANDS) {
      const page = commandHelp(command.name, 'w')
      assert.notEqual(page, undefined, `${command.name} has no help page`)
      const flags = page?.data['flags']
      assert.ok(isBlock(flags))
      assert.equal(flags.rows.length, GLOBAL_FLAGS.length)
      for (const flag of GLOBAL_FLAGS) {
        const row: Row | undefined = flags.rows.find((entry) => entry['flag'] === flag)
        assert.equal(row?.['verdict'], verdictFor(command, flag), `${command.name} ${flag}`)
      }
    }
  })

  it('has no page for a command the inventory does not carry', () => {
    assert.equal(commandHelp('ceremony', 'w'), undefined)
  })
})
