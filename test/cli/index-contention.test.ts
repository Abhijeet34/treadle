// SPDX-License-Identifier: Apache-2.0
// Opening the derived index under contention, driven through the published entry point in
// separate processes.
//
// The suite that already exists for DR4 spawns real processes, but they drive the store API
// and they all write one record, so the advisory lock serialises them and only one of them
// is ever inside the index. Nothing exercised what a command does when another process holds
// the index while this one is still opening it, and that is where the defect lived: a
// `pragma journal_mode = wal` issued before `pragma busy_timeout` has nothing to wait with,
// so it raises SQLITE_BUSY on the first contended open, the exception escapes the command
// boundary as a Node stack trace, and the write is lost. Both halves are asserted here: the
// contended open now waits, and an exception that does reach the boundary still leaves an
// error object rather than a trace (R2).

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

import { EXIT_OF } from '../../src/cli/exit.ts'
import { aDemoWorkspace } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

const execFileAsync = promisify(execFile)
const HOLDER = fileURLToPath(new URL('../store/fixtures/index-holder.ts', import.meta.url))
const TREADLE = fileURLToPath(new URL('../../bin/treadle.js', import.meta.url))

/** Long enough that the command under test certainly meets the lock, well under the 5 s wait. */
const HOLD_MS = 1_500

type Ran = { readonly code: number; readonly out: string; readonly err: string }

async function treadle(cwd: string, argv: readonly string[]): Promise<Ran> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TREADLE, ...argv], { cwd, encoding: 'utf8' })
    return { code: 0, out: stdout, err: stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, out: failure.stdout ?? '', err: failure.stderr ?? '' }
  }
}

describe('a command whose index is held by another process', () => {
  it('waits for the lock rather than crashing, and its write lands', async () => {
    const demo = await aDemoWorkspace()
    try {
      await demo.store.close()
      await rm(path.join(demo.root, '.index'), { recursive: true, force: true })

      const holder = spawn(
        process.execPath,
        [HOLDER, path.join(demo.root, '.index', 'index.sqlite'), String(HOLD_MS)],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
      await new Promise<void>((resolve) => { holder.stdout.once('data', () => { resolve() }) })
      // Subscribed before the command runs, because a holder that has already exited by the
      // time a listener is attached never emits `exit` again and the wait would never end.
      const released = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })

      const moved = await treadle(demo.root, ['transition', 'metrics-p95', 'ready'])
      await released

      assert.doesNotMatch(moved.err, /^\s+at /m, `a stack trace reached stderr:\n${moved.err}`)
      assert.equal(moved.code, 0, `exit ${moved.code}, stderr:\n${moved.err}`)
      assert.match(moved.out, /^ok transition /)

      const shown = await treadle(demo.root, ['show', 'metrics-p95'])
      assert.match(shown.out, /^state ready$/m, 'the write the command reported was not applied')
    } finally {
      await demo.dispose()
    }
  })
})

describe('an exception that reaches the command boundary', () => {
  it('still leaves an error object on stderr and nothing on stdout (R2)', async () => {
    const demo = await aDemoWorkspace()
    try {
      await demo.store.close()
      // A regular file where the index directory belongs. `mkdirSync` raises EEXIST from
      // inside the store, which is an ordinary way for a hostile or hand-edited repository
      // to reach the one path R2 says must still produce the error object.
      await rm(path.join(demo.root, '.index'), { recursive: true, force: true })
      await writeFile(path.join(demo.root, '.index'), 'not a directory\n')

      const ran = await runCli(['status'], { cwd: demo.root })
      assert.equal(ran.out, '')
      assert.equal(ran.code, EXIT_OF.INTERNAL)
      assert.match(ran.err, /^err INTERNAL /)
      assert.doesNotMatch(ran.err, /^\s+at /m, `a stack trace reached stderr:\n${ran.err}`)
      assert.match(ran.err, /EEXIST/, 'the refusal must name what actually went wrong')
    } finally {
      await demo.dispose()
    }
  })

  it('reports the effect class the command declared, so a caller knows what may have run', async () => {
    const demo = await aDemoWorkspace()
    try {
      await demo.store.close()
      await rm(path.join(demo.root, '.index'), { recursive: true, force: true })
      await writeFile(path.join(demo.root, '.index'), 'not a directory\n')

      const ran = await runCli(['transition', 'metrics-p95', 'ready', '--out', 'json'], { cwd: demo.root })
      const result = JSON.parse(ran.err) as { effect: string; code: string; command: string }
      assert.equal(result.code, 'INTERNAL')
      assert.equal(result.command, 'transition')
      assert.equal(result.effect, 'mutate')
    } finally {
      await demo.dispose()
    }
  })
})
