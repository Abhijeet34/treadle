// SPDX-License-Identifier: Apache-2.0
// Two ordinary commands at once, in separate processes, through the published entry point:
// one process runs `set` in a loop and another runs `show` in a loop over one item. On the
// code before ADR-0020 the reader refreshed the index beside the writer, scanned the lines
// the writer had just indexed from the older size, and recorded one false S14 per line; from
// then on every command exited 7 over a store whose files were never wrong. Measured against
// 9888781 with 200 iterations a side, the workspace was locked after the 17th write.
//
// The interleaving is the operating system's, so this is a probabilistic reproduction and
// not a deterministic one; `test/store/event-log-integrity.test.ts` holds each half of the
// fix by construction. What this file adds is the product's own use, N processes on the
// command surface, which is what AGENTS.md says a concurrency claim is proved with.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

import { aDemoWorkspace } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

const execFileAsync = promisify(execFile)
const TREADLE = fileURLToPath(new URL('../../bin/treadle.js', import.meta.url))

/** Iterations a side. The lock landed at write 17 of 200 on the code before the fix. */
const ROUNDS = 60

async function code(cwd: string, argv: readonly string[]): Promise<number> {
  try {
    await execFileAsync(process.execPath, [TREADLE, ...argv], { cwd, encoding: 'utf8' })
    return 0
  } catch (error) {
    return (error as { code?: number }).code ?? -1
  }
}

async function loop(cwd: string, argvFor: (round: number) => readonly string[]): Promise<readonly number[]> {
  const codes: number[] = []
  for (let round = 1; round <= ROUNDS; round += 1) codes.push(await code(cwd, argvFor(round)))
  return codes
}

describe('a reader refreshing the index beside a writer', () => {
  it(`records no finding over ${ROUNDS} sets beside ${ROUNDS} shows, and the store stays served`, async (t) => {
    const demo = await aDemoWorkspace()
    try {
      await demo.store.close()
      const started = Date.now()
      const [sets, shows] = await Promise.all([
        loop(demo.root, (round) => ['set', 'metrics-p95', `description=round ${round}`]),
        loop(demo.root, () => ['show', 'metrics-p95']),
      ])
      t.diagnostic(`${ROUNDS} sets and ${ROUNDS} shows in ${Date.now() - started} ms`)

      assert.deepEqual(sets.filter((c) => c !== 0), [], `a set was refused: exit codes ${sets.join(' ')}`)
      assert.deepEqual(shows.filter((c) => c !== 0), [], `a show was refused: exit codes ${shows.join(' ')}`)

      const doctor = await runCli(['doctor'], { cwd: demo.root })
      assert.equal(doctor.code, 0, doctor.out + doctor.err)
      assert.match(doctor.out, /^clean checked /m)
      const shown = await runCli(['show', 'metrics-p95', '--field', 'desc'], { cwd: demo.root })
      assert.equal(shown.code, 0, shown.out + shown.err)
      assert.match(shown.out, new RegExp(`^"desc round ${ROUNDS}$`, 'm'))
    } finally {
      await demo.dispose()
    }
  })
})
