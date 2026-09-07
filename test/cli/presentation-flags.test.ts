// SPDX-License-Identifier: Apache-2.0
// The two presentation flags, against what the tool actually does with them.
//
// Measured on 2026-09-07: `treadle help <cmd>` said of `--width` and `--color`, on nine
// commands that all present something, "accepted and ignored: it only changes presentation,
// and here there is nothing to present". Half of that verdict was wrong in each direction.
// `--width` is read by the human rendering on every command, so it is supported and a caller
// who believed the note would never pass it; `--color` is read by no rendering at all, so it
// is ignored for a reason the note does not give.
//
// The rule this file holds is the inventory's own: a letter is a verdict and a note is its
// reason, and a reason that is true of the letter in general but false of this flag is worse
// than a terse one, because a caller reads it as the rule.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { COMMANDS, GLOBAL_FLAGS, verdictFor } from '../../src/cli/inventory.ts'
import { commandHelp } from '../../src/cli/help.ts'
import { MAX_WIDTH, MIN_WIDTH, humanRenderer } from '../../src/adapters/render/human.ts'
import { displayWidth } from '../../src/adapters/render/width.ts'
import { topLevelHelp } from '../../src/cli/help.ts'
import { isBlock, type Block } from '../../src/application/result.ts'
import { EXIT_OF } from '../../src/cli/exit.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

let demo: Demo
let demoRoot: string
before(async () => { demo = await aDemoWorkspace(); demoRoot = demo.root })
after(async () => { await demo.dispose() })

/** The `flags` block of one command's help page, as flag to note. */
function notesOf(command: string): ReadonlyMap<string, { readonly verdict: string; readonly note: string }> {
  const page = commandHelp(command, '-')
  assert.ok(page !== undefined, `${command} has no help page`)
  const flags = page.data['flags']
  assert.ok(isBlock(flags), `${command}'s help page carries no flags block`)
  return new Map((flags as Block).rows.map((row) => [
    String(row['flag']), { verdict: String(row['verdict']), note: String(row['note']) },
  ]))
}

describe('--width is supported, because every rendering of every command is laid out at it', () => {
  for (const command of COMMANDS) {
    it(`${command.name} declares --width supported`, () => {
      assert.equal(
        verdictFor(command, '--width'), 'S',
        `${command.name} calls --width accepted and ignored, and the human rendering lays its answer out at that width`,
      )
    })
  }

  it('lays the human rendering out at the width the caller declared', () => {
    for (const width of [MIN_WIDTH, 64, 100, MAX_WIDTH]) {
      const text = humanRenderer.render(topLevelHelp('-'), { width })
      for (const line of text.split('\n')) {
        assert.ok(
          displayWidth(line) <= width,
          `at --width ${width} a line is ${displayWidth(line)} cells: ${line}`,
        )
      }
    }
    const narrow = humanRenderer.render(topLevelHelp('-'), { width: MIN_WIDTH })
    const wide = humanRenderer.render(topLevelHelp('-'), { width: MAX_WIDTH })
    assert.notEqual(narrow, wide, '--width changes no byte of the human rendering')
  })

  it('says what --width does, rather than that it does nothing', () => {
    const note = notesOf('show').get('--width')
    assert.equal(note?.verdict, 'S')
    assert.ok(
      !note.note.includes('nothing to present'),
      `show's help says of --width: ${note.note}`,
    )
  })
})

// Found by attacking the change above: promoting `--width` to supported made its silent
// fallback a lie. `Number.parseInt` salvages a prefix, so `--width 1_0` and `--width 1e9`
// both laid the page out at 40 cells and `--width NaN` used the default 80, each without a
// word. `--limit` reads its value through the same shape and had the same fault.
describe('a flag that takes a count refuses a value that is not one', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['--width', '0'], ['--width', 'abc'], ['--width', '1e9'], ['--width', '1_0'],
    ['--width', 'NaN'], ['--width', 'Infinity'],
    // Written inline, because a value opening with a dash is refused one layer earlier as a
    // flag with no value, which is its own correct refusal and names this spelling.
    ['--width=-0', ''], ['--width=-5', ''],
    ['--limit', '0'], ['--limit', 'abc'], ['--limit', '1e9'],
  ]
  for (const [flag, value] of cases) {
    it(`refuses ${flag} ${value} rather than guessing`, async () => {
      const argv = value === '' ? ['backlog', flag] : ['backlog', flag, value]
      const run = await runCli(argv, { cwd: demoRoot })
      assert.equal(run.code, EXIT_OF.VALIDATION, `${flag} ${value} was accepted:\n${run.out}${run.err}`)
      const named = flag.split('=')[0] as string
      assert.match(run.err, new RegExp(`\\${named} takes a whole number`))
      assert.ok(
        run.err.includes(value === '' ? (flag.split('=')[1] as string) : value),
        `the refusal does not name the value it refused:\n${run.err}`,
      )
    })
  }

  it('accepts a whole number, and clamps a width outside the rendering range', async () => {
    for (const value of ['1', '40', '60', '200', '5000']) {
      const run = await runCli(['backlog', '--width', value], { cwd: demoRoot })
      assert.equal(run.code, 0, `--width ${value} was refused:\n${run.err}`)
    }
  })
})

describe('--color is ignored for the reason it is ignored', () => {
  it('gives a reason that is about colour and not about this command', () => {
    const note = notesOf('backlog').get('--color')
    assert.equal(note?.verdict, 'A')
    assert.ok(
      !note.note.includes('nothing to present'),
      `backlog presents a table, and its help says of --color: ${note.note}`,
    )
    assert.match(note.note, /colour/, `the note for --color does not mention colour: ${note.note}`)
  })
})

describe('no ignored flag inherits a reason that is not its own', () => {
  it('gives every accepted-and-ignored cell a note written for that flag', () => {
    const generic = notesOf('status').get('--help')
    assert.ok(generic !== undefined)
    for (const command of COMMANDS) {
      const notes = notesOf(command.name)
      for (const flag of GLOBAL_FLAGS) {
        const cell = notes.get(flag)
        if (cell?.verdict !== 'A') continue
        assert.ok(
          cell.note.length > 0 && !cell.note.includes('nothing to present'),
          `${command.name} ${flag} is ignored with the general note: ${cell.note}`,
        )
      }
    }
  })
})
