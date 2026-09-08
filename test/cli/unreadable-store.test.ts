// SPDX-License-Identifier: Apache-2.0
// A store this process may not read is refused, and never answered as a store holding nothing.
//
// Found by driving the built tool over a workspace with `chmod 000` on its paths. `EACCES` on
// the items directory was `items 0` at exit 0 from `status`, `doctor` and `backlog`, and a
// `NOT_FOUND` from `show` naming a record that is there; an unreadable shard escaped as exit 1
// `INTERNAL` with a raw path and no rule id; an unreadable log answered `history` with "no
// recorded change". Every read swallowed the errno, and a silent empty answer over records
// that exist is the worst thing a record store can do. ADR-0030 carries the decision.

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'
import { POSIX_MODES } from '../helpers/platform.ts'

/** Root reads a directory whose mode is 0o000 anyway, so the mode proves nothing there. */
const UNREADABLE = POSIX_MODES
  || (process.getuid?.() === 0 ? 'root reads a path whose mode is 0o000 anyway' : false)

const ENV = { TREADLE_ACTOR: 'dana' }

describe('a store this process may not read is refused, not answered as empty', { skip: UNREADABLE }, () => {
  let root: string
  let work: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadle-unreadable-'))
    work = path.join(root, '.work')
    const init = await runCli(['init', '--name', 'unreadable', '--yes'], { cwd: root, env: ENV })
    assert.equal(init.code, 0, init.err)
    for (const id of ['first-task', 'second-task']) {
      const filed = await runCli(['file', 'task', `Item ${id}`, '--id', id], { cwd: root, env: ENV })
      assert.equal(filed.code, 0, filed.err)
    }
  })
  after(async () => {
    await chmod(path.join(work, 'items'), 0o755).catch(() => undefined)
    await chmod(path.join(work, 'events'), 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  /** Runs `argv` with `at` unreadable, whatever the body asserts, and puts the mode back. */
  async function withUnreadable(at: string, mode: number, argv: readonly string[]): Promise<Awaited<ReturnType<typeof runCli>>> {
    await chmod(at, 0o000)
    try {
      return await runCli(argv, { cwd: root, env: ENV })
    } finally {
      await chmod(at, mode)
    }
  }

  function refusesNaming(run: Awaited<ReturnType<typeof runCli>>, at: string): void {
    assert.equal(run.code, 6, `expected exit 6, got ${run.code}: ${run.out}${run.err}`)
    assert.match(run.err, /^err STORE_UNAVAILABLE /m)
    assert.match(run.err, /^rule S13$/m)
    assert.ok(run.err.includes(`${at} could not be read: `), `the refusal does not name ${at}: ${run.err}`)
    assert.match(run.err, /failed with EACCES$/m)
    assert.doesNotMatch(run.out, /^items 0$/m, 'an unreadable store answered as an empty one')
  }

  for (const command of [['status'], ['backlog'], ['doctor'], ['show', 'first-task'], ['next']] as const) {
    it(`${command[0]} refuses at 6 naming the items directory it could not read`, async () => {
      const items = path.join(work, 'items')
      refusesNaming(await withUnreadable(items, 0o755, [...command, '--out', 'agent']), items)
    })
  }

  it('refuses over one unreadable shard, naming the shard rather than the directory', async () => {
    const items = path.join(work, 'items')
    const shard = path.join(items, (await readdir(items)).find((name) => name.endsWith('.md')) as string)
    refusesNaming(await withUnreadable(shard, 0o644, ['status', '--out', 'agent']), shard)
  })

  it('refuses history over an unreadable log, rather than reporting no recorded change', async () => {
    const events = path.join(work, 'events')
    const run = await withUnreadable(events, 0o755, ['history', 'first-task', '--out', 'agent'])
    refusesNaming(run, events)
    assert.doesNotMatch(run.out, /has no recorded change/, 'an unreadable log answered as a silent one')
  })

  it('refuses in every rendering, and the json envelope carries the rule and the path', async () => {
    const items = path.join(work, 'items')
    for (const out of ['human', 'agent', 'json'] as const) {
      const run = await withUnreadable(items, 0o755, ['status', '--out', out])
      assert.equal(run.code, 6, `${out}: expected exit 6, got ${run.code}`)
      const text = run.out + run.err
      assert.ok(text.includes('S13'), `${out} names no rule: ${text}`)
      assert.ok(text.includes('could not be read'), `${out} does not say what happened: ${text}`)
    }
  })
})
