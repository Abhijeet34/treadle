// SPDX-License-Identifier: Apache-2.0
// The one suite that proves the store seam is real (DR6). It is parameterised by a factory
// and runs unchanged against the sharded store and the overlay store; a seam whose second
// implementation is a test double proves nothing, so the overlay here is the same object
// `--dry-run` will use in production.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Store } from '../../src/application/ports/store.ts'
import { SUMMARY_FIELDS } from '../../src/domain/index.ts'
import { anEvent, anItem } from '../helpers/store-fixtures.ts'

export type Subject = { readonly store: Store; dispose(): Promise<void> }

export function storeConformance(name: string, open: () => Promise<Subject>): void {
  const withStore = async (body: (store: Store) => Promise<void>): Promise<void> => {
    const subject = await open()
    try {
      await body(subject.store)
    } finally {
      await subject.dispose()
    }
  }

  describe(`store conformance: ${name}`, () => {
    it('resolves one printed identity', async () => {
      await withStore(async (store) => {
        const identity = await store.identity()
        assert.ok(identity.ok, identity.ok ? '' : identity.error.message)
        assert.equal(identity.value.id, 'test-workspace')
      })
    })

    it('returns undefined for an id it does not hold', async () => {
      await withStore(async (store) => {
        const found = await store.get('never-filed')
        assert.ok(found.ok)
        assert.equal(found.value, undefined)
      })
    })

    it('reads back a created item at version 1', async () => {
      await withStore(async (store) => {
        const applied = await store.apply({
          txn: 'txn-1',
          writes: [{ item: anItem({ title: 'A first task' }) }],
          events: [anEvent()],
        })
        assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
        assert.deepEqual(applied.value.writes, [{ id: 'item-one', version: 1 }])

        const found = await store.get('item-one')
        assert.ok(found.ok)
        assert.equal(found.value?.title, 'A first task')
        assert.equal(found.value?.version, 1)
      })
    })

    it('refuses a second create of the same id, naming the stored version', async () => {
      await withStore(async (store) => {
        await store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
        const again = await store.apply({ txn: 't2', writes: [{ item: anItem({ title: 'Other' }) }], events: [] })
        assert.equal(again.ok, false)
        if (again.ok) return
        assert.equal(again.error.code, 'CONFLICT')
        assert.equal(again.error.rule, 'S10')
        assert.equal(again.error.details?.['actual'], 1)
      })
    })

    it('bumps the version on an update that names the stored one', async () => {
      await withStore(async (store) => {
        await store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
        const moved = await store.apply({
          txn: 't2',
          writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }],
          events: [anEvent({ id: 'ev-2', op: 'transition' })],
        })
        assert.ok(moved.ok, moved.ok ? '' : moved.error.message)
        assert.deepEqual(moved.value.writes, [{ id: 'item-one', version: 2 }])
        const found = await store.get('item-one')
        assert.equal(found.ok && found.value?.state, 'ready')
      })
    })

    it('turns a stale version into a structured conflict and writes nothing', async () => {
      await withStore(async (store) => {
        await store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
        await store.apply({ txn: 't2', writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }], events: [] })

        const stale = await store.apply({
          txn: 't3',
          writes: [{ item: anItem({ state: 'in_progress' }), ifVersion: 1 }],
          events: [],
        })
        assert.equal(stale.ok, false)
        if (stale.ok) return
        assert.equal(stale.error.code, 'CONFLICT')
        assert.equal(stale.error.details?.['expected'], 1)
        assert.equal(stale.error.details?.['actual'], 2)

        const found = await store.get('item-one')
        assert.equal(found.ok && found.value?.state, 'ready')
        assert.equal(found.ok && found.value?.version, 2)
      })
    })

    it('applies a multi-write transaction as one unit, or not at all', async () => {
      await withStore(async (store) => {
        const both = await store.apply({
          txn: 't1',
          writes: [
            { item: anItem({ id: 'item-one' }) },
            { item: anItem({ id: 'item-two', title: 'Second' }) },
          ],
          events: [anEvent(), anEvent({ id: 'ev-2', entity: 'item-two' })],
        })
        assert.ok(both.ok, both.ok ? '' : both.error.message)

        const partial = await store.apply({
          txn: 't2',
          writes: [
            { item: anItem({ id: 'item-one', state: 'ready' }), ifVersion: 1 },
            { item: anItem({ id: 'item-two', state: 'ready' }), ifVersion: 99 },
          ],
          events: [],
        })
        assert.equal(partial.ok, false)
        const one = await store.get('item-one')
        assert.equal(one.ok && one.value?.state, 'draft', 'the first write must not have landed')
        assert.equal(one.ok && one.value?.version, 1)
      })
    })

    it('filters a list by state, type and sprint, and honours a limit', async () => {
      await withStore(async (store) => {
        await store.apply({
          txn: 't1',
          writes: [
            { item: anItem({ id: 'item-one', filed_at: '2026-09-01T10:00:00Z' }) },
            { item: anItem({ id: 'item-two', type: 'bug', severity: 'S2', repro_steps: 'x', found_in: 'dev', filed_at: '2026-09-02T10:00:00Z' }) },
            { item: anItem({ id: 'item-tri', state: 'ready', sprint_id: 'sprint-one', filed_at: '2026-10-01T10:00:00Z' }) },
          ],
          events: [],
        })
        const all = await store.list()
        assert.ok(all.ok)
        assert.deepEqual(all.value.map((i) => i.id), ['item-one', 'item-two', 'item-tri'])

        const ready = await store.list({ state: 'ready' })
        assert.deepEqual(ready.ok ? ready.value.map((i) => i.id) : [], ['item-tri'])

        const bugs = await store.list({ type: 'bug' })
        assert.deepEqual(bugs.ok ? bugs.value.map((i) => i.id) : [], ['item-two'])

        const sprint = await store.list({ sprint: 'sprint-one' })
        assert.deepEqual(sprint.ok ? sprint.value.map((i) => i.id) : [], ['item-tri'])

        const one = await store.list({ limit: 1 })
        assert.equal(one.ok && one.value.length, 1)
      })
    })

    it('serves summaries as the fields of the items list serves, in the same order', async () => {
      await withStore(async (store) => {
        await store.apply({
          txn: 't1',
          writes: [
            { item: anItem({ id: 'item-one', filed_at: '2026-09-01T10:00:00Z', due: '2026-09-30T00:00:00Z', description: 'prose a summary leaves out' }) },
            { item: anItem({ id: 'item-two', type: 'bug', severity: 'S2', repro_steps: 'x', found_in: 'dev', filed_at: '2026-09-02T10:00:00Z' }) },
            { item: anItem({ id: 'item-tri', state: 'ready', sprint_id: 'sprint-one', priority: 2, points: 3, filed_at: '2026-10-01T10:00:00Z' }) },
          ],
          events: [],
        })
        const items = await store.list()
        const summaries = await store.summaries()
        assert.ok(items.ok && summaries.ok)
        // Exactly the summary fields, each present only when the item carries it: a summary
        // that read `undefined` where the item has a value would sort or filter wrong silently.
        const projected = items.value.map((item) => Object.fromEntries(
          SUMMARY_FIELDS.flatMap((field) => (item[field] === undefined ? [] : [[field, item[field]]])),
        ))
        assert.deepEqual(summaries.value, projected)
        assert.ok(summaries.value.some((s) => s.due !== undefined && s.severity === undefined))
        assert.ok(summaries.value.some((s) => s.severity === 'S2'))
        assert.equal('description' in (summaries.value[0] as object), false)

        const ready = await store.summaries({ state: 'ready' })
        assert.deepEqual(ready.ok ? ready.value.map((i) => i.id) : [], ['item-tri'])
        const one = await store.summaries({ limit: 1 })
        assert.deepEqual(one.ok ? one.value.map((i) => i.id) : [], ['item-one'])
      })
    })

    it('reads events by entity and by time range, in instant order', async () => {
      await withStore(async (store) => {
        await store.apply({
          txn: 't1',
          writes: [{ item: anItem() }],
          events: [
            anEvent({ id: 'ev-2', at: '2026-09-02T10:00:00Z', op: 'transition' }),
            anEvent({ id: 'ev-1', at: '2026-09-01T10:00:00Z', op: 'file' }),
            anEvent({ id: 'ev-3', at: '2026-10-01T10:00:00Z', entity: 'item-two', op: 'file' }),
          ],
        })
        const all = await store.events()
        assert.ok(all.ok)
        assert.deepEqual(all.value.map((e) => e.id), ['ev-1', 'ev-2', 'ev-3'])

        const mine = await store.events({ entity: 'item-one' })
        assert.deepEqual(mine.ok ? mine.value.map((e) => e.id) : [], ['ev-1', 'ev-2'])

        const window = await store.events({ from: '2026-09-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })
        assert.deepEqual(window.ok ? window.value.map((e) => e.id) : [], ['ev-2'])
      })
    })

    it('refuses a record the grammar could not write back', async () => {
      await withStore(async (store) => {
        const refused = await store.apply({
          txn: 't1',
          writes: [{ item: anItem({ description: 'fine\n# a heading at column zero' }) }],
          events: [],
        })
        assert.equal(refused.ok, false)
        assert.match(refused.ok ? '' : refused.error.message, /may not start with #/)
      })
    })

    it('refuses an item the field dictionary refuses, before it reaches a file', async () => {
      await withStore(async (store) => {
        const refused = await store.apply({
          txn: 't1',
          writes: [{ item: anItem({ priority: 9 }) }],
          events: [],
        })
        assert.equal(refused.ok, false)
        assert.equal(refused.ok ? '' : refused.error.code, 'VALIDATION')
        const found = await store.get('item-one')
        assert.equal(found.ok && found.value, undefined)
      })
    })

    it('carries an unknown field key through a mutation', async () => {
      await withStore(async (store) => {
        const extra = new Map([['a_field_from_2027', 'kept']])
        await store.apply({ txn: 't1', writes: [{ item: anItem({ extra }) }], events: [] })
        const moved = await store.apply({
          txn: 't2',
          writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }],
          events: [],
        })
        assert.ok(moved.ok, moved.ok ? '' : moved.error.message)
        const found = await store.get('item-one')
        assert.equal(found.ok && found.value?.extra?.get('a_field_from_2027'), 'kept')
      })
    })
  })
}
