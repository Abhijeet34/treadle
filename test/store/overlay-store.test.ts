// SPDX-License-Identifier: Apache-2.0
// The overlay store against the same seam suite, plus the one property that is its reason
// for existing: it evaluates and diffs a whole transaction and the base store never moves.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { OverlayStore } from '../../src/adapters/store/index.ts'
import { aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'
import { storeConformance } from './conformance.ts'

storeConformance('copy-on-write overlay store', async () => {
  const workspace = await aWorkspace()
  const overlay = new OverlayStore(workspace.store)
  return {
    store: overlay,
    async dispose(): Promise<void> {
      await overlay.close()
      await workspace.dispose()
    },
  }
})

describe('the overlay writes nothing to the base', () => {
  it('answers from the overlay while the base file and event log stay untouched', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      const before = await readFile(path.join(workspace.root, 'items/2026-09.md'), 'utf8')

      const overlay = new OverlayStore(workspace.store)
      const dry = await overlay.apply({
        txn: 'dry-1',
        writes: [
          { item: anItem({ state: 'ready' }), ifVersion: 1 },
          { item: anItem({ id: 'item-two', title: 'Proposed' }) },
        ],
        events: [anEvent({ id: 'ev-9', op: 'transition' })],
      })
      assert.ok(dry.ok, dry.ok ? '' : dry.error.message)

      const seen = await overlay.get('item-one')
      assert.equal(seen.ok && seen.value?.state, 'ready')
      const proposed = await overlay.get('item-two')
      assert.equal(proposed.ok && proposed.value?.title, 'Proposed')

      assert.equal(await readFile(path.join(workspace.root, 'items/2026-09.md'), 'utf8'), before)
      assert.deepEqual(await readdir(path.join(workspace.root, 'items')), ['2026-09.md'])
      const base = await workspace.store.get('item-one')
      assert.equal(base.ok && base.value?.state, 'draft')
      assert.equal(base.ok && base.value?.version, 1)

      const pending = overlay.pending()
      assert.deepEqual(pending.items.map((i) => i.id), ['item-one', 'item-two'])
      assert.deepEqual(pending.events.map((e) => e.id), ['ev-9'])
    } finally {
      await workspace.dispose()
    }
  })

  it('reads the base through the overlay for anything it has not written', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      const overlay = new OverlayStore(workspace.store)
      const found = await overlay.get('item-one')
      assert.equal(found.ok && found.value?.title, 'A first task')
      const events = await overlay.events({ entity: 'item-one' })
      assert.deepEqual(events.ok ? events.value.map((e) => e.id) : [], ['ev-1'])
    } finally {
      await workspace.dispose()
    }
  })
})
