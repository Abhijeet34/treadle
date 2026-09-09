// SPDX-License-Identifier: Apache-2.0
// The second half of a reclaim, forced rather than waited for.
//
// `test/store/lock.test.ts` reaches this window with SIGSTOP and a real subprocess, which
// is the honest end-to-end drive but reaches the window only when the scheduler cooperates:
// it failed once in three CI runs and never in thirty local ones. The interleaving itself
// is one line wide - `writeFileAtomic` asks the guard, then renames - so it is held open
// here from inside the guard, and the outcome does not depend on any timing at all.
//
// The guard passed to `writeFileAtomic` below is the two lines `#assertHeld` is: ask the
// lock, refuse if it is gone. Everything else is the real thing - the store's own lock, its
// own reclaim, its own transactions - because what is under test is whether a writer that
// resumes inside that window can still overwrite the writes taken while it was away.

import assert from 'node:assert/strict'
import { readFile, readdir, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { acquireLock, parseFile, writeFileAtomic } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem, type Workspace } from '../helpers/store-fixtures.ts'

const SHARD = path.join('items', '2026-09.md')
const LOCK = '.lock'

/** The failing assertion's two numbers, read from the committed files and nowhere else. */
async function landed(root: string): Promise<{ version: number; updates: number }> {
  const shard = parseFile(await readFile(path.join(root, SHARD), 'utf8'), SHARD)
  assert.ok(shard.ok, `${SHARD} does not parse`)
  const version = Number(shard.value.records[0]?.fields.get('version'))
  const updates = new Set<string>()
  for (const name of await readdir(path.join(root, 'events'))) {
    for (const line of (await readFile(path.join(root, 'events', name), 'utf8')).split('\n')) {
      if (line.includes('"op":"update"')) updates.add((JSON.parse(line) as { id: string }).id)
    }
  }
  return { version, updates: updates.size }
}

/** One real transaction over `item-one`: one version bump, one update event. */
async function update(workspace: Workspace, attempt: number): Promise<void> {
  const found = await workspace.store.get('item-one')
  assert.ok(found.ok && found.value !== undefined, 'the reclaimer could not read the record')
  const applied = await workspace.store.apply({
    txn: `reclaimer-${attempt}`,
    writes: [{ item: { ...found.value, priority: attempt }, ifVersion: found.value.version }],
    events: [{
      id: `ev-reclaimer-${attempt}`,
      at: '2026-09-01T10:00:00Z',
      actor: 'reclaimer', actor_kind: 'process', entity_kind: 'work_item',
      entity: 'item-one', op: 'update', txn: `reclaimer-${attempt}`,
    }],
  })
  assert.ok(applied.ok, `the reclaimer's write ${attempt} was refused: ${JSON.stringify(applied)}`)
}

describe('a writer descheduled between its lock check and its rename', () => {
  it('cannot overwrite the writes the reclaimer took while it was away', async (t) => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't0', writes: [{ item: anItem({ priority: 1 }) }], events: [] })
      const shardPath = path.join(workspace.root, SHARD)
      // What a paused writer is holding in its temp file: the shard as it read it, which
      // every later write moves past.
      const stale = await readFile(shardPath, 'utf8')

      const lockPath = path.join(workspace.root, LOCK)
      // A heartbeat past the test's own life is what a descheduled process looks like from
      // the filesystem: the timer runs on its event loop, so it stops when the process does.
      const held = await acquireLock(lockPath, { heartbeatMs: 60_000 })
      assert.ok(held.ok)
      // Its last beat, pushed back past the stale window, so the reclaim below is entitled
      // and immediate rather than five seconds of waiting for exactly this state.
      const silentSince = new Date(Date.now() - 60_000)
      await utimes(lockPath, silentSince, silentSince)

      let resume = (): void => {}
      const paused = new Promise<void>((settle) => { resume = settle })
      let reachedWindow = (): void => {}
      const inTheWindow = new Promise<void>((settle) => { reachedWindow = settle })

      const stalledWriter = writeFileAtomic(shardPath, stale, async () => {
        assert.equal(await held.value.held(), true, 'the guard must pass, or the window is never entered')
        reachedWindow()
        await paused
      })
      await inTheWindow

      // Two transactions, because one is not enough to expose the loss: the reclaimer's
      // first write lands on the same version number the paused writer is carrying, and it
      // takes a second bump for the stale rename to read one low.
      await update(workspace, 1)
      await update(workspace, 2)

      resume()
      const refusal = await stalledWriter.then(() => undefined, (error: unknown) => error as Error)

      const { version, updates } = await landed(workspace.root)
      assert.equal(version, updates + 1, `version ${version} against ${updates} distinct update events: a write was lost`)
      assert.ok(refusal !== undefined, 'the descheduled writer committed instead of refusing')
      await held.value.release()
      t.diagnostic(`the resumed writer was refused with: ${refusal.message}`)
    } finally {
      await workspace.dispose()
    }
  })

  it('is refused in the lock\'s own words, and leaves no temp file behind', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't0', writes: [{ item: anItem({ priority: 1 }) }], events: [] })
      const shardPath = path.join(workspace.root, SHARD)
      const stale = await readFile(shardPath, 'utf8')
      const lockPath = path.join(workspace.root, LOCK)

      const held = await acquireLock(lockPath, { heartbeatMs: 60_000 })
      assert.ok(held.ok)
      const silentSince = new Date(Date.now() - 60_000)
      await utimes(lockPath, silentSince, silentSince)

      let resume = (): void => {}
      const paused = new Promise<void>((settle) => { resume = settle })
      let reachedWindow = (): void => {}
      const inTheWindow = new Promise<void>((settle) => { reachedWindow = settle })
      // `#assertHeld`'s whole shape, including its refusal, so what the caller sees can be
      // asserted: a fenced writer must hear why the write was refused, not the errno the
      // fence produced on the way.
      let asked = 0
      const stalledWriter = writeFileAtomic(shardPath, stale, async () => {
        asked += 1
        if (!(await held.value.held())) throw new Error('the lock was lost before the write was committed')
        reachedWindow()
        await paused
      })
      await inTheWindow

      await update(workspace, 1)
      resume()
      const refusal = await stalledWriter.then(() => undefined, (error: unknown) => error as NodeJS.ErrnoException)

      assert.ok(refusal !== undefined, 'the descheduled writer committed instead of refusing')
      assert.match(refusal.message, /the lock was lost/, `refused with ${refusal.code ?? 'no code'}: ${refusal.message}`)
      assert.equal(asked, 2, 'the guard is asked once before the commit and once when the commit fails')

      const left = (await readdir(path.join(workspace.root, 'items')))
        .filter((name) => name.startsWith('.') && name.includes('.tmp.'))
      assert.deepEqual(left, [], `a refused commit left ${left.join(', ')} in items/`)
      // The reclaimer's write is what stands, and the fence removed a temp file rather than
      // anything the store serves.
      assert.ok((await stat(shardPath)).size > 0)
      await held.value.release()
    } finally {
      await workspace.dispose()
    }
  })
})
