// SPDX-License-Identifier: Apache-2.0
// What the help surface costs an agent to read, and what it has to carry for that cost to buy
// anything. Both are properties rather than preferences, so both get a test.
//
// Measured on 2026-09-09 against the parent commit: the eighteen command pages summed to
// 35,817 bytes in the agent rendering, 25,611 of them the seventeen-row global flag table
// printed whole on each. 189 of its 306 cells graded a flag `S`, which is what a flag not
// named at all already means, and 18 more were `--version N`, identical on every page. The
// table now prints once on the index and a page prints its own exceptions.
//
// The second half is the other side of that trade: bytes are only worth cutting if what
// remains lets a caller act. Which fields a type takes was learned from a wrong-field
// refusal, and the edges and their closed-set values from `explain`, one item at a time.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EVIDENCE_KINDS, RESOLUTIONS, TRANSITION_TABLE, WORK_ITEM_STATES, WORK_ITEM_TYPES, requiredAtCreation } from '../../src/domain/index.ts'
import { COMMANDS, FLAG_SPECS, GLOBAL_FLAGS, verdictFor } from '../../src/cli/inventory.ts'
import { commandHelp, topLevelHelp } from '../../src/cli/help.ts'
import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { isBlock, type Block, type ResultObject, type Row } from '../../src/application/result.ts'

function blockOf(result: ResultObject, key: string): Block | undefined {
  const value = result.data[key]
  return isBlock(value) ? value : undefined
}

function page(name: string): ResultObject {
  const result = commandHelp(name, '-')
  assert.ok(result !== undefined, `${name} has no help page`)
  return result
}

function notes(result: ResultObject): readonly string[] {
  return (result.data['note'] ?? []) as readonly string[]
}

describe('a command page prints the flags it treats differently, and no others', () => {
  it('prints no row that grades a flag S, because that is what an unprinted flag already means', () => {
    for (const command of COMMANDS) {
      const flags = blockOf(page(command.name), 'flags')
      assert.ok(flags !== undefined, `${command.name} has no flags block`)
      const supported = flags.rows.filter((row) => row['verdict'] === 'S')
      assert.deepEqual(supported, [], `${command.name} still prints ${supported.length} S rows`)
    }
  })

  it('prints no row for a flag that grades the same on every command, which the index states once', () => {
    const constant = GLOBAL_FLAGS.filter(
      (flag) => new Set(COMMANDS.map((command) => verdictFor(command, flag))).size === 1,
    )
    assert.ok(constant.includes('--version'), '--version is N on every command and is the case this rule was found on')
    for (const command of COMMANDS) {
      const flags = blockOf(page(command.name), 'flags')
      for (const flag of constant) {
        assert.equal(
          flags?.rows.some((row) => row['flag'] === flag), false,
          `${command.name} prints ${flag}, whose verdict is the same on all ${COMMANDS.length} pages`,
        )
      }
    }
  })

  it('cuts the matrix printed across the eighteen pages from 306 cells to 99', () => {
    const printed = COMMANDS.reduce((sum, command) => sum + (blockOf(page(command.name), 'flags')?.rows.length ?? 0), 0)
    assert.equal(COMMANDS.length * GLOBAL_FLAGS.length, 306, 'the matrix is no longer 18 by 17; restate the figures')
    assert.equal(printed, 99)
  })

  it('says on each page how many flags it did not name, so a subset never reads as the whole', () => {
    for (const command of COMMANDS) {
      const help = page(command.name)
      const flags = blockOf(help, 'flags')
      assert.ok(flags !== undefined)
      assert.equal(flags.total, GLOBAL_FLAGS.length, `${command.name} does not count its flags against all of them`)
      const unnamed = GLOBAL_FLAGS.length - flags.rows.length
      assert.ok(
        notes(help).some((note) => note.includes(`the other ${unnamed} global flags`)),
        `${command.name} prints ${flags.rows.length} of ${GLOBAL_FLAGS.length} flags and says nothing about the rest`,
      )
    }
  })
})

