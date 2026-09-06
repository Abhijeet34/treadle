// SPDX-License-Identifier: Apache-2.0
// A guard that reads a neighbour, raced by a writer moving that neighbour. `G2` read a done
// blocker as inactive, `DOD1` read a done child as finished and `sprint commit` read the
// ready gate over the same blockers, and each compare-and-set covered the item written alone:
// a start decided against a done blocker landed after the blocker was reopened, an accept
// landed after the child was reopened, and a commit landed after the blocker came back. The
// sequential order refuses all three, so the race admitted a state no single writer could
// reach. The write now carries every neighbour the decision read, which is the read set the
// relation writer already carried, and the store refuses with `S10` if one moved.
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
import { commitItems, openSprint } from '../../src/application/services/sprints.ts'
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
    await held.reached
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
    await must(file(first, 'story', 'story', { points: '3', acceptance_criteria: '[x] one', assignee: 'dana' }))
    await must(file(first, 'task', 'child', { parent_id: 'story' }))
    for (const state of ['ready', 'in_progress', 'done'] as const) await must(move(first, 'child', state))
    for (const state of ['ready', 'in_progress', 'in_review'] as const) await must(move(first, 'story', state))
    await must(setFields(target(first), clock, ids, { id: 'story', assignments: ['reviewer=kim'], actor: ACTOR }))
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

  it('DOR3: a commit decided against a done blocker is refused once the blocker is reopened', async () => {
    ids = sequentialIds(300)
    await must(file(first, 'task', 'blocker-two'))
    await must(file(first, 'task', 'blocked-two'))
    await must(relate(target(first), clock, ids, { verb: 'add', id: 'blocker-two', kind: 'blocks', other: 'blocked-two', actor: ACTOR }))
    for (const state of ['ready', 'in_progress', 'done'] as const) await must(move(first, 'blocker-two', state))
    await must(move(first, 'blocked-two', 'ready'))
    await must(openSprint(target(first), clock, ids, { title: 'Sprint one', id: 'sprint-one', end: '2030-01-01', actor: ACTOR }))

    const refused = await interleave(
      (store) => commitItems(target(store), clock, ids, { sprint: 'sprint-one', items: ['blocked-two'], actor: ACTOR }),
      (store) => move(store, 'blocker-two', 'in_progress', 'reopened'),
    )
    assert.equal(refused.ok, false, 'the commit landed while the item was blocked again')
    assert.equal(refused.data['rule'], 'S10')
    assert.equal(refused.data['entity'], 'blocker-two')
    const item = await second.get('blocked-two')
    assert.equal(item.ok && item.value?.sprint_id, undefined)
    const again = await commitItems(target(second), clock, ids, { sprint: 'sprint-one', items: ['blocked-two'], actor: ACTOR })
    assert.equal(again.data['rule'], 'I4')
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
