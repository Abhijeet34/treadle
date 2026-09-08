// SPDX-License-Identifier: Apache-2.0
// `ceremonies` at the command surface: the list, one record whole, and the three ways an id
// can miss. There is no `ceremony retro` in this build, so the record is written through the
// store the way T4b's command will write it, and everything below is the read path a caller
// gets today.
//
// The id namespace is the other half of this file. A retrospective's id is taken in the one
// namespace items and sprints share, because the event log is keyed by entity id alone, so a
// ceremony and an item under one id would share their trail.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import type { Ceremony } from '../../src/domain/index.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

const RETRO: Ceremony = {
  id: 'retro-sprint-31', title: 'Retro sprint-31', state: 'recorded',
  filed_at: '2026-09-18T16:00:00Z', version: 1, sprint_id: 'sprint-31',
  actions: ['auth-refresh'],
  well: 'The token refresh shipped without a hotfix.',
  badly: 'Two stories carried for the third sprint running.',
}

describe('ceremonies reads the retrospectives the store holds', () => {
  let demo: Demo
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root, env: { TREADLE_ACTOR: 'dana' } })

  before(async () => {
    demo = await aDemoWorkspace()
    const written = await demo.store.apply({ txn: 'txn-retro', writes: [], ceremonies: [{ ceremony: RETRO }], events: [] })
    assert.equal(written.ok, true, written.ok ? '' : written.error.message)
  })
  after(async () => { await demo.dispose() })

  it('lists one row per retrospective, with the sprint and the action count', async () => {
    const run = await cli(['ceremonies'])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /^~ceremonies 1 1$/m)
    assert.match(run.out, /^#id filed sprint actions "title$/m)
    assert.match(run.out, /^retro-sprint-31 2026-09-18T16:00:00Z sprint-31 1 Retro sprint-31$/m)
  })

  it('prints one record whole, prose and actions included', async () => {
    const run = await cli(['ceremonies', 'retro-sprint-31'])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /^ceremony retro-sprint-31$/m)
    assert.match(run.out, /^state recorded$/m)
    assert.match(run.out, /^sprint sprint-31$/m)
    assert.match(run.out, /^actions auth-refresh$/m)
    assert.match(run.out, /The token refresh shipped without a hotfix\./)
    assert.match(run.out, /Two stories carried for the third sprint running\./)
  })

  it('says an empty workspace holds none, rather than printing an empty table alone', async () => {
    const empty = await aDemoWorkspace()
    try {
      const run = await runCli(['ceremonies'], { cwd: empty.root, env: { TREADLE_ACTOR: 'dana' } })
      assert.equal(run.code, 0, run.err)
      assert.match(run.out, /^none no ceremony has been recorded here$/m)
      assert.match(run.out, /^~ceremonies 0 0$/m)
    } finally {
      await empty.dispose()
    }
  })

  it('routes an item id and a sprint id to the read that serves them', async () => {
    const item = await cli(['ceremonies', 'auth-refresh'])
    assert.equal(item.code, 5, item.err)
    assert.match(item.err, /^"cause auth-refresh is an item here, not a ceremony, and ceremonies takes a ceremony id$/m)
    assert.match(item.err, /^fix treadle show auth-refresh$/m)

    const missing = await cli(['ceremonies', 'retro-sprint-32'])
    assert.equal(missing.code, 5, missing.err)
    assert.match(missing.err, /^"cause retro-sprint-32 is no ceremony here; this workspace holds 1 ceremony$/m)
    assert.match(missing.err, /^near retro-sprint-31$/m)
  })

  it('routes a ceremony id away from the reads that do not serve it', async () => {
    const shown = await cli(['show', 'retro-sprint-31'])
    assert.equal(shown.code, 5, shown.err)
    assert.match(shown.err, /^"cause retro-sprint-31 is a ceremony here, not an item, and show takes an item id$/m)
    assert.match(shown.err, /^fix treadle ceremonies retro-sprint-31$/m)

    const sprint = await cli(['sprints', 'retro-sprint-31'])
    assert.equal(sprint.code, 5, sprint.err)
    assert.match(sprint.err, /^"cause retro-sprint-31 is a ceremony here, not a sprint, and sprints takes a sprint id$/m)
  })

  it('refuses to file an item or open a sprint under a ceremony id', async () => {
    const filed = await cli(['file', 'task', 'Something else', '--id', 'retro-sprint-31'])
    assert.equal(filed.code, 2, filed.err)
    assert.match(filed.err, /^rule I5$/m)
    assert.match(filed.err, /is a ceremony here, and an id names one thing: an item cannot share a ceremony's id$/m)

    const opened = await cli(['sprint', 'open', 'Another sprint', '--id', 'retro-sprint-31', '--end', '2099-01-01'])
    assert.equal(opened.code, 2, opened.err)
    assert.match(opened.err, /is a ceremony here, and an id names one thing: a sprint cannot share a ceremony's id$/m)
  })
})