describe('the index carries the whole matrix, as the rules that decide it', () => {
  const index = topLevelHelp('-')

  it('names every global flag once, with what it does and the commands it applies to', () => {
    const globals = blockOf(index, 'globals')
    assert.ok(globals !== undefined, 'the index has no globals block')
    assert.deepEqual(globals.rows.map((row) => row['flag']), [...GLOBAL_FLAGS])
    for (const row of globals.rows) {
      assert.ok(String(row['note']).length > 0, `${String(row['flag'])} says nothing about what it does`)
      assert.ok(String(row['where']).length > 0, `${String(row['flag'])} says nothing about where it applies`)
    }
  })

  it('gives two flags the same where only when they are supported on the same commands', () => {
    const supported = (flag: typeof GLOBAL_FLAGS[number]): string =>
      COMMANDS.filter((command) => verdictFor(command, flag) === 'S').map((command) => command.name).join(',')
    for (const one of GLOBAL_FLAGS) {
      for (const other of GLOBAL_FLAGS) {
        if (FLAG_SPECS[one].where !== FLAG_SPECS[other].where) continue
        assert.equal(
          supported(one), supported(other),
          `${one} and ${other} both say ${FLAG_SPECS[one].where} and are supported on different commands`,
        )
      }
    }
  })

  it('recovers every cell of the matrix from the index and one page together', () => {
    const index = topLevelHelp('-')
    const named = new Set(blockOf(index, 'globals')?.rows.map((row) => String(row['flag'])))
    for (const command of COMMANDS) {
      const rows = blockOf(page(command.name), 'flags')?.rows ?? []
      for (const flag of GLOBAL_FLAGS) {
        const row = rows.find((entry) => entry['flag'] === flag)
        // A flag the page names carries its verdict there; one it does not is on the index,
        // where `where` says which commands it applies to and the default is that it does.
        const read = row === undefined ? 'S' : String(row['verdict'])
        const actual = verdictFor(command, flag)
        if (row !== undefined) assert.equal(read, actual, `${command.name} ${flag}`)
        else assert.ok(named.has(flag), `${flag} is on no page and not on the index either`)
      }
    }
  })

  it('states what a recorded actor proves, which is that somebody declared it', () => {
    const said = notes(index).join(' ')
    assert.match(said, /declared/, 'the index does not say the actor is declared')
    assert.match(said, /verifies no identity/, 'the index does not say the tool checks no identity')
    assert.match(said, /signed commit/, 'the index does not say what does prove authorship')
  })
})

describe('a page carries the closed sets its own caller has to spell', () => {
  it('gives treadle help file every type and the fields that type is refused without', () => {
    const types = blockOf(page('file'), 'types')
    assert.ok(types !== undefined, 'help file carries no field dictionary')
    assert.deepEqual(types.rows.map((row) => row['type']), [...WORK_ITEM_TYPES])
    for (const type of WORK_ITEM_TYPES) {
      const row: Row | undefined = types.rows.find((entry) => entry['type'] === type)
      const required = requiredAtCreation(type)
      assert.equal(row?.['required'], required.length === 0 ? '-' : required.join(','), `${type}`)
    }
  })

  it('gives treadle help transition every edge, its guards, and the values two of them record', () => {
    const help = page('transition')
    const moves = blockOf(help, 'moves')
    assert.ok(moves !== undefined, 'help transition carries no lifecycle')
    assert.equal(moves.rows.length, TRANSITION_TABLE.length, 'the page prints a different number of edges')
    for (const edge of TRANSITION_TABLE) {
      const row: Row | undefined = moves.rows.find(
        (entry) => entry['move'] === edge.name && entry['from'] === edge.from && entry['to'] === edge.to,
      )
      assert.ok(row !== undefined, `${edge.name} from ${edge.from} to ${edge.to} is not on the page`)
      assert.equal(row['reason'], edge.requiresReason ? 'required' : 'optional', `${edge.name} ${edge.from}`)
    }
    const said = notes(help).join(' ')
    for (const resolution of RESOLUTIONS) assert.ok(said.includes(resolution), `${resolution} is not named`)
    for (const state of WORK_ITEM_STATES) assert.ok(said.includes(state), `${state} is not named`)
  })

  it('gives treadle help backlog the words its own filters take', () => {
    const said = notes(page('backlog')).join(' ')
    for (const state of WORK_ITEM_STATES) assert.ok(said.includes(state), `--state does not name ${state}`)
    for (const type of WORK_ITEM_TYPES) assert.ok(said.includes(type), `--type does not name ${type}`)
    assert.ok(said.includes('open') && said.includes('all'), 'the two scope words are not named')
  })

  it('names the evidence kinds on the page that takes one, rather than in the refusal for guessing', () => {
    const help = page('evidence')
    const said = (help.data['usage'] as readonly string[]).join(' ')
    for (const kind of EVIDENCE_KINDS) assert.ok(said.includes(kind), `evidence does not name ${kind}`)
  })

  it('carries no vocabulary on a page whose caller types none of it', () => {
    for (const name of ['doctor', 'status', 'version', 'help', 'next']) {
      assert.equal(blockOf(page(name), 'types'), undefined, `${name} prints the field dictionary`)
      assert.equal(blockOf(page(name), 'moves'), undefined, `${name} prints the lifecycle`)
    }
  })
})

describe('what the surface costs, in the bytes an agent actually reads', () => {
  const bytes = (result: ResultObject): number => Buffer.byteLength(agentRenderer.render(result), 'utf8')

  it('holds the eighteen pages under the 25,611 bytes their flag tables alone once cost', () => {
    const total = COMMANDS.reduce((sum, command) => sum + bytes(page(command.name)), 0)
    assert.ok(total < 25_611, `the eighteen pages are ${total} bytes`)
  })

  it('keeps the index and all eighteen pages under what the pages alone once cost', () => {
    const total = bytes(topLevelHelp('-')) + COMMANDS.reduce((sum, c) => sum + bytes(page(c.name)), 0)
    assert.ok(total < 35_817, `the index and the eighteen pages are ${total} bytes`)
  })
})
