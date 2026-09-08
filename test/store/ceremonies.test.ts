// SPDX-License-Identifier: Apache-2.0
// The third record kind under the store's own rules: `ceremonies/YYYY-MM.md` in the record
// grammar the item shards use, month-sharded by `filed_at`, indexed, fingerprinted and
// quarantined the same way, and written through the same journal.
//
// ADR-0028 says why a retrospective is a record kind rather than an eighth work-item type,
// and why it is the only ceremony that gets one. This file holds that the layout behaves
// like every other record file, including the three properties a new file kind is easy to
// get wrong on: a cross-shard duplicate is a clash the primary key sees, a damaged record
// hides content so no command answers over the store, and a rebuilt index is byte-identical.

import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { Ceremony } from '../../src/domain/index.ts'
import { ShardedStore } from '../../src/adapters/store/index.ts'
import { readWorkspace } from '../../src/application/services/context.ts'
import { aWorkspace, anItem, deleteIndex } from '../helpers/store-fixtures.ts'

const RETRO: Ceremony = {
  id: 'retro-sprint-31', title: 'Retro sprint-31', state: 'recorded',
  filed_at: '2026-09-18T16:00:00Z', version: 1, sprint_id: 'sprint-31',
  actions: ['carry-over-chore'],
  well: 'The token refresh shipped without a hotfix.',
  badly: 'Two stories carried for the third sprint running.',
}

/** The chore the retrospective names, which has to exist before the record may name it. */
const CHORE = anItem({ id: 'carry-over-chore', title: 'Split the carried stories' })

