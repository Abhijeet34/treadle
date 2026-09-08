// SPDX-License-Identifier: Apache-2.0
// The replay path, driven with the files an attacker or an accident can leave in `.txn/`.
//
// A journal decides what the next writer writes before anything looks at it, and the
// directory is one anything that can write the workspace can put a file in - a commit
// carrying the ignored path included, because `.gitignore` does not remove a tracked file on
// checkout. Both defects here were live: `{"garbage":true}` made every write an uncaught
// `TypeError` at exit 1 forever with `doctor` reporting the workspace clean, and a `path` of
// `../../elsewhere` was joined onto the root and written at exit 0.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { renderEvent, tempNameFor } from '../../src/adapters/store/index.ts'
import { aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'
import type { Store, StoreEvent } from '../../src/application/ports/store.ts'

/** What `doctor` sees: the findings the store keeps for a command that reads the whole log. */
async function findingsAfterReadingTheLog(store: Store): Promise<readonly { rule: string; file: string; reason: string }[]> {
  const scanned = await store.eachEvent({}, () => undefined)
  assert.ok(scanned.ok, scanned.ok ? '' : scanned.error.message)
  const found = await store.findings()
  assert.ok(found.ok, found.ok ? '' : found.error.message)
  return found.value.map((finding) => ({ rule: finding.rule, file: finding.file, reason: finding.reason }))
}

/** `.txn/` is created by the first write, so a test that plants a file there makes it. */
async function journal(root: string, name: string, body: unknown): Promise<void> {
  await mkdir(path.join(root, '.txn'), { recursive: true })
  await writeFile(path.join(root, '.txn', `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body))
}

const NOT_A_JOURNAL: readonly [string, unknown][] = [
  ['a hand-dropped object', { garbage: true }],
  ['text that is not JSON at all', 'not json at all'],
  ['a journal with no txn', { files: [], events: [] }],
  ['a journal whose files is not an array', { txn: 't1', files: 42, events: [] }],
  ['a journal whose file entry has no content', { txn: 't1', files: [{ path: 'items/2026-09.md' }], events: [] }],
  ['a journal whose file path is a number', { txn: 't1', files: [{ path: 42, content: 'x' }], events: [] }],
  ['a journal whose event lines and ids disagree', {
    txn: 't1', files: [], events: [{ path: 'events/2026-09.jsonl', lines: ['{}\n'], ids: [] }],
  }],
  ['a journal with no ids at all, which indexed undefined', {
    txn: 't1', files: [], events: [{ path: 'events/2026-09.jsonl', lines: ['{}\n'] }],
  }],
  ['null, which is an object', 'null'],
]

describe('a file in .txn/ that is not a journal', () => {
  for (const [what, body] of NOT_A_JOURNAL) {
    it(`refuses the write and names the file: ${what}`, async () => {
      const workspace = await aWorkspace()
      try {
        await journal(workspace.root, 'tstale', body)
        const applied = await workspace.store.apply({
          txn: 't-after', writes: [{ item: anItem() }], events: [],
        })
        assert.equal(applied.ok, false, `${what} was replayed`)
        assert.equal(applied.ok ? '' : applied.error.code, 'STORE_UNAVAILABLE')
        assert.equal(applied.ok ? '' : applied.error.rule, 'S13')
        assert.match(applied.ok ? '' : applied.error.message, /^\.txn\/tstale\.json is not a transaction journal/)
        // The refusal is the whole remedy only if the file it names is still there to delete.
        assert.deepEqual(await readdir(path.join(workspace.root, '.txn')), ['tstale.json'])
      } finally {
        await workspace.dispose()
      }
    })
  }

  it('is a doctor finding rather than a clean workspace, and reads still answer', async (t) => {
    const workspace = await aWorkspace()
    try {
      const first = await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      assert.ok(first.ok, first.ok ? '' : first.error.message)
      await journal(workspace.root, 'tstale', { garbage: true })

      const findings = await findingsAfterReadingTheLog(workspace.store)
      assert.equal(findings.length, 1, `doctor sees ${findings.length} findings where it must see 1`)
      assert.equal(findings[0]?.rule, 'S13')
      assert.equal(findings[0]?.file, '.txn/tstale.json')

      // A read of records that are all present is still a whole answer, so the workspace is
      // stopped from writing rather than bricked: `show` and `backlog` keep working.
      const found = await workspace.store.get('item-one')
      assert.ok(found.ok && found.value?.id === 'item-one', 'a read was refused over a pending journal')
      const summaries = await workspace.store.summaries()
      assert.ok(summaries.ok && summaries.value.length === 1)
      t.diagnostic(`doctor names ${findings[0]?.file} where it used to report the workspace clean`)
    } finally {
      await workspace.dispose()
    }
  })

  it('clears the moment the file is deleted', async () => {
    const workspace = await aWorkspace()
    try {
      await journal(workspace.root, 'tstale', { garbage: true })
      const refused = await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      assert.equal(refused.ok, false)

      await rm(path.join(workspace.root, '.txn', 'tstale.json'))
      const applied = await workspace.store.apply({ txn: 't2', writes: [{ item: anItem() }], events: [] })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
      assert.deepEqual(await findingsAfterReadingTheLog(workspace.store), [])
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a journal that names a path outside the layout', () => {
  const ESCAPES: readonly [string, string][] = [
    ['a relative walk out of the root', '../../pwned.txt'],
    ['a walk that starts with the directory it leaves', 'items/../../pwned.txt'],
    ['an absolute path', '/tmp/pwned.txt'],
    ['a directory the layout does not draw', 'notitems/pwned.txt'],
    ['a nested path under a directory the layout does draw', 'items/nested/pwned.txt'],
    ['the journal directory itself', '.txn/pwned.txt'],
  ]

  for (const [what, at] of ESCAPES) {
    it(`refuses it and writes nothing: ${what}`, async () => {
      const outside = await mkdtemp(path.join(tmpdir(), 'treadle-outside-'))
      const workspace = await aWorkspace()
      try {
        const target = at.startsWith('/') ? path.join(outside, 'pwned.txt') : at
        await journal(workspace.root, 'tevil', {
          txn: 'tevil', files: [{ path: target, content: 'written by a crafted journal\n' }], events: [],
        })
        const applied = await workspace.store.apply({ txn: 't-after', writes: [{ item: anItem() }], events: [] })
        assert.equal(applied.ok, false, `${what} was replayed`)
        assert.equal(applied.ok ? '' : applied.error.rule, 'S13')
        await assert.rejects(() => stat(path.join(outside, 'pwned.txt')), `${what} wrote outside the workspace`)
        await assert.rejects(() => stat(path.resolve(workspace.root, '..', '..', 'pwned.txt')))
      } finally {
        await workspace.dispose()
        await rm(outside, { recursive: true, force: true })
      }
    })
  }

  it('refuses an event path outside the log directory too', async () => {
    const workspace = await aWorkspace()
    try {
      await journal(workspace.root, 'tevil', {
        txn: 'tevil', files: [],
        events: [{ path: '../pwned.jsonl', lines: ['{}\n'], ids: ['e1'] }],
      })
      const applied = await workspace.store.apply({ txn: 't-after', writes: [{ item: anItem() }], events: [] })
      assert.equal(applied.ok, false)
      assert.equal(applied.ok ? '' : applied.error.rule, 'S13')
      await assert.rejects(() => stat(path.resolve(workspace.root, '..', 'pwned.jsonl')))
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a journal this store did write', () => {
  it('is still replayed and removed, so nothing here narrows recovery', async () => {
    const workspace = await aWorkspace()
    try {
      const recovered: StoreEvent = anEvent({ id: 'ev-recovered', txn: 't-recovered', op: 'update' })
      await journal(workspace.root, 't-recovered', {
        txn: 't-recovered', files: [],
        events: [{ path: 'events/2026-09.jsonl', lines: [renderEvent(recovered)], ids: [recovered.id] }],
      })

      const applied = await workspace.store.apply({ txn: 't-after', writes: [{ item: anItem() }], events: [] })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)

      const events = await workspace.store.events({})
      assert.ok(events.ok)
      assert.deepEqual(events.value.map((event) => event.id), ['ev-recovered'])
      assert.deepEqual(await readdir(path.join(workspace.root, '.txn')), [], 'the journal it applied stayed behind')
    } finally {
      await workspace.dispose()
    }
  })

  it('sweeps a temp file a writer killed between the create and the rename left there', async () => {
    const workspace = await aWorkspace()
    try {
      await mkdir(path.join(workspace.root, '.txn'), { recursive: true })
      const orphan = tempNameFor(path.join(workspace.root, '.txn', 't-crashed.json'))
      await writeFile(orphan, '{}')
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      await utimes(orphan, old, old)

      const applied = await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
      assert.deepEqual(await readdir(path.join(workspace.root, '.txn')), [], 'the orphaned temp journal is still there')
    } finally {
      await workspace.dispose()
    }
  })

  it('leaves a file the sweep is younger than alone rather than guessing', async () => {
    const workspace = await aWorkspace()
    try {
      await mkdir(path.join(workspace.root, '.txn'), { recursive: true })
      const fresh = tempNameFor(path.join(workspace.root, '.txn', 't-inflight.json'))
      await writeFile(fresh, '{}')
      const applied = await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
      assert.equal((await readFile(fresh, 'utf8')), '{}')
    } finally {
      await workspace.dispose()
    }
  })
})
