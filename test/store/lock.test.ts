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
import { setTimeout as delay } from 'node:timers/promises'
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

  it('reports a lock it could not create at all, rather than waiting on nothing', async () => {
    const workspace = await aWorkspace()
    try {
      // A directory that does not exist is ENOENT, not EEXIST: nobody holds this lock and
      // no amount of waiting will change that, so it is a refusal rather than a wait.
      const nowhere = path.join(workspace.root, 'no', 'such', 'directory', '.lock')
      const refused = await acquireLock(nowhere, { timeoutMs: 200 })
      assert.equal(refused.ok, false)
      assert.equal(refused.ok ? '' : refused.error.code, 'STORE_UNAVAILABLE')
      assert.equal(refused.ok ? '' : refused.error.rule, 'S11')
      assert.match(refused.ok ? '' : refused.error.message, /could not be created/)
    } finally {
      await workspace.dispose()
    }
  })

  it('says only that it timed out when the lock file names no holder it can read', async () => {
    const workspace = await aWorkspace()
    try {
      const file = path.join(workspace.root, '.lock')
      for (const body of ['not json at all', '{"pid":"one","host":"h","since":"s","nonce":"n"}', '{"pid":1,"host":"h"}']) {
        await writeFile(file, body)
        const refused = await acquireLock(file, { timeoutMs: 120, staleMs: 60_000 })
        assert.equal(refused.ok, false, `${body} was treated as a holder`)
        assert.equal(refused.ok ? '' : refused.error.code, 'LOCK_TIMEOUT')
        assert.match(refused.ok ? '' : refused.error.message, /was not acquired within 120 ms$/)
      }
    } finally {
      await workspace.dispose()
    }
  })

  it('tells a waiting caller who is holding it, once, after a second', async (t) => {
    const workspace = await aWorkspace()
    try {
      const file = path.join(workspace.root, '.lock')
      const held = await acquireLock(file)
      assert.ok(held.ok)

      const notes: { pid: number | undefined; waited: number }[] = []
      const second = await acquireLock(file, {
        timeoutMs: 1_600,
        onWaiting: (token, waited) => { notes.push({ pid: token?.pid, waited }) },
      })
      assert.equal(second.ok, false)
      assert.equal(notes.length, 1, `the caller was told ${notes.length} times`)
      assert.equal(notes[0]?.pid, process.pid, 'the note does not name the holder')
      assert.ok((notes[0]?.waited ?? 0) >= 1_000, 'the note came before a second had passed')
      await held.value.release()
      t.diagnostic(`the waiting caller was notified once, after ${notes[0]?.waited} ms`)
    } finally {
      await workspace.dispose()
    }
  })

  it('releases once, and never unlinks a lock that changed hands', async () => {
    const workspace = await aWorkspace()
    try {
      const file = path.join(workspace.root, '.lock')
      const held = await acquireLock(file)
      assert.ok(held.ok)
      await held.value.release()
      await held.value.release()

      // Somebody else now holds it. A second release from the old handle must not remove it.
      const next = await acquireLock(file)
      assert.ok(next.ok)
      await held.value.release()
      assert.ok(await stat(file), 'the old handle unlinked the new holder\'s lock')
      await next.value.release()
      await assert.rejects(() => stat(file))
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

/**
 * Stops a running writer inside its critical section, which is where a `Ctrl-Z` lands
 * often enough, and returns whether it got there. The lock file carrying the writer's pid
 * is the proof that the stop landed while the lock was held.
 */
async function stopInsideCriticalSection(root: string, child: ReturnType<typeof spawn>): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    child.kill('SIGSTOP')
    await delay(5)
    const token = await readFile(path.join(root, '.lock'), 'utf8').then((t) => JSON.parse(t) as { pid: number }).catch(() => undefined)
    if (token?.pid === child.pid) return true
    child.kill('SIGCONT')
    await delay(7)
  }
  return false
}

describe('a holder that stalls past the heartbeat window has lost its lock', () => {
  it('reports held() false after a stall longer than the stale window, with the file still its own', async () => {
    const workspace = await aWorkspace()
    try {
      const lock = await acquireLock(path.join(workspace.root, '.lock'), { heartbeatMs: 50, staleMs: 200 })
      assert.ok(lock.ok)
      assert.equal(await lock.value.held(), true)
      // A blocked event loop is what a pause looks like from inside: no heartbeat fires.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
      assert.equal(await lock.value.held(), false)
      await lock.value.release()
    } finally {
      await workspace.dispose()
    }
  })

  it('reports held() false once the file carries another token', async () => {
    const workspace = await aWorkspace()
    try {
      const file = path.join(workspace.root, '.lock')
      const lock = await acquireLock(file)
      assert.ok(lock.ok)
      await writeFile(file, JSON.stringify({ pid: 999999, host: hostname(), since: '2026-01-01T00:00:00Z', nonce: 'other' }))
      assert.equal(await lock.value.held(), false)
      await lock.value.release()
      assert.ok((await readFile(file, 'utf8')).includes('other'), 'a release never unlinks a lock it does not hold')
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses the write of a writer paused past the window, so the reclaimer\'s write is never overwritten', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't0', writes: [{ item: anItem({ priority: 1 }) }], events: [] })
      await workspace.store.close()

      const churn = spawn(process.execPath, [WRITER, 'churn', workspace.root, 'item-one'], { stdio: ['ignore', 'pipe', 'inherit'] })
      let output = ''
      churn.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      await new Promise<void>((resolve) => { churn.stdout?.once('data', () => resolve()) })
      await delay(200)
      const stopped = await stopInsideCriticalSection(workspace.root, churn)
      assert.ok(stopped, 'the writer was never caught inside its critical section')

      // Past the stale window a waiter is entitled to reclaim, and this one does.
      await delay(5_600)
      const competitor = await writer(workspace.root, 'item-one')
      assert.ok(competitor.ok, `the competitor did not reclaim the stalled lock: ${JSON.stringify(competitor)}`)

      churn.kill('SIGCONT')
      await delay(1_500)
      churn.kill('SIGKILL')
      await new Promise<void>((resolve) => { churn.once('exit', () => resolve()) })
      // The kill can land between a shard rename and its event append, which DR4 leaves for
      // the next lock holder's journal replay to finish; one more writer is that holder.
      assert.ok((await writer(workspace.root, 'item-one')).ok)

      // Read from disk, not through any index: one version per update event landed means
      // no write was overwritten.
      const shard = parseFile(await readFile(path.join(workspace.root, 'items', '2026-09.md'), 'utf8'), 'items/2026-09.md')
      assert.ok(shard.ok)
      const version = Number(shard.value.records[0]?.fields.get('version'))
      let updates = 0
      for (const name of await readdir(path.join(workspace.root, 'events'))) {
        for (const text of (await readFile(path.join(workspace.root, 'events', name), 'utf8')).split('\n')) {
          if (text.includes('"op":"update"')) updates += 1
        }
      }
      assert.equal(version, updates + 1, `version ${version} against ${updates} update events: a write was lost`)

      // A writer paused after its write had fully landed has nothing left to refuse, so the
      // count is not asserted; what is asserted is that every refusal is one of the two
      // honest ones, and that nothing else happened to a write.
      const outcomes = output.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { ok: boolean; code?: string; rule?: string })
      const refused = outcomes.filter((o) => !o.ok)
      assert.ok(refused.every((o) => (o.code === 'LOCK_LOST' && o.rule === 'S16') || (o.code === 'CONFLICT' && o.rule === 'S10')), JSON.stringify(refused))
    } finally {
      await workspace.dispose()
    }
  })
})
