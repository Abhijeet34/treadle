// SPDX-License-Identifier: Apache-2.0
// Axis A5 of the prior-art comparison, at the command boundary: a filesystem that refuses is
// not a crash, and every refusal leaves as the result object DR5 promises.
//
// Both cases below were reproduced against the real binary before this file existed. `init`
// where `.work` is already a file, and `file` into a shard directory with its write bit off,
// each printed a raw Node stack trace to stderr and exited 1: no envelope, no rule id, no
// exit from the table, and absolute internal paths in the trace, which is finding F10's
// class arriving on a path nobody had walked. The store now returns `S13` for an errno it
// cannot write through, and `run` carries a backstop for anything that still escapes.

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { EXIT_OF } from '../../src/cli/exit.ts'
import { runCli } from '../helpers/cli-run.ts'

/** A stack trace on stderr is the shape being refused, in either of the two ways it prints. */
function assertNoTrace(stream: string): void {
  assert.equal(/^\s+at /m.test(stream), false, `a stack frame reached stderr: ${stream}`)
  assert.equal(stream.includes('node:internal'), false, `an internal path reached stderr: ${stream}`)
}

/** The envelope, the rule and the exit are one contract, so they are asserted together. */
function assertRefusal(run: { code: number; out: string; err: string }, rule: string): void {
  assert.equal(run.code, EXIT_OF.STORE_UNAVAILABLE, `exited ${run.code} rather than the table's status`)
  assert.match(run.err, /^err STORE_UNAVAILABLE /, 'stderr does not open with the envelope')
  assert.match(run.err, new RegExp(`\\nrule ${rule}\\n`), `the refusal does not name ${rule}`)
  assert.match(run.err, /\n"cause /, 'the refusal carries no cause')
  assert.equal(run.out, '', 'a refusal wrote to stdout')
  assertNoTrace(run.err)
}

describe('a filesystem that refuses is a refusal, not a stack trace', () => {
  it('init into a path already occupied by a file', async () => {
    const at = await mkdtemp(path.join(tmpdir(), 'treadle-occupied-'))
    try {
      await writeFile(path.join(at, '.work'), 'not a directory\n')
      const run = await runCli(['init', '--name', 'acme'], { cwd: at })
      assertRefusal(run, 'S13')
      assert.match(run.err, /ENOTDIR/, 'the refusal does not name what the filesystem said')
    } finally {
      await rm(at, { recursive: true, force: true })
    }
  })

  it('file into a shard directory whose write bit is off', async () => {
    const at = await mkdtemp(path.join(tmpdir(), 'treadle-readonly-'))
    const items = path.join(at, '.work', 'items')
    try {
      const created = await runCli(['init', '--name', 'readonly'], { cwd: at })
      assert.equal(created.code, 0, created.err)
      await chmod(items, 0o500)

      const run = await runCli(['file', 'task', 'A task the filesystem refuses'], { cwd: at })
      assertRefusal(run, 'S13')
      assert.match(run.err, /EACCES/, 'the refusal does not name what the filesystem said')
      assert.match(run.err, /^err STORE_UNAVAILABLE readonly$/m, 'the envelope does not name the workspace')
    } finally {
      await chmod(items, 0o700).catch(() => undefined)
      await rm(at, { recursive: true, force: true })
    }
  })

  it('leaves the store readable after the refusal', async () => {
    const at = await mkdtemp(path.join(tmpdir(), 'treadle-after-'))
    const items = path.join(at, '.work', 'items')
    try {
      await runCli(['init', '--name', 'after'], { cwd: at })
      await runCli(['file', 'task', 'One that landed'], { cwd: at })
      await chmod(items, 0o500)
      await runCli(['file', 'task', 'One that did not'], { cwd: at })
      await chmod(items, 0o700)

      const backlog = await runCli(['backlog'], { cwd: at })
      assert.equal(backlog.code, 0, backlog.err)
      assert.match(backlog.out, /One that landed/)
      assert.equal(backlog.out.includes('One that did not'), false, 'a refused write landed anyway')
    } finally {
      await chmod(items, 0o700).catch(() => undefined)
      await rm(at, { recursive: true, force: true })
    }
  })
})
