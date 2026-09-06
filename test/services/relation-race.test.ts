// SPDX-License-Identifier: Apache-2.0
// Two commands closing a blocks cycle between them. `R2` reads the graph before the lock is
// taken and the compare-and-set covered only the record written, so two processes adding
// `a blocks b` and `b blocks a` at one instant each saw an empty graph, wrote different
// records, and both landed; every item on the cycle then waited on itself with only
// doctor's H25 saying so. The write now carries the records its decision read, and the
// store refuses if one of them moved.
//
// Two store instances on one root stand in for two processes: each performs its own read
// and its own apply under the real advisory lock. The first writer is held at its apply
// until the second has landed, which is the interleaving a race produces and a test can
// only reach by construction.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { readWorkspace } from '../../src/application/services/context.ts'
import { relate } from '../../src/application/services/relation.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { findRelationCycle } from '../../src/domain/index.ts'
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

describe('a blocks cycle two writers close between them', () => {
  let demo: Demo
  let second: Store
  before(async () => {
    demo = await aDemoWorkspace()
    const opened = await openWorkspace(demo.root)
    if (!opened.ok) throw new Error(opened.error.message)
    second = opened.value
  })
  after(async () => { await second.close(); await demo.dispose() })

  it('is refused for the writer that lands second, naming the record that moved, and the store holds no cycle', async () => {
    const first = gated(demo.store)
    const early = relate(targetFor(first.store, 'apply'), fixedClock(NOW), sequentialIds(700), {
      verb: 'add', id: 'csv-export', kind: 'blocks', other: 'webhook-retry', actor: ACTOR,
    })
    await first.reached
    // The other direction reads a graph the first writer has not yet changed, and lands.
    const late = await relate(targetFor(second, 'apply'), fixedClock(NOW), sequentialIds(800), {
      verb: 'add', id: 'webhook-retry', kind: 'blocks', other: 'csv-export', actor: ACTOR,
    })
    assert.equal(late.ok, true, String(late.data['cause']))
    first.release()
    const refused = await early

    assert.equal(refused.ok, false, 'the first writer decided against a graph that moved under it')
    assert.equal(refused.code, 'CONFLICT')
    assert.equal(refused.data['rule'], 'S10')
    assert.equal(refused.data['entity'], 'webhook-retry')

    const view = await readWorkspace(second)
    assert.equal(view.ok, true)
    if (!view.ok) return
    assert.equal(findRelationCycle(view.value.relations, 'blocks'), undefined)
    assert.deepEqual(view.value.byId.get('csv-export')?.relations ?? [], [], 'the refused write left nothing on its record')
    assert.deepEqual(view.value.byId.get('webhook-retry')?.relations, [{ kind: 'blocks', target: 'csv-export' }])
  })
})
