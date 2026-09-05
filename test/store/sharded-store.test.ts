// SPDX-License-Identifier: Apache-2.0
// The sharded store against the shared seam suite, plus what only a store with files can be
// asked: the layout on disk, durability across a reopen, and per-record isolation on load.

import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { ShardedStore, renderHeader, renderRecord } from '../../src/adapters/store/index.ts'
import { aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'
import { storeConformance } from './conformance.ts'

storeConformance('sharded markdown store', async () => {
  const workspace = await aWorkspace()
  return { store: workspace.store, dispose: () => workspace.dispose() }
})

describe('the sharded store on disk', () => {
  it('files a record into the month shard of its filed_at, and nowhere else', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [
          { item: anItem({ id: 'item-one', filed_at: '2026-09-01T10:00:00Z' }) },
          { item: anItem({ id: 'item-two', filed_at: '2026-10-15T10:00:00Z' }) },
        ],
        events: [anEvent({ at: '2026-09-01T10:00:00Z' })],
      })
      assert.deepEqual((await readdir(path.join(workspace.root, 'items'))).sort(), ['2026-09.md', '2026-10.md'])
      assert.deepEqual(await readdir(path.join(workspace.root, 'events')), ['2026-09.jsonl'])

      const shard = await readFile(path.join(workspace.root, 'items/2026-09.md'), 'utf8')
      assert.match(shard, /^schema: 1\n/)
      assert.match(shard, /^# item-one: A first task$/m)
      assert.match(shard, /^state: draft$/m)
      assert.doesNotMatch(shard, /item-two/)
    } finally {
      await workspace.dispose()
    }
  })

  it('writes the event log as one JSON object per line in the fixed key order', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      const log = await readFile(path.join(workspace.root, 'events/2026-09.jsonl'), 'utf8')
      assert.equal(log, '{"id":"ev-1","at":"2026-09-01T10:00:00Z","actor":"abhijeet","actor_kind":"person","entity_kind":"work_item","entity":"item-one","op":"file","txn":"txn-1"}\n')
    } finally {
      await workspace.dispose()
    }
  })

  it('serves the same answers from a second process-level open', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      const reopened = new ShardedStore(workspace.root)
      const found = await reopened.get('item-one')
      assert.ok(found.ok)
      assert.equal(found.value?.title, 'A first task')
      await reopened.close()
    } finally {
      await workspace.dispose()
    }
  })

  it('leaves neither a lock nor a temp file behind', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      const names = await readdir(workspace.root)
      assert.equal(names.includes('.lock'), false)
      assert.deepEqual((await readdir(path.join(workspace.root, 'items'))).filter((n) => n.startsWith('.')), [])
    } finally {
      await workspace.dispose()
    }
  })

  it('reads a hand edit that never went through a write', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      const shard = path.join(workspace.root, 'items/2026-09.md')
      await writeFile(shard, (await readFile(shard, 'utf8')).replace('state: draft', 'state: ready'))
      const found = await workspace.store.get('item-one')
      assert.equal(found.ok && found.value?.state, 'ready')
    } finally {
      await workspace.dispose()
    }
  })

  it('quarantines one corrupt record on load and serves every other', async () => {
    const workspace = await aWorkspace()
    try {
      const good = renderRecord({ id: 'item-one', title: 'Good', fields: new Map([
        ['type', 'task'], ['state', 'draft'], ['filed_at', '2026-09-01T10:00:00Z'], ['version', '1'],
      ]), sections: [] })
      const bad = '# Renamed Heading: broken\n\ntype: task\n\n'
      await writeFile(path.join(workspace.root, 'items/2026-09.md'), `${renderHeader(1)}${good}${bad}${good.replace('item-one', 'item-two')}`)

      const all = await workspace.store.list()
      assert.deepEqual(all.ok ? all.value.map((i) => i.id) : [], ['item-one', 'item-two'])

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.equal(findings.value.length, 1)
      assert.equal(findings.value[0]?.rule, 'S1')
      assert.equal(findings.value[0]?.file, 'items/2026-09.md')
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses to read a file whose schema is newer than this tool', async () => {
    const workspace = await aWorkspace()
    try {
      await writeFile(path.join(workspace.root, 'items/2026-09.md'), 'schema: 99\n\n')
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.equal(findings.value[0]?.rule, 'S8')
      assert.match(findings.value[0]?.reason ?? '', /schema 99 and this tool understands 1/)
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses to write a file whose schema is older, and names migrate', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      const shard = path.join(workspace.root, 'items/2026-09.md')
      await writeFile(shard, (await readFile(shard, 'utf8')).replace('schema: 1', 'schema: 0'))
      const refused = await workspace.store.apply({
        txn: 't2', writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }], events: [],
      })
      assert.equal(refused.ok, false)
      assert.equal(refused.ok ? '' : refused.error.code, 'SCHEMA_OLDER')
      assert.match(refused.ok ? '' : refused.error.message, /run migrate/)
    } finally {
      await workspace.dispose()
    }
  })

  it('reports a hierarchy cycle a hand edit put in, rather than recursing into it', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [
          { item: anItem({ id: 'item-one', parent_id: 'item-two' }) },
          { item: anItem({ id: 'item-two', parent_id: 'item-one' }) },
        ],
        events: [],
      })
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const cycle = findings.value.find((f) => f.rule === 'S12')
      assert.ok(cycle, 'expected an S12 hierarchy-cycle finding')
      assert.match(cycle.reason, /closes a cycle/)
    } finally {
      await workspace.dispose()
    }
  })

  it('re-reads the cycle verdict when a hand edit moves the edge, in either direction', async () => {
    // The verdict is cached in the index between commands, so what has to be proved is that
    // the cache is bound to the rows and not to the process: a second store on the same root
    // must see a cycle a hand edit added, and stop reporting one a hand edit removed.
    // The two records sit in different shards, so the edit re-indexes one file and the walk
    // above the edge it moved has to follow into the other file's rows to close the cycle.
    const workspace = await aWorkspace()
    const shard = path.join(workspace.root, 'items/2026-10.md')
    const s12 = async (store: ShardedStore): Promise<string | undefined> => {
      const found = await store.findings()
      assert.ok(found.ok)
      return found.value.find((f) => f.rule === 'S12')?.reason
    }
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [
          { item: anItem({ id: 'item-one', parent_id: 'item-two' }) },
          { item: anItem({ id: 'item-two', filed_at: '2026-10-15T10:00:00Z' }) },
        ],
        events: [],
      })
      assert.equal(await s12(workspace.store), undefined, 'a forest is not a cycle')

      const clean = await readFile(shard, 'utf8')
      await writeFile(shard, clean.replace('# item-two: A first task', '# item-two: A first task\nparent_id: item-one'))
      const reader = new ShardedStore(workspace.root)
      assert.match(await s12(reader) ?? '', /closes a cycle/, 'the added edge must be found')

      await writeFile(shard, clean)
      assert.equal(await s12(new ShardedStore(workspace.root)), undefined, 'the removed edge must clear')
      await reader.close()
    } finally {
      await workspace.dispose()
    }
  })

  it('creates the workspace layout git needs, and nothing else', async () => {
    const workspace = await aWorkspace()
    try {
      assert.equal(await readFile(path.join(workspace.root, '.gitignore'), 'utf8'), '.index/\n.lock\n')
      assert.equal(
        await readFile(path.join(workspace.root, '.gitattributes'), 'utf8'),
        'events/*.jsonl merge=union linguist-generated=true\n',
      )
      assert.equal((await stat(path.join(workspace.root, 'workspace.md'))).mode & 0o777, 0o644)
    } finally {
      await workspace.dispose()
    }
  })
})
