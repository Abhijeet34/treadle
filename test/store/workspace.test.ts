// SPDX-License-Identifier: Apache-2.0
// Resolving the store is a decision every command makes before it does anything (2.17
// rule 4), and the reference's measured failure was writing to a store other than the one
// the human was looking at. So resolution gets its own tests rather than riding on a write.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { openWorkspace, resolveWorkspace } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

describe('resolving the store', () => {
  it('walks up to the nearest workspace.md and never creates one', async () => {
    const workspace = await aWorkspace()
    try {
      const deep = path.join(workspace.root, 'items', 'nested', 'deeper')
      await mkdir(deep, { recursive: true })
      assert.equal(await resolveWorkspace(deep), workspace.root)
      assert.equal(await resolveWorkspace(workspace.root), workspace.root)
    } finally {
      await workspace.dispose()
    }
  })

  it('returns nothing outside a workspace rather than inventing one', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'treadle-nowhere-'))
    const found = await resolveWorkspace(empty)
    assert.equal(found === empty, false, 'a directory with no workspace.md is not a workspace')
  })

  it('refuses to open a directory that is not a workspace, naming the file it wanted', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'treadle-nowhere-'))
    const opened = await openWorkspace(empty)
    assert.equal(opened.ok, false)
    assert.match(opened.ok ? '' : opened.error.message, /workspace\.md is not there/)
  })

  it('refuses a workspace.md that carries no record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'treadle-hollow-'))
    await writeFile(path.join(root, 'workspace.md'), 'schema: 1\n\n')
    const opened = await openWorkspace(root)
    assert.equal(opened.ok, false)
    assert.equal(opened.ok ? '' : opened.error.rule, 'S1')
  })

  it('prints one identity, and it is the workspace record\'s id and title', async () => {
    const workspace = await aWorkspace()
    try {
      const opened = await openWorkspace(workspace.root)
      assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
      const identity = await opened.value.identity()
      assert.deepEqual(identity.ok ? identity.value : {}, {
        id: 'test-workspace', name: 'Test workspace', path: workspace.root,
      })
      await opened.value.close()
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a record never moves between shards', () => {
  it('refuses a create whose id already lives in another month', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem({ id: 'item-one', filed_at: '2026-09-01T10:00:00Z' }) }],
        events: [],
      })
      const elsewhere = await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ id: 'item-one', filed_at: '2026-10-01T10:00:00Z' }) }],
        events: [],
      })
      assert.equal(elsewhere.ok, false)
      assert.equal(elsewhere.ok ? '' : elsewhere.error.rule, 'S3')
      assert.match(elsewhere.ok ? '' : elsewhere.error.message, /already a record in items\/2026-09\.md/)
    } finally {
      await workspace.dispose()
    }
  })
})
