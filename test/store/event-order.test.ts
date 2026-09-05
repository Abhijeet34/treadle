// SPDX-License-Identifier: Apache-2.0
// Two events in one second. Instants are second-resolution and event ids are random, so
// ordering a query by `(at, id)` picks a lexicographic winner rather than the later write,
// and every caller that asks for "the last event for this entity" gets the wrong one: the
// conflict message names the wrong actor, and `explain` reports the state an item left
// rather than the one it entered. The append-only log holds the true order, and the index
// rows are inserted in that order, so the tie is broken on `rowid`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { explain } from '../../src/application/services/insight.ts'
import { aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'

/** Ids chosen so that lexicographic order is the reverse of the order they were appended. */
const FIRST = 'zzz-appended-first'
const SECOND = 'aaa-appended-second'
const SAME_SECOND = '2026-09-01T10:00:00Z'

describe('two events carrying one instant', () => {
  it('comes back in the order it was appended, not in id order', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem() }],
        events: [anEvent({ id: FIRST, at: SAME_SECOND, op: 'item.file' })],
      })
      await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }],
        events: [anEvent({ id: SECOND, at: SAME_SECOND, op: 'item.transition', reason: 'groomed' })],
      })

      const events = await workspace.store.events({ entity: 'item-one' })
      assert.ok(events.ok)
      assert.deepEqual(events.value.map((event) => event.id), [FIRST, SECOND])
    } finally {
      await workspace.dispose()
    }
  })

  it('makes explain name the write that put the item where it is', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem() }],
        events: [anEvent({ id: FIRST, at: SAME_SECOND, op: 'item.file' })],
      })
      await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }],
        events: [anEvent({
          id: SECOND, at: SAME_SECOND, op: 'item.transition', reason: 'the estimate is agreed',
        })],
      })

      const said = await explain(workspace.store, 'item-one')
      assert.equal(said.data['from_event'], SECOND)
      assert.equal(said.data['reason'], 'the estimate is agreed')
    } finally {
      await workspace.dispose()
    }
  })
})
