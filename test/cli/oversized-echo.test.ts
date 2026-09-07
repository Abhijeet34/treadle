// SPDX-License-Identifier: Apache-2.0
// No command echoes an oversized argument back, in any position, on any path.
//
// Found by attacking the fix for the runtime crash: once a megabyte-long argument stopped
// killing the process, the refusals it reached printed it. `treadle show <1,000,000 y>`
// returned a one megabyte `entity` line, `treadle backlog --assignee <the same>` exited 0
// with two megabytes of stdout across its `filter` and `narrowest` lines, and `treadle help
// <the same>` returned the argument as its cause. The result object's own rule already says
// this of `fix` ("built only from bounded values... no user-supplied free text is ever
// spliced into one"); every other property was outside it.
//
// The sweep is over the inventory rather than over a list written here, so a command added
// later is covered the day it is added, and so is a flag added to one that exists. Each of a
// command's own example lines is run once per token with that token replaced, which reaches
// the operands and the flag values a reader would actually type.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { COMMANDS, GLOBAL_FLAGS } from '../../src/cli/inventory.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

/** One argument far past every bound the field dictionary states, of one repeated character. */
const HUGE = 'y'.repeat(100_000)

/**
 * The longest run of that character any output may carry. `MAX_CAUSE` is 500, so a bounded
 * cause that is nothing but the argument's prefix is inside this and an unbounded echo is not.
 */
const RUN = /y{600}/

/** An example line as argv, honouring the double quotes the examples are written with. */
function tokens(line: string): readonly string[] {
  const out: string[] = []
  const found = line.match(/"[^"]*"|\S+/g) ?? []
  for (const piece of found) out.push(piece.startsWith('"') ? piece.slice(1, -1) : piece)
  return out.slice(1)
}

/** The positions of an example that carry a value rather than a command word or a flag name. */
function valuePositions(argv: readonly string[], command: string): readonly number[] {
  const out: number[] = []
  for (const [at, token] of argv.entries()) {
    if (token.startsWith('--')) continue
    if (at === 0 && token === command) continue
    out.push(at)
  }
  return out
}

describe('no command returns an oversized argument to the caller', () => {
  let demo: Demo
  let mutated = 0

  after(async () => { await demo?.dispose() })
  before(async () => { demo = await aDemoWorkspace() })

  for (const command of COMMANDS) {
    it(`${command.name} keeps every example bounded with an oversized token`, async () => {
      let ran = 0
      for (const [line] of command.examples) {
        const argv = tokens(line)
        for (const at of valuePositions(argv, command.name)) {
          const mutated = argv.map((token, index) => (index === at ? HUGE : token))
          const run = await runCli(mutated, { cwd: demo.root, env: { TREADLE_ACTOR: 'dana' } })
          ran += 1
          assert.equal(
            RUN.test(`${run.out}${run.err}`), false,
            `${command.name}: ${mutated.slice(0, at).join(' ')} <100,000 characters> `
              + `returned the argument (${run.out.length + run.err.length} bytes, exit ${run.code})`,
          )
        }
      }
      // `status`, `doctor`, `next`, `version` and `init` are whole commands with no value in
      // any example, so there is nothing to mutate and nothing to assert about them here.
      mutated += ran
    })
  }

  it('mutated a real number of example lines, so the sweep above is not vacuous', () => {
    assert.ok(mutated >= 20, `the sweep ran ${mutated} mutated example lines`)
  })

  it('keeps every global flag that takes a value bounded', async () => {
    // `--out` and the boolean flags take no free text; the rest carry whatever was typed.
    const carriers = GLOBAL_FLAGS.filter((flag) =>
      ['--workspace', '--actor', '--cursor', '--fields', '--limit', '--width', '--explain-absence'].includes(flag))
    assert.ok(carriers.length >= 7, 'the list of value-carrying global flags no longer matches the inventory')
    for (const flag of carriers) {
      const run = await runCli(['backlog', flag, HUGE], { cwd: demo.root, env: { TREADLE_ACTOR: 'dana' } })
      assert.equal(
        RUN.test(`${run.out}${run.err}`), false,
        `backlog ${flag} <100,000 characters> returned the argument (${run.out.length + run.err.length} bytes)`,
      )
    }
  })

  it('keeps an oversized id bounded on the commands that take one', async () => {
    for (const argv of [
      ['show', HUGE], ['history', HUGE], ['explain', HUGE], ['set', HUGE, 'points=3'],
      ['mark', HUGE, '--priority', '1', '--reason', 'why'],
      ['transition', HUGE, 'ready'], ['relation', 'add', HUGE, 'blocks', 'sso-saml'],
      ['evidence', 'add', HUGE, 'run', '1'], ['sprint', 'commit', HUGE, 'sso-saml'],
      ['file', 'task', 'A title', '--id', HUGE],
    ]) {
      const run = await runCli(argv, { cwd: demo.root, env: { TREADLE_ACTOR: 'dana' } })
      assert.equal(
        RUN.test(`${run.out}${run.err}`), false,
        `${argv[0] as string} returned the oversized id (${run.out.length + run.err.length} bytes)`,
      )
    }
  })
})
