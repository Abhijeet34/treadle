// SPDX-License-Identifier: Apache-2.0
// The second half of a reclaim, forced rather than waited for.
//
// `test/store/lock.test.ts` reaches this window with SIGSTOP and a real subprocess, which is
// the honest end-to-end drive but reaches the window only when the scheduler cooperates: it
// caught the lost write once in three CI runs on Node 26 and never in thirty local ones. The
// interleaving itself is one line wide - `writeFileAtomic` asks the guard, then renames - so
// it is held open here from inside the guard, and the outcome depends on no timing at all.
//
// The guard below is the two lines `#assertHeld` is: ask the lock, refuse if it is gone.
// Everything else is the real thing - the store's own lock, its own reclaim, its own
// transactions - because what is under test is whether a writer that resumes inside that
// window can still commit over the writes taken while it was away.

import assert from 'node:assert/strict'
import { readFile, readdir, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { acquireLock, parseFile, writeFileAtomic } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem, type Workspace } from '../helpers/store-fixtures.ts'
import type { LockHandle } from '../../src/adapters/store/lock.ts'

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

/**
 * A holder whose heartbeat has stopped, which is all a descheduled process is from the
 * filesystem: the timer runs on its event loop. The beat is put past the test's own life and
 * the last one backdated, so the reclaim is entitled and immediate rather than five seconds
 * of waiting for exactly this state.
 */
async function aStalledHolder(root: string): Promise<LockHandle> {
  const lockPath = path.join(root, LOCK)
  const held = await acquireLock(lockPath, { heartbeatMs: 60_000 })
  assert.ok(held.ok)
  const silentSince = new Date(Date.now() - 60_000)
  await utimes(lockPath, silentSince, silentSince)
  return held.value
}

type Stalled = {
  /** Resolves once the writer is inside the window: guard answered, rename not yet run. */
  readonly inTheWindow: Promise<void>
  resume(): void
  /** How many times the guard was asked, which is how the refusal's own path is read. */
  asked(): number
  /** The error the resumed writer refused with, or `undefined` if it committed. */
  outcome(): Promise<NodeJS.ErrnoException | undefined>
}

function aDescheduledWriter(target: string, contents: string, lock: LockHandle): Stalled {
  let resume = (): void => {}
  const paused = new Promise<void>((settle) => { resume = settle })
  let entered = (): void => {}
  const inTheWindow = new Promise<void>((settle) => { entered = settle })
  let asked = 0
  const done = writeFileAtomic(target, contents, async () => {
    asked += 1
    if (!(await lock.held())) throw new Error('the lock was lost before the write was committed')
    // Only the first answer is stopped on: the second is the one the failed commit asks for.
    if (asked === 1) {
      entered()
      await paused
    }
  })
  return {
    inTheWindow,
    resume: () => { resume() },
    asked: () => asked,
    outcome: () => done.then(() => undefined, (error: unknown) => error as NodeJS.ErrnoException),
  }
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

      const held = await aStalledHolder(workspace.root)
      const stalled = aDescheduledWriter(shardPath, stale, held)
      await stalled.inTheWindow

      // Two transactions, because one is not enough to expose the loss: the reclaimer's
      // first write lands on the same version number the paused writer is carrying, and it
      // takes a second bump for the stale rename to read one low.
      await update(workspace, 1)
      await update(workspace, 2)

      stalled.resume()
      const refusal = await stalled.outcome()

      const { version, updates } = await landed(workspace.root)
      assert.equal(version, updates + 1, `version ${version} against ${updates} distinct update events: a write was lost`)
      assert.ok(refusal !== undefined, 'the descheduled writer committed instead of refusing')
      await held.release()
      t.diagnostic(`version ${version} over ${updates} update events, and the resumed writer refused: ${refusal.message}`)
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

      const held = await aStalledHolder(workspace.root)
      const stalled = aDescheduledWriter(shardPath, stale, held)
      await stalled.inTheWindow

      await update(workspace, 1)
      stalled.resume()
      const refusal = await stalled.outcome()

      // A fenced writer has to hear why the write was refused, not the errno the fence
      // raised on the way, which is why the guard is asked a second time.
      assert.ok(refusal !== undefined, 'the descheduled writer committed instead of refusing')
      assert.match(refusal.message, /the lock was lost/, `refused with ${refusal.code ?? 'no code'}: ${refusal.message}`)
      assert.equal(stalled.asked(), 2, 'the guard is asked once before the commit and once when it fails')

      const left = (await readdir(path.join(workspace.root, 'items')))
        .filter((name) => name.startsWith('.') && name.includes('.tmp.'))
      assert.deepEqual(left, [], `a refused commit left ${left.join(', ')} in items/`)
      // The reclaimer's write is what stands, and the fence removed a temp file rather than
      // anything the store serves.
      assert.ok((await stat(shardPath)).size > 0)
      await held.release()
    } finally {
      await workspace.dispose()
    }
  })
})
