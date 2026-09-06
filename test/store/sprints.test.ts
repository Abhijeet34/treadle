// SPDX-License-Identifier: Apache-2.0
// The sprint file under the store's own rules: one `sprints.md` in the record grammar the
// shards use, indexed, fingerprinted and quarantined the same way, and written through the
// same journal as the shard a commit touches. ADR-0016 says why it is one file and not a
// month shard; this file holds that the one file behaves like every other record file.

import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { Sprint } from '../../src/domain/index.ts'
import { ShardedStore } from '../../src/adapters/store/index.ts'
import { readWorkspace } from '../../src/application/services/context.ts'
import { aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'

const SPRINT: Sprint = {
  id: 'sprint-31', title: 'Sprint 31', state: 'open', filed_at: '2026-09-06T09:00:00Z', version: 1,
  start: '2026-09-07', end: '2026-09-18', goal: 'Ship the token refresh',
}

describe('sprints are one record file beside the shards', () => {
  it('writes sprints.md in the record grammar, with the goal as a section, and reads it back whole', async () => {
    const workspace = await aWorkspace()
    try {
      const applied = await workspace.store.apply({ txn: 't1', writes: [], sprints: [{ sprint: SPRINT }], events: [] })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
      assert.deepEqual(applied.value.writes, [{ id: 'sprint-31', version: 1 }])

      const text = await readFile(path.join(workspace.root, 'sprints.md'), 'utf8')
      assert.equal(text, [
        'schema: 1', '', '# sprint-31: Sprint 31', '', 'type: sprint', 'state: open',
        'filed_at: 2026-09-06T09:00:00Z', 'version: 1', 'start: 2026-09-07', 'end: 2026-09-18', '',
        '## Goal', '', 'Ship the token refresh', '', '',
      ].join('\n'))

      const sprints = await workspace.store.sprints()
      assert.ok(sprints.ok)
      assert.deepEqual(sprints.value, [SPRINT])
    } finally {
      await workspace.dispose()
    }
  })

  it('serves a sprint and an item written in one transaction, or neither', async () => {
    const workspace = await aWorkspace()
    try {
      const both = await workspace.store.apply({
        txn: 't1', writes: [{ item: anItem({ sprint_id: 'sprint-31' }) }], sprints: [{ sprint: SPRINT }], events: [anEvent()],
      })
      assert.ok(both.ok, both.ok ? '' : both.error.message)
      const partial = await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ state: 'ready', sprint_id: 'sprint-31' }), ifVersion: 1 }],
        sprints: [{ sprint: { ...SPRINT, state: 'closed', closed_at: '2026-09-19T09:00:00Z' }, ifVersion: 7 }],
        events: [],
      })
      assert.equal(partial.ok, false)
      assert.equal(partial.ok ? '' : partial.error.rule, 'S10')
      const item = await workspace.store.get('item-one')
      assert.equal(item.ok && item.value?.state, 'draft', 'the item write landed without the sprint write')
      const sprints = await workspace.store.sprints()
      assert.equal(sprints.ok && sprints.value[0]?.state, 'open')
    } finally {
      await workspace.dispose()
    }
  })

  it('carries an unknown field and an unknown section through a close', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [], sprints: [{ sprint: SPRINT }], events: [] })
      const file = path.join(workspace.root, 'sprints.md')
      const grown = (await readFile(file, 'utf8'))
        .replace('end: 2026-09-18\n', 'end: 2026-09-18\ncapacity: 40\n')
        .concat('## Retro\n\nprose a later version understands\n')
      await writeFile(file, grown)

      const closed = await workspace.store.apply({
        txn: 't2', writes: [], events: [],
        sprints: [{ sprint: { ...SPRINT, state: 'closed', closed_at: '2026-09-19T09:00:00Z', carried: ['item-one'] }, ifVersion: 1 }],
      })
      assert.ok(closed.ok, closed.ok ? '' : closed.error.message)
      const after = await readFile(file, 'utf8')
      assert.match(after, /^carried: item-one\ncapacity: 40$/m, 'the unknown key follows the known ones')
      assert.match(after, /^## Retro$/m)
      const sprints = await workspace.store.sprints()
      assert.equal(sprints.ok && sprints.value[0]?.extra?.get('capacity'), '40')
    } finally {
      await workspace.dispose()
    }
  })

  it('quarantines a sprint record the grammar refuses and hides it from every read, like an item', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], sprints: [{ sprint: SPRINT }], events: [] })
      const file = path.join(workspace.root, 'sprints.md')
      await writeFile(file, (await readFile(file, 'utf8')).replace('end: 2026-09-18', 'end: 2026-09-31'))

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.deepEqual(findings.value.map((f) => [f.file, f.rule, f.id]), [['sprints.md', 'I1', 'sprint-31']])
      const sprints = await workspace.store.sprints()
      assert.deepEqual(sprints.ok ? sprints.value : 'refused', [])

      const view = await readWorkspace(workspace.store)
      assert.equal(view.ok, false, 'a view over a store hiding a sprint is not whole')
      assert.match(view.ok ? '' : view.error.message, /sprints\.md line 3: sprint-31: end must be a calendar date/)
    } finally {
      await workspace.dispose()
    }
  })

  it('drops the rows when the file is removed by hand, and rebuilds them after the index is deleted', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [], sprints: [{ sprint: SPRINT }], events: [] })
      assert.equal((await workspace.store.sprints()).ok && ((await workspace.store.sprints()) as { value: readonly Sprint[] }).value.length, 1)

      await rm(path.join(workspace.root, '.index'), { recursive: true, force: true })
      const rebuilt = await workspace.store.sprints()
      assert.deepEqual(rebuilt.ok ? rebuilt.value : 'refused', [SPRINT])

      await rm(path.join(workspace.root, 'sprints.md'))
      const gone = await workspace.store.sprints()
      assert.deepEqual(gone.ok ? gone.value : 'refused', [])
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses a write to a sprint another process moved, naming both versions', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [], sprints: [{ sprint: SPRINT }], events: [] })
      const other = new ShardedStore(workspace.root)
      const moved = await other.apply({ txn: 't2', writes: [], sprints: [{ sprint: { ...SPRINT, title: 'Sprint 31, renamed' }, ifVersion: 1 }], events: [] })
      await other.close()
      assert.ok(moved.ok, moved.ok ? '' : moved.error.message)

      const stale = await workspace.store.apply({ txn: 't3', writes: [], sprints: [{ sprint: { ...SPRINT, end: '2026-09-25' }, ifVersion: 1 }], events: [] })
      assert.equal(stale.ok, false)
      if (stale.ok) return
      assert.equal(stale.error.rule, 'S10')
      assert.deepEqual([stale.error.details?.['expected'], stale.error.details?.['actual']], [1, 2])
    } finally {
      await workspace.dispose()
    }
  })
})
