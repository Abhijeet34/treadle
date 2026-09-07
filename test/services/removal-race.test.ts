// SPDX-License-Identifier: Apache-2.0
// Three interleavings that leave a record naming an id the store no longer holds.
//
// `remove`'s guards are about a neighbour that does not exist yet, so no read set can name
// one: an edge, a child's parent or a closed sprint's member written between the guard's
// read and the store's write is not seen, and the removal completes over it. Two of the
// three are the reverse order, a parent written at a record the removal already decided
// against, and `doctor` reported nothing about either.
//
// The rule that closes them is the store's, not this layer's: `S17` runs inside the lock
// `apply` already holds, after the read set and before any shard is rewritten, so the check
// and the write see one state. Each case below asserts the late writer is refused, the
// refusal names both records, and the store afterwards holds no edge and no parent pointing
// at a record that is not there.
//
// Two store instances on one root stand in for two processes, as `relation-race.test.ts`
// does: each performs its own read and its own apply under the real advisory lock, and the
// first is held at its apply until the second has landed.

import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { readWorkspace } from '../../src/application/services/context.ts'
import { setFields } from '../../src/application/services/editing.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { relate } from '../../src/application/services/relation.ts'
import { removeItem } from '../../src/application/services/removal.ts'
import { closeSprint, commitItems, openSprint } from '../../src/application/services/sprints.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { targetFor } from '../../src/adapters/target.ts'
import type { Store, StoreTransaction } from '../../src/application/ports/store.ts'
import { aDemoWorkspace, ACTOR, NOW, type Demo } from '../helpers/cli-fixtures.ts'

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

describe('a removal and the neighbour written under it', () => {
  let demo: Demo
  let second: Store
  beforeEach(async () => {
    demo = await aDemoWorkspace()
    const opened = await openWorkspace(demo.root)
    if (!opened.ok) throw new Error(opened.error.message)
    second = opened.value
  })
  afterEach(async () => { await second.close(); await demo.dispose() })

  it('A: refuses the removal an edge was written under, and no edge is left naming nothing', async () => {
    const first = gated(demo.store)
    const early = removeItem(targetFor(first.store, 'apply'), fixedClock(NOW), sequentialIds(700), {
      id: 'csv-export', reason: 'filed against the wrong product', confirmed: true, actor: ACTOR,
    })
    await first.reached
    const late = await relate(targetFor(second, 'apply'), fixedClock(NOW), sequentialIds(800), {
      verb: 'add', id: 'webhook-retry', kind: 'blocks', other: 'csv-export', actor: ACTOR,
    })
    assert.equal(late.ok, true, String(late.data['cause']))
    first.release()
    const refused = await early

    assert.equal(refused.ok, false, 'an edge was written at the record this removal decided against')
    assert.equal(refused.code, 'CONFLICT')
    assert.equal(refused.data['rule'], 'S17')
    assert.equal(refused.data['entity'], 'csv-export')
    assert.equal(refused.data['cause'],
      'webhook-retry blocks csv-export, written after this removal was decided; retry so the decision reads what is there now')

    const view = await readWorkspace(second)
    assert.equal(view.ok, true)
    if (!view.ok) return
    assert.equal(view.value.byId.has('csv-export'), true, 'the refused removal left the record where it was')
    for (const edge of view.value.relations.relations) {
      assert.equal(view.value.byId.has(edge.target), true, `${edge.source} ${edge.kind} ${edge.target} names no record`)
    }
  })

  it('B: refuses the removal a child was parented under, and no parent_id names nothing', async () => {
    const first = gated(demo.store)
    const early = removeItem(targetFor(first.store, 'apply'), fixedClock(NOW), sequentialIds(700), {
      id: 'auth-refresh', reason: 'duplicated by the sso story', confirmed: true, actor: ACTOR,
    })
    await first.reached
    const late = await setFields(targetFor(second, 'apply'), fixedClock(NOW), sequentialIds(800), {
      id: 'onboard-copy', assignments: ['parent_id=auth-refresh'], actor: ACTOR,
    })
    assert.equal(late.ok, true, String(late.data['cause']))
    first.release()
    const refused = await early

    assert.equal(refused.ok, false, 'a child was parented at the record this removal decided against')
    assert.equal(refused.code, 'CONFLICT')
    assert.equal(refused.data['rule'], 'S17')
    assert.equal(refused.data['entity'], 'auth-refresh')
    assert.equal(refused.data['cause'],
      'onboard-copy has auth-refresh as its parent, written after this removal was decided; retry so the decision reads what is there now')

    const view = await readWorkspace(second)
    assert.equal(view.ok, true)
    if (!view.ok) return
    assert.equal(view.value.byId.get('onboard-copy')?.parent_id, 'auth-refresh')
    assert.equal(view.value.byId.has('auth-refresh'), true, 'the parent the child names is still a record')
  })

  it('C: refuses the parent write whose parent was removed under it', async () => {
    const first = gated(demo.store)
    const early = setFields(targetFor(first.store, 'apply'), fixedClock(NOW), sequentialIds(700), {
      id: 'onboard-copy', assignments: ['parent_id=auth-refresh'], actor: ACTOR,
    })
    await first.reached
    const late = await removeItem(targetFor(second, 'apply'), fixedClock(NOW), sequentialIds(800), {
      id: 'auth-refresh', reason: 'duplicated by the sso story', confirmed: true, actor: ACTOR,
    })
    assert.equal(late.ok, true, String(late.data['cause']))
    first.release()
    const refused = await early

    assert.equal(refused.ok, false, 'the parent left the store after this write was decided against it')
    assert.equal(refused.code, 'CONFLICT')
    assert.equal(refused.data['rule'], 'S10')
    assert.equal(refused.data['entity'], 'auth-refresh')
    assert.equal(refused.data['cause'],
      'auth-refresh is not in the store, so onboard-copy cannot name it as its parent; retry so the decision reads what is there now')

    const view = await readWorkspace(second)
    assert.equal(view.ok, true)
    if (!view.ok) return
    assert.equal(view.value.byId.get('onboard-copy')?.parent_id, undefined, 'the refused write left no parent behind')
    assert.equal(view.value.byId.has('auth-refresh'), false)
  })
})

