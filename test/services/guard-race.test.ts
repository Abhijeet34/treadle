// SPDX-License-Identifier: Apache-2.0
// A guard that reads a neighbour, raced by a writer moving that neighbour. `G2` read a done
// blocker as inactive and `DOD1` read a done child as finished, and each compare-and-set
// covered the item written alone: a start decided against a done blocker landed after the
// blocker was reopened, and an accept landed after the child was reopened. The sequential
// order refuses both, so the race admitted a state no single writer could reach. The write
// now carries every neighbour the decision read, which is the read set the relation writer
// already carried, and the store refuses with `S10` if one moved.
//
// Two store instances on one root stand in for two processes, as in relation-race.test.ts:
// the first writer is held at its apply until the second has landed.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { Store, StoreTransaction } from '../../src/application/ports/store.ts'
import type { ResultObject } from '../../src/application/result.ts'
import { setFields } from '../../src/application/services/editing.ts'
import { fileItem } from '../../src/application/services/items.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { addEvidence } from '../../src/application/services/marking.ts'
import type { Target } from '../../src/application/services/mutation.ts'
import { relate } from '../../src/application/services/relation.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { createWorkspace, openWorkspace } from '../../src/adapters/store/index.ts'
import type { WorkItemState } from '../../src/domain/index.ts'
import { ACTOR, NOW } from '../helpers/cli-fixtures.ts'

/** The store as it is, with its apply held until `release` resolves and `reached` resolved when it is called. */
function gated(store: Store): { readonly store: Store; readonly reached: Promise<void>; release(): void } {
  let open = (): void => {}
  let arrived = (): void => {}
  const released = new Promise<void>((resolve) => { open = resolve })
  const reached = new Promise<void>((resolve) => { arrived = resolve })
  const held = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'apply') {
        return async (transaction: StoreTransaction) => { arrived(); await released; return target.apply(transaction) }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  return { store: held, reached, release: open }
}

