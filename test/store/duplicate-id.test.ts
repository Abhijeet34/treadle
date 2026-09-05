// SPDX-License-Identifier: Apache-2.0
// The store half of S3. The index already refuses to serve a duplicated id and records the
// clash as a finding; what was missing is that the write path never read that finding, so
// `apply` picked the first record in document order and wrote it. Reading a duplicated id is
// ambiguous, and writing one is worse: it picks a copy on the caller's behalf and says
// nothing, which is the exact behaviour the prior-art teardown recorded as a risk.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

/** Appends a second record carrying an id the shard already holds, as a hand edit would. */
async function duplicate(root: string, shard: string, id: string, title: string): Promise<void> {
  const file = path.join(root, shard)
  const copy = ['', `# ${id}: ${title}`, '', 'type: task', 'state: draft',
    'filed_at: 2026-09-01T10:00:00Z', 'version: 1', ''].join('\n')
  await writeFile(file, `${await readFile(file, 'utf8')}${copy}`)
}

describe('a record whose id appears twice', () => {
  it('refuses the write by name rather than picking the first match', async () => {
    const workspace = await aWorkspace()
    try {
      const applied = await workspace.store.apply({
        txn: 't1', writes: [{ item: anItem() }], events: [],
      })
      assert.ok(applied.ok)
      await duplicate(workspace.root, 'items/2026-09.md', 'item-one', 'A first task, the copy')

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.ok(findings.value.some((finding) => finding.rule === 'S3'), 'the index quarantines the copy')

      const shard = path.join(workspace.root, 'items/2026-09.md')
      const before = await readFile(shard, 'utf8')
      const refused = await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ state: 'ready' }), ifVersion: 1 }],
        events: [],
      })
      assert.equal(refused.ok, false)
      assert.equal(refused.ok ? '' : refused.error.code, 'CONFLICT')
      assert.equal(refused.ok ? '' : refused.error.rule, 'S3')
      assert.match(refused.ok ? '' : refused.error.message, /item-one/)
      assert.equal(await readFile(shard, 'utf8'), before)
    } finally {
      await workspace.dispose()
    }
  })

  it('still writes every other record in the same shard', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem() }, { item: anItem({ id: 'item-two', title: 'A second task' }) }],
        events: [],
      })
      await duplicate(workspace.root, 'items/2026-09.md', 'item-one', 'A first task, the copy')

      const applied = await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ id: 'item-two', title: 'A second task', state: 'ready' }), ifVersion: 1 }],
        events: [],
      })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
      const found = await workspace.store.get('item-two')
      assert.equal(found.ok && found.value?.state, 'ready')
    } finally {
      await workspace.dispose()
    }
  })
})

describe('an id that names more than one record in one file', () => {
  it('serves neither copy, rather than picking the first in document order', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      await duplicate(workspace.root, 'items/2026-09.md', 'item-one', 'A first task, the copy')

      const listed = await workspace.store.list()
      assert.ok(listed.ok)
      assert.equal(
        listed.value.some((item) => item.id === 'item-one'), false,
        'a duplicated id was resolved to one record by document order',
      )
      const found = await workspace.store.get('item-one')
      assert.ok(found.ok)
      assert.equal(found.value, undefined, 'get resolved a duplicated id to one record')

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const s3 = findings.value.filter((f) => f.rule === 'S3' && f.id === 'item-one')
      assert.equal(s3.length, 2, `both copies name themselves: ${JSON.stringify(findings.value)}`)
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a record the parser quarantined', () => {
  it('refuses a write for its id rather than filing a second copy under it', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      const shard = path.join(workspace.root, 'items/2026-09.md')
      // A hand edit that breaks the record's grammar rather than its fields: the record is
      // quarantined, so the write path's scan over record chunks finds nothing for the id.
      await writeFile(shard, (await readFile(shard, 'utf8')).replace('type: task', 'type task no colon'))

      const refused = await workspace.store.apply({ txn: 't2', writes: [{ item: anItem() }], events: [] })
      assert.equal(refused.ok, false, 'a create landed a second record under an id the store already holds')
      assert.match(refused.ok ? '' : refused.error.message, /item-one/)

      const after = await readFile(shard, 'utf8')
      assert.equal((after.match(/^# item-one:/gm) ?? []).length, 1, 'the store wrote the duplicate it refuses to read')
    } finally {
      await workspace.dispose()
    }
  })
})