describe('a retrospective is a record in the month-sharded ceremonies layout', () => {
  it('writes ceremonies/2026-09.md in the record grammar and reads it back whole', async () => {
    const workspace = await aWorkspace()
    try {
      const applied = await workspace.store.apply({
        txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [],
      })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
      assert.deepEqual(applied.value.writes, [
        { id: 'carry-over-chore', version: 1 }, { id: 'retro-sprint-31', version: 1 },
      ])

      const text = await readFile(path.join(workspace.root, 'ceremonies', '2026-09.md'), 'utf8')
      assert.equal(text, [
        'schema: 1', '', '# retro-sprint-31: Retro sprint-31', '', 'type: retro', 'state: recorded',
        'filed_at: 2026-09-18T16:00:00Z', 'version: 1', 'sprint_id: sprint-31', 'actions: carry-over-chore', '',
        '## Went well', '', 'The token refresh shipped without a hotfix.', '',
        '## Went badly', '', 'Two stories carried for the third sprint running.', '', '',
      ].join('\n'))

      const ceremonies = await workspace.store.ceremonies()
      assert.ok(ceremonies.ok)
      assert.deepEqual(ceremonies.value, [RETRO])
    } finally {
      await workspace.dispose()
    }
  })

  it('shards by the month of filed_at, so two retrospectives land in two files', async () => {
    const workspace = await aWorkspace()
    try {
      const october: Ceremony = { ...RETRO, id: 'retro-sprint-32', title: 'Retro sprint-32', filed_at: '2026-10-02T16:00:00Z' }
      const applied = await workspace.store.apply({
        txn: 't1', writes: [{ item: CHORE }],
        ceremonies: [{ ceremony: RETRO }, { ceremony: october }], events: [],
      })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
      assert.deepEqual((await readdir(path.join(workspace.root, 'ceremonies'))).sort(), ['2026-09.md', '2026-10.md'])
      const ceremonies = await workspace.store.ceremonies()
      assert.deepEqual(ceremonies.ok ? ceremonies.value.map((c) => c.id) : 'refused', ['retro-sprint-31', 'retro-sprint-32'])
    } finally {
      await workspace.dispose()
    }
  })

  it('carries an unknown field and an unknown section through a rewrite', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      const file = path.join(workspace.root, 'ceremonies', '2026-09.md')
      const grown = (await readFile(file, 'utf8'))
        .replace('actions: carry-over-chore\n', 'actions: carry-over-chore\nfacilitator: kim\n')
        .concat('## Attendees\n\na list a later version understands\n')
      await writeFile(file, grown)

      const again = await workspace.store.apply({
        txn: 't2', writes: [], events: [],
        ceremonies: [{ ceremony: { ...RETRO, title: 'Retro sprint-31, renamed' }, ifVersion: 1 }],
      })
      assert.ok(again.ok, again.ok ? '' : again.error.message)
      const after = await readFile(file, 'utf8')
      assert.match(after, /^actions: carry-over-chore\nfacilitator: kim$/m, 'the unknown key follows the known ones')
      assert.match(after, /^## Attendees$/m)
      const ceremonies = await workspace.store.ceremonies()
      assert.equal(ceremonies.ok && ceremonies.value[0]?.extra?.get('facilitator'), 'kim')
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses a write to a retrospective another process moved, naming both versions', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      const other = new ShardedStore(workspace.root)
      const moved = await other.apply({
        txn: 't2', writes: [], ceremonies: [{ ceremony: { ...RETRO, title: 'Retro sprint-31, renamed' }, ifVersion: 1 }], events: [],
      })
      await other.close()
      assert.ok(moved.ok, moved.ok ? '' : moved.error.message)

      const stale = await workspace.store.apply({
        txn: 't3', writes: [], ceremonies: [{ ceremony: { ...RETRO, well: 'something else' }, ifVersion: 1 }], events: [],
      })
      assert.equal(stale.ok, false)
      if (stale.ok) return
      assert.equal(stale.error.rule, 'S10')
      assert.deepEqual([stale.error.details?.['expected'], stale.error.details?.['actual']], [1, 2])
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses a retrospective naming an action nothing holds, and writes nothing', async () => {
    const workspace = await aWorkspace()
    try {
      const refused = await workspace.store.apply({
        txn: 't1', writes: [], ceremonies: [{ ceremony: RETRO }], events: [],
      })
      assert.equal(refused.ok, false)
      if (refused.ok) return
      assert.equal(refused.error.rule, 'S10')
      assert.equal(refused.error.message,
        'carry-over-chore is not in the store, so retro-sprint-31 cannot name it in its action list; retry so the decision reads what is there now')
      const ceremonies = await workspace.store.ceremonies()
      assert.deepEqual(ceremonies.ok ? ceremonies.value : 'refused', [])
    } finally {
      await workspace.dispose()
    }
  })

  it('allows a rewrite of a retrospective whose stored action a hand edit already removed', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      // The chore leaves by hand, which is exactly the `H32` state `doctor` reports. A write
      // back to the record that already names it must not be refused, because the remedy for
      // that finding is itself a write to that record (ADR-0025's reasoning for `H30`).
      const shard = path.join(workspace.root, 'items', '2026-09.md')
      await writeFile(shard, 'schema: 1\n')
      const again = await workspace.store.apply({
        txn: 't2', writes: [], events: [],
        ceremonies: [{ ceremony: { ...RETRO, badly: 'the carry-over is still not fixed' }, ifVersion: 1 }],
      })
      assert.ok(again.ok, again.ok ? '' : again.error.message)
      const ceremonies = await workspace.store.ceremonies()
      assert.deepEqual(ceremonies.ok ? ceremonies.value : 'refused',
        [{ ...RETRO, version: 2, badly: 'the carry-over is still not fixed' }])
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a ceremony shard is held to the rules every record file is held to', () => {
  it('quarantines a damaged heading at its line, and readWorkspace refuses over it', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      const file = path.join(workspace.root, 'ceremonies', '2026-09.md')
      // The heading reshaped the way a hand edit or a markdown formatter reshapes one. The
      // four mandatory field lines below it are what the resynchroniser keys on, so the
      // record is found and quarantined at the first of them rather than being read as prose
      // of the file above: the heading is gone, so the line it can name is `type: retro`.
      await writeFile(file, (await readFile(file, 'utf8'))
        .replace('# retro-sprint-31: Retro sprint-31', '### retro-sprint-31 - Retro sprint-31'))

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.deepEqual(findings.value.map((f) => [f.file, f.line, f.rule, f.kind]),
        [['ceremonies/2026-09.md', 5, 'S1', 'ceremony']])
      assert.equal(findings.value[0]?.reason, 'a record heading is "# <slug>: <title>" at column 0, and this line is not')
      const ceremonies = await workspace.store.ceremonies()
      assert.deepEqual(ceremonies.ok ? ceremonies.value : 'refused', [])

      const view = await readWorkspace(workspace.store)
      assert.equal(view.ok, false, 'a view over a store hiding a ceremony is not whole')
      assert.match(view.ok ? '' : view.error.message, /^ceremonies\/2026-09\.md line 5: a record heading is /)
      assert.equal(view.ok ? '' : view.error.rule, 'S1')
    } finally {
      await workspace.dispose()
    }
  })

  it('quarantines a record whose type line is not retro, and names what it read', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      const file = path.join(workspace.root, 'ceremonies', '2026-09.md')
      await writeFile(file, (await readFile(file, 'utf8')).replace('type: retro', 'type: standup'))

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.deepEqual(findings.value.map((f) => [f.rule, f.id]), [['S1', 'retro-sprint-31']])
      assert.match(findings.value[0]?.reason ?? '', /a record in the ceremonies layout is type retro, not "standup"/)
    } finally {
      await workspace.dispose()
    }
  })

  it('raises S3 for one id written into two shards by hand, and refuses a write to it', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      const september = path.join(workspace.root, 'ceremonies', '2026-09.md')
      const copy = (await readFile(september, 'utf8')).replace('filed_at: 2026-09-18T16:00:00Z', 'filed_at: 2026-10-02T16:00:00Z')
      await writeFile(path.join(workspace.root, 'ceremonies', '2026-10.md'), copy)

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.deepEqual(findings.value.map((f) => [f.rule, f.id, f.kind]), [['S3', 'retro-sprint-31', 'ceremony']])
      const refused = await workspace.store.apply({
        txn: 't2', writes: [], ceremonies: [{ ceremony: { ...RETRO, title: 'Renamed' }, ifVersion: 1 }], events: [],
      })
      assert.equal(refused.ok ? '' : refused.error.rule, 'S3')
    } finally {
      await workspace.dispose()
    }
  })

  it('quarantines both copies of an id repeated inside one shard, and serves neither', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      const file = path.join(workspace.root, 'ceremonies', '2026-09.md')
      const text = await readFile(file, 'utf8')
      const record = text.slice(text.indexOf('# retro-sprint-31'))
      await writeFile(file, `${text}\n${record}`)

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.equal(findings.value.length, 2, 'both copies of a repeated id are quarantined, not one')
      assert.deepEqual([...new Set(findings.value.map((f) => f.id))], ['retro-sprint-31'])
      const ceremonies = await workspace.store.ceremonies()
      assert.deepEqual(ceremonies.ok ? ceremonies.value : 'refused', [])
    } finally {
      await workspace.dispose()
    }
  })

  it('rebuilds byte-identical rows after the index is deleted ten times', async () => {
    const workspace = await aWorkspace()
    try {
      const october: Ceremony = { ...RETRO, id: 'retro-sprint-32', title: 'Retro sprint-32', filed_at: '2026-10-02T16:00:00Z', actions: undefined }
      await workspace.store.apply({
        txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }, { ceremony: october }], events: [],
      })
      const first = await workspace.store.ceremonies()
      assert.ok(first.ok)
      const wanted = JSON.stringify(first.value)

      for (let pass = 1; pass <= 10; pass += 1) {
        await deleteIndex(workspace.root, workspace.store)
        const rebuilt = await workspace.store.ceremonies()
        assert.ok(rebuilt.ok, rebuilt.ok ? '' : rebuilt.error.message)
        assert.equal(JSON.stringify(rebuilt.value), wanted, `pass ${pass} read the ceremonies differently`)
        // The referential lookup is served from a table the rebuild has to refill too, so a
        // read that survives ten deletions proves nothing about the edge unless this does.
        const refused = await workspace.store.apply({
          txn: `r${pass}`, writes: [], removes: [{ id: 'carry-over-chore', ifVersion: 1 }], events: [],
        })
        assert.equal(refused.ok ? '' : refused.error.rule, 'S17', `pass ${pass} lost the action edge`)
      }
    } finally {
      await workspace.dispose()
    }
  })

  it('drops the rows when a shard is removed by hand', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: CHORE }], ceremonies: [{ ceremony: RETRO }], events: [] })
      await rm(path.join(workspace.root, 'ceremonies', '2026-09.md'))
      const gone = await workspace.store.ceremonies()
      assert.deepEqual(gone.ok ? gone.value : 'refused', [])
      // With the record gone the chore is named by nothing, so the removal it was holding up
      // is allowed: the edge rows went with the file rather than outliving it.
      const removed = await workspace.store.apply({
        txn: 't2', writes: [], removes: [{ id: 'carry-over-chore', ifVersion: 1 }], events: [],
      })
      assert.ok(removed.ok, removed.ok ? '' : removed.error.message)
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses to follow a symbolic link at the ceremonies directory', async () => {
    const workspace = await aWorkspace()
    try {
      const elsewhere = path.join(workspace.root, 'elsewhere')
      await mkdir(elsewhere)
      const { symlink } = await import('node:fs/promises')
      await symlink(elsewhere, path.join(workspace.root, 'ceremonies'))
      const read = await workspace.store.ceremonies()
      assert.equal(read.ok, false)
      assert.equal(read.ok ? '' : read.error.rule, 'S15')
    } finally {
      await workspace.dispose()
    }
  })
})
