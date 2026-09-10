// SPDX-License-Identifier: Apache-2.0
// Resolving the store is a decision every command makes before it does anything (2.17
// rule 4), and the reference's measured failure was writing to a store other than the one
// the human was looking at. So resolution gets its own tests rather than riding on a write.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { defaultConfig, withConfigKey } from '../../src/domain/index.ts'
import { makeEvent } from '../../src/application/services/mutation.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { resolveStore } from '../../src/adapters/workspace.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

describe('resolving the store', () => {
  it('walks up to the nearest workspace.md and never creates one', async () => {
    const workspace = await aWorkspace()
    try {
      const deep = path.join(workspace.root, 'items', 'nested', 'deeper')
      await mkdir(deep, { recursive: true })
      assert.equal(await resolveStore(deep), workspace.root)
      assert.equal(await resolveStore(workspace.root), workspace.root)
    } finally {
      await workspace.dispose()
    }
  })

  it('returns nothing outside a workspace rather than inventing one', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'treadling-nowhere-'))
    const found = await resolveStore(empty)
    assert.equal(found === empty, false, 'a directory with no workspace.md is not a workspace')
  })

  it('refuses to open a directory that is not a workspace, naming the file it wanted', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'treadling-nowhere-'))
    const opened = await openWorkspace(empty)
    assert.equal(opened.ok, false)
    assert.match(opened.ok ? '' : opened.error.message, /workspace\.md is not there/)
  })

  it('refuses a workspace.md that carries no record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'treadling-hollow-'))
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
      // The identity carries the workspace record whole: its printed id and title, its
      // compare-and-set token, and the configuration every consumer reads off the view. A
      // workspace `init` just wrote has set no key, so the whole configuration is default.
      const identified = identity.ok ? identity.value : undefined
      assert.deepEqual(
        identified === undefined ? {} : { id: identified.id, name: identified.name, path: identified.path },
        { id: 'test-workspace', name: 'Test workspace', path: workspace.root },
      )
      assert.equal(identified?.version, 0, 'a workspace nothing has configured is at version 0')
      assert.deepEqual(identified?.config, defaultConfig())
      assert.deepEqual([...identified?.config.from ?? []], [], 'no key came from the file')
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

describe('the workspace record is written under compare-and-set', () => {
  it('refuses the second of two writes decided against the same version, naming who moved it', async () => {
    const workspace = await aWorkspace()
    try {
      const base = await workspace.store.identity()
      assert.ok(base.ok, base.ok ? '' : base.error.message)
      assert.equal(base.value.version, 0, 'a workspace nothing has configured is at version 0')

      const write = (txn: string, days: number) => workspace.store.apply({
        txn,
        writes: [],
        workspace: { config: withConfigKey(base.value.config, 'aging_days', days), ifVersion: base.value.version },
        events: [makeEvent({
          id: `e-${txn}`, at: '2026-09-08T09:00:00Z', actor: { id: 'dana', kind: 'human' },
          entity: base.value.id, entityKind: 'workspace', op: 'workspace.config',
          before: { aging_days: '0' }, after: { aging_days: String(days) }, txn, command: 'config',
        })],
      })

      const first = await write('twrite1', 5)
      assert.equal(first.ok, true, first.ok ? '' : first.error.message)

      // The second was decided against version 0 and the record is at 1. Both wrote the whole
      // record, so without the token the second would have dropped the first's key entirely.
      const second = await write('twrite2', 9)
      assert.equal(second.ok, false, 'a write decided against a stale version landed')
      assert.equal(second.ok ? '' : second.error.rule, 'S10')
      assert.match(second.ok ? '' : second.error.message, /is at version 1 and the write named 0; dana moved it at 2026-09-08T09:00:00Z in transaction twrite1/)

      const after = await workspace.store.identity()
      assert.equal(after.ok ? after.value.config.aging_days : -1, 5, 'the write that won is the one the record carries')
      assert.equal(after.ok ? after.value.version : -1, 1)
    } finally {
      await workspace.dispose()
    }
  })
})
