// SPDX-License-Identifier: Apache-2.0
// The log keeps the workspace's own events, and `history` reads them under both scopes.
//
// It read them as an item's: the workspace id is in no item map, so `carried` said no record
// carried it and both scopes printed the note that names a record the store no longer holds,
// about the one record every command reads first. `workspace.init` records `schema` as a
// number, which no field dictionary knows and no string rule prints, so the row read
// `unknown=1`: a key was there and nothing else was said about it.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { initWorkspace } from '../../src/adapters/workspace.ts'
import { setConfig } from '../../src/application/services/config.ts'
import { history } from '../../src/application/services/history.ts'
import type { Actor } from '../../src/application/services/mutation.ts'
import type { Store } from '../../src/application/ports/store.ts'

const ACTOR: Actor = { id: 'priya', kind: 'human' }
const NOW = '2026-09-05T18:00:00Z'

type Rows = { readonly rows: readonly Record<string, string>[] }

describe('history over the workspace record', () => {
  let parent: string
  let store: Store
  let workspace: string
  let txn: string

  before(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'treadle-ws-history-'))
    const root = path.join(parent, 'platform', '.work')
    const ids = sequentialIds()
    const clock = fixedClock(NOW)
    await initWorkspace(clock, ids, { at: root, name: 'platform', actor: ACTOR })
    const opened = await openWorkspace(root)
    assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
    store = opened.value
    const set = await setConfig(targetFor(store, 'apply'), clock, ids, {
      key: 'review_step', value: 'story, bug', actor: ACTOR,
    })
    assert.equal(set.ok, true, JSON.stringify(set.data))
    workspace = set.workspace as string
    txn = set.txn as string
  })

  after(async () => {
    await store.close()
    await rm(parent, { recursive: true, force: true })
  })

  it('does not say the workspace record is no longer here, under either scope', async () => {
    const scoped = await history(store, { scope: { kind: 'item', id: workspace }, limit: 50 })
    assert.equal(scoped.ok, true)
    assert.equal(scoped.data['note'], undefined, JSON.stringify(scoped.data['note']))

    const transaction = await history(store, { scope: { kind: 'txn', txn }, limit: 50 })
    assert.equal(transaction.ok, true)
    assert.equal(transaction.data['note'], undefined, JSON.stringify(transaction.data['note']))
  })

  it('names schema on the init row rather than counting it as an unknown key', async () => {
    const log = await history(store, { scope: { kind: 'item', id: workspace }, limit: 50 })
    const rows = (log.data['events'] as Rows).rows
    const init = rows.find((row) => row['op'] === 'workspace.init')
    assert.ok(init !== undefined, 'the init event is in the log')
    assert.equal(init['what'], 'schema=1')
  })

  it('still says a record is no longer here for an id the store really has lost', async () => {
    const gone = await history(store, { scope: { kind: 'item', id: workspace.replace(/.$/, 'x') }, limit: 50 })
    assert.equal(gone.ok, false)
    assert.equal(gone.code, 'NOT_FOUND')
  })
})
