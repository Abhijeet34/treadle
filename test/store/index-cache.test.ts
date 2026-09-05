// SPDX-License-Identifier: Apache-2.0
// Decision D1: the committed files are the authority and the index is a cache whose
// deletion is always safe. That is a claim about an arbitrary moment, so the test deletes
// the whole index directory between reads, between a write and the read that follows it,
// and in a loop, and asserts the answers never move.

import assert from 'node:assert/strict'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'
import { renderEvent } from '../../src/adapters/store/index.ts'
import type { Store, StoreEvent } from '../../src/application/ports/store.ts'

const DELETIONS = 10

async function snapshot(store: Store): Promise<string> {
  const items = await store.list()
  const events = await store.events()
  const findings = await store.findings()
  assert.ok(items.ok && events.ok && findings.ok)
  return JSON.stringify({
    items: items.value.map((i) => ({ ...i, extra: [...(i.extra ?? [])] })),
    events: events.value,
    findings: findings.value,
  })
}

describe('the index is a cache and deleting it is always harmless', () => {
  it(`gives the same answers across ${DELETIONS} deletions`, async () => {
    const workspace = await aWorkspace()
    const index = path.join(workspace.root, '.index')
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [
          { item: anItem({ id: 'item-one' }) },
          { item: anItem({ id: 'item-two', state: 'ready', filed_at: '2026-10-02T10:00:00Z' }) },
        ],
        events: [anEvent(), anEvent({ id: 'ev-2', entity: 'item-two', at: '2026-10-02T10:00:00Z' })],
      })
      const reference = await snapshot(workspace.store)

      for (let i = 0; i < DELETIONS; i += 1) {
        await rm(index, { recursive: true, force: true })
        assert.equal(await snapshot(workspace.store), reference, `answers moved after deletion ${i + 1}`)
      }
      assert.ok(await stat(path.join(index, 'index.sqlite')), 'the index rebuilds itself')
    } finally {
      await workspace.dispose()
    }
  })

  it('serves a write that landed while the index was deleted underneath it', async () => {
    const workspace = await aWorkspace()
    const index = path.join(workspace.root, '.index')
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }],
        events: [anEvent({ id: 'ev-2', op: 'transition' })],
      })
      await rm(index, { recursive: true, force: true })

      const found = await workspace.store.get('item-one')
      assert.equal(found.ok && found.value?.state, 'ready')
      assert.equal(found.ok && found.value?.version, 2)
      const events = await workspace.store.events()
      assert.deepEqual(events.ok ? events.value.map((e) => e.id) : [], ['ev-1', 'ev-2'])
    } finally {
      await workspace.dispose()
    }
  })

  it('re-reads a file whose bytes changed behind the index, never the cached row', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      assert.equal((await workspace.store.get('item-one')).ok, true)

      const shard = path.join(workspace.root, 'items/2026-09.md')
      await writeFile(shard, (await readFile(shard, 'utf8')).replace('A first task', 'Edited by hand'))
      const found = await workspace.store.get('item-one')
      assert.equal(found.ok && found.value?.title, 'Edited by hand')
    } finally {
      await workspace.dispose()
    }
  })

  it('indexes an appended event without re-reading the whole log', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      await workspace.store.events()
      await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }],
        events: [anEvent({ id: 'ev-2', at: '2026-09-01T11:00:00Z', op: 'transition' })],
      })
      const events = await workspace.store.events()
      assert.deepEqual(events.ok ? events.value.map((e) => e.id) : [], ['ev-1', 'ev-2'])
    } finally {
      await workspace.dispose()
    }
  })

  it('returns an event byte-identical to the log line, every key of it', async () => {
    // The index carries six of an event's keys as columns and the remainder as JSON, so what
    // has to hold is that the two halves rejoin into the line the log holds: the optional
    // keys DR3 names, a structured before and after, and a key DR3 does not name at all.
    const workspace = await aWorkspace()
    try {
      const event = anEvent({
        id: 'ev-whole', entity: 'item-one', op: 'transition',
        before: { state: 'draft' }, after: { state: 'ready' },
        guards: ['G1', 'G2'], reason: 'ready for pickup', outcome: 'accepted',
        cmd: 'treadle transition item-one ready',
      })
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem({ id: 'item-one' }) }], events: [event] })

      // A key the contract does not name reaches the log only from a hand edit or a newer
      // writer, which is the case the remainder has to carry rather than quietly drop.
      const log = path.join(workspace.root, 'events/2026-09.jsonl')
      await writeFile(log, `${(await readFile(log, 'utf8')).trim()}\n{"id":"ev-hand","at":"2026-09-02T10:00:00Z","actor":"abhijeet","actor_kind":"person","entity_kind":"work_item","entity":"item-one","op":"note","dialect":"a key the contract does not name","txn":"txn-2"}\n`)

      const lines = (await readFile(log, 'utf8')).trim().split('\n')
      const read = await workspace.store.events({ entity: 'item-one' })
      assert.ok(read.ok)
      assert.equal(read.value.length, 2)
      assert.equal(renderEvent(read.value[0] as StoreEvent).trim(), lines[0])
      assert.equal((read.value[1] as unknown as Record<string, unknown>)['dialect'], 'a key the contract does not name')
    } finally {
      await workspace.dispose()
    }
  })

  it('reports a duplicate id rather than silently serving the first match', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [
          { item: anItem({ id: 'item-one', filed_at: '2026-09-01T10:00:00Z' }) },
          { item: anItem({ id: 'item-two', filed_at: '2026-10-01T10:00:00Z' }) },
        ],
        events: [],
      })
      const october = path.join(workspace.root, 'items/2026-10.md')
      await writeFile(october, (await readFile(october, 'utf8')).replace('# item-two:', '# item-one:'))

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const clash = findings.value.find((f) => f.rule === 'S3')
      assert.ok(clash, 'expected an S3 duplicate-id finding')
      assert.match(clash.reason, /already a record in this store/)
    } finally {
      await workspace.dispose()
    }
  })
})
