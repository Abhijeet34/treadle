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
import { relate } from '../../src/application/services/relation.ts'
import { removeItem } from '../../src/application/services/removal.ts'
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
    assert.deepEqual(refused.data['entity'], ['csv-export', 'webhook-retry'])

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
    assert.deepEqual(refused.data['entity'], ['auth-refresh', 'onboard-copy'])

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
    assert.deepEqual(refused.data['entity'], ['auth-refresh'])

    const view = await readWorkspace(second)
    assert.equal(view.ok, true)
    if (!view.ok) return
    assert.equal(view.value.byId.get('onboard-copy')?.parent_id, undefined, 'the refused write left no parent behind')
    assert.equal(view.value.byId.has('auth-refresh'), false)
  })
})