describe('a guard that read a neighbour is refused when that neighbour moved before the write', () => {
  let parent: string
  let root: string
  let first: Store
  let second: Store
  let ids = sequentialIds(100)
  const clock = fixedClock(NOW)
  const target = (store: Store): Target => ({ store, mode: 'apply' })
  const must = async (result: Promise<ResultObject>): Promise<ResultObject> => {
    const done = await result
    assert.equal(done.ok, true, String(done.data['cause']))
    return done
  }
  const move = (store: Store, id: string, to: WorkItemState, reason?: string): Promise<ResultObject> =>
    transition(target(store), clock, ids, { id, target: to, actor: ACTOR, ...(reason === undefined ? {} : { reason }) })
  const file = (store: Store, type: 'task' | 'story', id: string, fields: Record<string, string> = {}): Promise<ResultObject> =>
    fileItem(target(store), clock, ids, { type, title: `Item ${id}`, id, fields, actor: ACTOR })
  const stateOf = async (id: string): Promise<string | undefined> => {
    const got = await second.get(id)
    return got.ok ? got.value?.state : undefined
  }

  before(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'treadle-guard-race-'))
    root = path.join(parent, '.work')
    const created = await createWorkspace(root, { id: 'race', name: 'race', at: NOW })
    assert.equal(created.ok, true)
    const a = await openWorkspace(root)
    const b = await openWorkspace(root)
    if (!a.ok || !b.ok) throw new Error('the workspace did not open twice')
    first = a.value
    second = b.value
  })
  after(async () => {
    await first.close()
    await second.close()
    await rm(parent, { recursive: true, force: true })
  })

  /** Runs `early` on the held store, lets `late` land on the other, then releases `early`. */
  async function interleave(early: (store: Store) => Promise<ResultObject>, late: (store: Store) => Promise<ResultObject>): Promise<ResultObject> {
    const held = gated(first)
    const pending = early(held.store)
    // Raced against its own arrival rather than simply awaited. A move refused by a guard
    // returns without ever calling `apply`, so `reached` never resolves and this file waits
    // for ever: `node --test` is run with `--test-timeout=0` here, so nothing ends it. A gate
    // rule that widened to cover this fixture wedged the suite for 53 minutes with no output
    // and no failing test, which is the worst shape a suite can fail in. A fixture that stops
    // reaching the write now says so.
    const arrival = await Promise.race([
      held.reached.then(() => 'reached' as const),
      pending.then(() => 'decided' as const),
    ])
    assert.equal(arrival, 'reached',
      'the early move was decided before it reached the store, so there was no write for the late one to race; fix the fixture, not this assertion')
    const landed = await late(second)
    assert.equal(landed.ok, true, String(landed.data['cause']))
    held.release()
    return pending
  }

  it('G2: a start decided against a done blocker is refused once the blocker is reopened', async () => {
    ids = sequentialIds(100)
    await must(file(first, 'task', 'blocker'))
    await must(file(first, 'task', 'blocked'))
    await must(relate(target(first), clock, ids, { verb: 'add', id: 'blocker', kind: 'blocks', other: 'blocked', actor: ACTOR }))
    for (const state of ['ready', 'in_progress', 'done'] as const) await must(move(first, 'blocker', state))
    await must(move(first, 'blocked', 'ready'))

    const refused = await interleave(
      (store) => move(store, 'blocked', 'in_progress'),
      (store) => move(store, 'blocker', 'in_progress', 'reopened'),
    )
    assert.equal(refused.ok, false, 'the start landed while its blocker was live again')
    assert.equal(refused.code, 'CONFLICT')
    assert.equal(refused.data['rule'], 'S10')
    assert.equal(refused.data['entity'], 'blocker')
    assert.equal(await stateOf('blocked'), 'ready')
    // Run again from the state that is there now, the start is refused by the guard itself.
    const again = await move(second, 'blocked', 'in_progress')
    assert.equal(again.data['guard'], 'G2')
  })

  it('DOD1: an accept decided against a done child is refused once the child is reopened', async () => {
    ids = sequentialIds(200)
    // Assigned to somebody who is not `ACTOR`, because `DOD3` refuses an accept the item's own
    // assignee runs and this test is about `DOD1` and the read set, not about who is asking.
    await must(file(first, 'story', 'story', { acceptance_criteria: '[x] one', assignee: 'kim' }))
    await must(file(first, 'task', 'child', { parent_id: 'story' }))
    for (const state of ['ready', 'in_progress', 'done'] as const) await must(move(first, 'child', state))
    for (const state of ['ready', 'in_progress', 'in_review'] as const) await must(move(first, 'story', state))
    await must(setFields(target(first), clock, ids, { id: 'story', assignments: ['reviewer=ravi'], actor: ACTOR }))
    await must(addEvidence(target(first), clock, ids, { id: 'story', kind: 'run', ref: '1', actor: ACTOR }))

    const refused = await interleave(
      (store) => move(store, 'story', 'done'),
      (store) => move(store, 'child', 'in_progress', 'reopened'),
    )
    assert.equal(refused.ok, false, 'the accept landed over a child that was open again')
    assert.equal(refused.data['rule'], 'S10')
    assert.equal(refused.data['entity'], 'child')
    assert.equal(await stateOf('story'), 'in_review')
    const again = await move(second, 'story', 'done')
    assert.equal(again.data['guard'], 'G6')
  })

  it('a move whose neighbours did not move still lands, with every neighbour in the read set', async () => {
    ids = sequentialIds(400)
    await must(file(first, 'task', 'lone-blocker'))
    await must(file(first, 'task', 'lone-blocked'))
    await must(relate(target(first), clock, ids, { verb: 'add', id: 'lone-blocker', kind: 'blocks', other: 'lone-blocked', actor: ACTOR }))
    for (const state of ['ready', 'in_progress', 'done'] as const) await must(move(first, 'lone-blocker', state))
    await must(move(first, 'lone-blocked', 'ready'))
    let seen: StoreTransaction | undefined
    const watched = new Proxy(second, {
      get(store, property, receiver) {
        if (property === 'apply') return async (transaction: StoreTransaction) => { seen = transaction; return store.apply(transaction) }
        const value = Reflect.get(store, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(store) : value
      },
    })
    await must(move(watched, 'lone-blocked', 'in_progress'))
    assert.deepEqual(seen?.reads?.map((read) => read.id), ['lone-blocker'])
  })
})