/**
 * The cases the three above do not reach, each aimed at the new rule rather than at the
 * defect it closed: the orders it must refuse, the orders it must still allow, and the two
 * places its own shortcuts could hide a referrer.
 */
describe('the referential rule under the orders that attack it', () => {
  let demo: Demo
  let second: Store
  beforeEach(async () => {
    demo = await aDemoWorkspace()
    const opened = await openWorkspace(demo.root)
    if (!opened.ok) throw new Error(opened.error.message)
    second = opened.value
  })
  afterEach(async () => { await second.close(); await demo.dispose() })

  const apply = (store: Store, seed: number) => [targetFor(store, 'apply'), fixedClock(NOW), sequentialIds(seed)] as const

  /** One sprint holding one done item, which is the state a close freezes into a record. */
  async function aSprintHolding(id: string): Promise<void> {
    const [target, clock, ids] = apply(demo.store, 600)
    const opened = await openSprint(target, clock, ids, { title: 'Sprint 31', id: 'sprint-31', start: '2026-09-07', end: '2026-09-18', actor: ACTOR })
    assert.equal(opened.ok, true, String(opened.data['cause']))
    const committed = await commitItems(target, clock, ids, { sprint: 'sprint-31', items: [id], actor: ACTOR })
    assert.equal(committed.ok, true, String(committed.data['cause']))
    for (const to of ['in_progress', 'done'] as const) {
      const moved = await transition(target, clock, ids, { id, target: to, actor: ACTOR })
      assert.equal(moved.ok, true, String(moved.data['cause']))
    }
  }

  it('refuses a removal that a sprint close froze a member set around', async () => {
    await aSprintHolding('avatar-crop')
    const first = gated(demo.store)
    // An open sprint's committed set is derived, so this removal is legal when it is decided.
    const early = removeItem(...apply(first.store, 700), { id: 'avatar-crop', reason: 'filed twice', confirmed: true, actor: ACTOR })
    await first.reached
    const closed = await closeSprint(...apply(second, 800), { sprint: 'sprint-31', actor: ACTOR })
    assert.equal(closed.ok, true, String(closed.data['cause']))
    first.release()
    const refused = await early

    assert.equal(refused.ok, false, 'the close wrote a frozen member set naming this record')
    assert.equal(refused.data['rule'], 'S17')
    assert.equal(refused.data['cause'],
      'sprint-31 is closed and counts avatar-crop in its committed set, written after this removal was decided; retry so the decision reads what is there now')
  })

  it('allows a removal that a sprint commit lands under, because an open set is derived', async () => {
    await aSprintHolding('avatar-crop')
    const first = gated(demo.store)
    const early = removeItem(...apply(first.store, 700), { id: 'webhook-retry', reason: 'filed twice', confirmed: true, actor: ACTOR })
    await first.reached
    const committed = await commitItems(...apply(second, 800), { sprint: 'sprint-31', items: ['webhook-retry'], actor: ACTOR })
    assert.equal(committed.ok, true, String(committed.data['cause']))
    first.release()
    const removed = await early

    // The record it was committed to still exists and its membership is recomputed from what
    // points at it, so nothing is left naming a record that is not there.
    assert.equal(removed.ok, false, 'the commit bumped the version this removal was decided against')
    assert.equal(removed.data['rule'], 'S10', String(removed.data['cause']))
    const again = await removeItem(...apply(second, 900), { id: 'webhook-retry', reason: 'filed twice', confirmed: true, actor: ACTOR })
    assert.equal(again.ok, true, String(again.data['cause']))
  })

  it('lets one of two simultaneous removals of one record land, and refuses the other', async () => {
    const first = gated(demo.store)
    const early = removeItem(...apply(first.store, 700), { id: 'csv-export', reason: 'filed twice', confirmed: true, actor: ACTOR })
    await first.reached
    const late = await removeItem(...apply(second, 800), { id: 'csv-export', reason: 'filed twice', confirmed: true, actor: ACTOR })
    assert.equal(late.ok, true, String(late.data['cause']))
    first.release()
    const refused = await early

    assert.equal(refused.ok, false, 'the record had already left the store')
    assert.equal(refused.data['rule'], 'S10')
    const events = await second.events({ entity: 'csv-export' })
    assert.equal(events.ok && events.value.filter((event) => event.op === 'item.remove').length, 1,
      'one removal, one item.remove event')
  })

  it('refuses a removal a retitle landed under, and the record keeps the new title', async () => {
    const first = gated(demo.store)
    const early = removeItem(...apply(first.store, 700), { id: 'csv-export', reason: 'filed twice', confirmed: true, actor: ACTOR })
    await first.reached
    const renamed = await setFields(...apply(second, 800), { id: 'csv-export', assignments: ['title=Export a filtered list to TSV'], actor: ACTOR })
    assert.equal(renamed.ok, true, String(renamed.data['cause']))
    first.release()
    const refused = await early

    assert.equal(refused.ok, false, 'the record moved under a removal decided against its old version')
    assert.equal(refused.data['rule'], 'S10')
    const view = await readWorkspace(second)
    assert.equal(view.ok, true)
    if (!view.ok) return
    assert.equal(view.value.byId.get('csv-export')?.title, 'Export a filtered list to TSV')
  })

  it('sees the second child when the transaction removes the first, which one row would hide', async () => {
    // The lookup answers with one row, so a transaction that takes out the child it happens
    // to return must not be able to walk past a second one. Reached through the store, which
    // is the only caller that can name two removals in one transaction.
    for (const [at, child] of ['onboard-copy', 'avatar-crop'].entries()) {
      // A fresh seed per write: two `set`s off one sequential generator mint the same event
      // id, which is `S14` and makes the read below fail for a reason this test is not about.
      const set = await setFields(...apply(demo.store, 600 + at * 10), { id: child, assignments: ['parent_id=auth-refresh'], actor: ACTOR })
      assert.equal(set.ok, true, String(set.data['cause']))
    }
    const view = await readWorkspace(demo.store)
    assert.equal(view.ok, true)
    if (!view.ok) return
    const versionOf = (id: string): number => view.value.byId.get(id)?.version as number
    const refused = await demo.store.apply({
      txn: 'txn-attack',
      writes: [],
      removes: [
        { id: 'onboard-copy', ifVersion: versionOf('onboard-copy') },
        { id: 'auth-refresh', ifVersion: versionOf('auth-refresh') },
      ],
      events: [],
    })
    assert.equal(refused.ok, false, 'avatar-crop still names auth-refresh as its parent')
    if (refused.ok) return
    assert.equal(refused.error.rule, 'S17')
    assert.deepEqual(refused.error.entities, ['auth-refresh', 'avatar-crop'])
  })
})
