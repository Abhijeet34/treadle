// SPDX-License-Identifier: Apache-2.0
// DR4, measured rather than described. Every writer here is a separate process, because
// the guarantee is about separate processes and an in-process race would prove nothing.
//
// The reference's failing case is the third test: it ran a fixed 2.5 second acquisition
// budget and refused three of twelve serialised 300 millisecond writers. There is no budget
// here, so the assertion is zero refusals.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

import { acquireLock, parseFile, processIsGone } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

const run = promisify(execFile)
const WRITER = fileURLToPath(new URL('./fixtures/writer.ts', import.meta.url))

const WRITERS = 24
const HOLDERS = 12
const HOLD_MS = 300

type Reported = { ok: boolean; version?: number; attempts?: number; code?: string; waited?: number }

async function writer(root: string, id: string): Promise<Reported> {
  const { stdout } = await run(process.execPath, [WRITER, 'write', root, id], { encoding: 'utf8' })
  return JSON.parse(stdout) as Reported
}

describe(`${WRITERS} separate processes writing one record`, () => {
  it('persists every write it reported, and leaves no lock behind', async (t) => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't0', writes: [{ item: anItem({ priority: 1 }) }], events: [] })

      const reported = await Promise.all(
        Array.from({ length: WRITERS }, () => writer(workspace.root, 'item-one')),
      )
      const succeeded = reported.filter((r) => r.ok)
      assert.equal(succeeded.length, WRITERS, `${succeeded.length} of ${WRITERS} writers reported success`)

      const found = await workspace.store.get('item-one')
      assert.ok(found.ok)
      assert.equal(
        found.value?.version,
        WRITERS + 1,
        `${WRITERS} reported writes over version 1 must persist as version ${WRITERS + 1}`,
      )
      const events = await workspace.store.events({ entity: 'item-one' })
      assert.equal(events.ok && events.value.length, WRITERS)

      await assert.rejects(() => stat(path.join(workspace.root, '.lock')))

      // Zero lost updates is the version count above. Zero corruption is this: the shards
      // are read from disk rather than through the index, because a cache that agrees with
      // itself proves nothing about the files a team commits.
      const items = path.join(workspace.root, 'items')
      let quarantined = 0
      let records = 0
      for (const name of (await readdir(items)).filter((n) => n.endsWith('.md'))) {
        const parsed = parseFile(await readFile(path.join(items, name), 'utf8'), `items/${name}`)
        assert.ok(parsed.ok, `items/${name} does not parse after ${WRITERS} concurrent writers`)
        quarantined += parsed.value.quarantined.length
        records += parsed.value.records.length
      }
      assert.equal(quarantined, 0, 'a concurrent write quarantined a record')
      assert.equal(records, 1, `${records} records where one was written`)
      const attempts = reported.reduce((sum, r) => sum + (r.attempts ?? 0), 0)
      t.diagnostic(`${WRITERS} parallel processes: 0 lost updates, 0 corrupt shards, 0 quarantined, ${attempts} compare-and-set attempts to land ${WRITERS} writes`)
    } finally {
      await workspace.dispose()
    }
  })
})

describe(`${HOLDERS} processes each holding the lock for ${HOLD_MS} ms`, () => {
  it('refuses none of them, because there is no acquisition budget', async () => {
    const workspace = await aWorkspace()
    try {
      const reported = await Promise.all(Array.from({ length: HOLDERS }, async () => {
        const { stdout } = await run(process.execPath, [WRITER, 'hold', workspace.root, String(HOLD_MS)], { encoding: 'utf8' })
        return JSON.parse(stdout) as Reported
      }))
      assert.equal(reported.filter((r) => r.ok).length, HOLDERS, 'no holder may be refused')
      assert.ok(
        Math.max(...reported.map((r) => r.waited ?? 0)) >= HOLD_MS,
        'the holders must actually have serialised, not run concurrently',
      )
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a holder that dies never wedges the store', () => {
  it('reclaims from a killed holder and succeeds', async () => {
    const workspace = await aWorkspace()
    try {
      const child = spawn(process.execPath, [WRITER, 'grab', workspace.root], { stdio: ['ignore', 'pipe', 'inherit'] })
      await new Promise<void>((resolve) => { child.stdout.once('data', () => { resolve() }) })
      assert.ok(await stat(path.join(workspace.root, '.lock')))

      child.kill('SIGKILL')
      await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      assert.equal(processIsGone(child.pid as number), true)

      const started = Date.now()
      const lock = await acquireLock(path.join(workspace.root, '.lock'), { timeoutMs: 4_000 })
      assert.ok(lock.ok, lock.ok ? '' : lock.error.message)
      assert.ok(Date.now() - started < 1_000, 'a dead holder is proof of death, not a wait')
      await lock.value.release()
    } finally {
      await workspace.dispose()
    }
  })

  it('reclaims a live pid whose heartbeat stopped', async () => {
    const workspace = await aWorkspace()
    try {
      const file = path.join(workspace.root, '.lock')
      await writeFile(file, JSON.stringify({
        pid: process.pid, host: hostname(), since: '2026-01-01T00:00:00Z', nonce: 'stale',
      }))
      const old = new Date(Date.now() - 60_000)
      await utimes(file, old, old)

      const lock = await acquireLock(file, { timeoutMs: 4_000 })
      assert.ok(lock.ok, 'a stuck holder stops heartbeating and is reclaimed')
      assert.notEqual(JSON.parse(await readFile(file, 'utf8')).nonce, 'stale')
      await lock.value.release()
    } finally {
      await workspace.dispose()
    }
  })

  it('treats EPERM as alive, never as death', async () => {
    const workspace = await aWorkspace()
    try {
      const file = path.join(workspace.root, '.lock')
      // pid 1 answers EPERM to this process. Permission is not death, and a lock naming it
      // with a fresh heartbeat must time out rather than be stolen.
      await writeFile(file, JSON.stringify({
        pid: 1, host: hostname(), since: '2026-01-01T00:00:00Z', nonce: 'init',
      }))
      assert.equal(processIsGone(1), false)

      const lock = await acquireLock(file, { timeoutMs: 400 })
      assert.equal(lock.ok, false)
      assert.equal(lock.ok ? '' : lock.error.code, 'LOCK_TIMEOUT')
      assert.equal(JSON.parse(await readFile(file, 'utf8')).nonce, 'init', 'the lock was not stolen')
    } finally {
      await workspace.dispose()
    }
  })

  it('names the holder when a caller asked for a bound and hit it', async () => {
    const workspace = await aWorkspace()
    try {
      const file = path.join(workspace.root, '.lock')
      const held = await acquireLock(file)
      assert.ok(held.ok)
      const second = await acquireLock(file, { timeoutMs: 300 })
      assert.equal(second.ok, false)
      assert.match(second.ok ? '' : second.error.message, new RegExp(`held by pid ${process.pid}`))
      await held.value.release()
    } finally {
      await workspace.dispose()
    }
  })
})
