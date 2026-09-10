// SPDX-License-Identifier: Apache-2.0
// `history --txn <id>`: the transaction-scoped half of the reader `history <id>` opened.
//
// Every event the log holds carries the `txn` of the write that made it, and a mutation's
// own result hands that id back on its envelope. Until this flag there was no way to spend
// it: an agent told `ok set probe tj0vksb 3` could ask what changed about one item at a
// time, or open the JSONL.
//
// The case that makes it worth a flag is the one where a transaction writes several events,
// each moving a different record with an identical `what` cell, so the record is the only
// thing telling the rows apart and it is not on the row. That is why the transaction-scoped
// read leads the `what` cell with `entity=<id>` and the entity-scoped read does not: there
// it is the `item` scalar and constant on every row.
//
// No command in this build writes more than one event per transaction, so the multi-record
// case is built through `apply` directly. That is honest rather than contrived: the port
// takes N writes and N events under one `txn`, `history --txn` is the reader of exactly that
// shape, and a suite that only ever saw one row would stop holding the column that exists
// for the many-row case.

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { history } from '../../src/application/services/history.ts'
import { makeEvent } from '../../src/application/services/mutation.ts'
import { EXIT_OF } from '../../src/application/result.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli, type Run } from '../helpers/cli-run.ts'

const ENV = { TREADLING_ACTOR: 'dana' }

type Rows = { readonly shown: number; readonly total: number; readonly rows: readonly Record<string, unknown>[] }

/** The transaction id off a mutation's envelope, which is where a caller gets one. */
function txnOf(run: Run): string {
  const first = run.out.split('\n')[0] ?? ''
  const txn = first.split(' ')[3]
  assert.ok(txn !== undefined && txn !== '-', `no transaction id on ${first}`)
  return txn
}

describe('history --txn lists every event one command wrote', () => {
  let root: string
  let commit: string
  let removal: string
  const cli = (argv: readonly string[]): Promise<Run> => runCli(argv, { cwd: root, env: ENV })

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadling-txn-'))
    const must = async (argv: readonly string[]): Promise<Run> => {
      const run = await cli(argv)
      assert.equal(run.code, 0, `${argv.join(' ')}: ${run.err}`)
      return run
    }
    await must(['init', '--name', 'txn'])
    for (const id of ['auth-refresh', 'sso-saml', 'rate-limit']) {
      await must(['file', 'story', `Story ${id}`, '--id', id, '--set', 'acceptance_criteria=one|two'])
      await must(['transition', id, 'ready'])
    }
    // One transaction over three records, written through the port because no command in
    // this build produces one; see the header. Each event moves the same field, so the
    // `entity=<id>` the transaction-scoped read leads with is what tells the rows apart.
    commit = 'tmulti1'
    const opened = await openWorkspace(path.join(root, '.work'))
    assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
    const store = opened.value
    try {
      const held = await Promise.all(['auth-refresh', 'sso-saml', 'rate-limit'].map(async (id) => {
        const item = await store.get(id)
        assert.ok(item.ok && item.value !== undefined, `${id} is not stored`)
        return item.value
      }))
      const applied = await store.apply({
        txn: commit,
        writes: held.map((item) => ({ item: { ...item, reviewer: 'kim' }, ifVersion: item.version })),
        events: held.map((item, at) => ({
          id: `emulti${at + 1}`,
          at: `2026-03-04T09:0${at}:00Z`,
          actor: 'dana', actor_kind: 'human', entity_kind: 'item', entity: item.id,
          op: 'item.set', before: { reviewer: '-' }, after: { reviewer: 'kim' },
          cmd: 'set', txn: commit,
        })),
      })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
    } finally {
      await store.close()
    }
    await must(['file', 'task', 'Filed twice', '--id', 'login-cta-2'])
    removal = txnOf(await must(['remove', 'login-cta-2', '--reason', 'filed twice by the same import', '--yes']))
  })

  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('names the record each event moved, which the entity-scoped read leaves to its scalar', async () => {
    const run = await cli(['history', '--txn', commit])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, new RegExp(`^transaction ${commit}$`, 'm'), run.out)
    assert.match(run.out, /^~events 3 3$/m, run.out)
    for (const id of ['auth-refresh', 'sso-saml', 'rate-limit']) {
      assert.match(run.out, new RegExp(`item\\.set entity=${id},reviewer=\\(unset\\)->kim dana$`, 'm'), run.out)
    }
    // The entity-scoped read is unchanged: one record, so the entity is the scalar.
    const one = await cli(['history', 'auth-refresh'])
    assert.equal(one.code, 0, one.err)
    assert.match(one.out, /^item auth-refresh$/m, one.out)
    assert.doesNotMatch(one.out, /entity=/, one.out)
  })

  it('says the record is gone, exactly as the entity-scoped read does', async () => {
    const run = await cli(['history', '--txn', removal])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /item\.remove entity=login-cta-2/, run.out)
    assert.match(run.out, /^note 1 of the records these rows name is no longer here/m, run.out)
  })

  it('refuses an id and --txn together, and names both readings', async () => {
    const run = await cli(['history', 'auth-refresh', '--txn', commit])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.out + run.err)
    assert.match(run.err, /ask different questions/, run.err)
    assert.match(run.err, /^fix treadling history auth-refresh$/m, run.err)
    assert.match(run.err, new RegExp(`^fix treadling history --txn ${commit}$`, 'm'), run.err)
  })

  it('names both readings when the line names neither', async () => {
    const run = await cli(['history'])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.out + run.err)
    assert.match(run.err, /--txn/, run.err)
  })

  it('refuses an unknown transaction by name, rather than answering with an empty list', async () => {
    const run = await cli(['history', '--txn', 'tzzzzzz'])
    assert.equal(run.code, EXIT_OF.NOT_FOUND, run.out + run.err)
    assert.match(run.err, /^entity tzzzzzz$/m, run.err)
    assert.match(run.err, /names no transaction here/, run.err)
    // An empty answer and a wrong id must not read the same.
    assert.doesNotMatch(run.out, /~events 0 0/, run.out)
  })

  it('answers an event id with the transaction that wrote it', async () => {
    const listed = await cli(['history', '--txn', commit, '--out', 'json'])
    assert.equal(listed.code, 0, listed.err)
    const rows = (JSON.parse(listed.out) as { data: { events: Rows } }).data.events.rows
    const eventId = await (async (): Promise<string> => {
      // The event ids are not on the row, so they come off the cursor the page line carries.
      const paged = await cli(['history', '--txn', commit, '--limit', '1', '--out', 'json'])
      const page = (JSON.parse(paged.out) as { data: { page?: string } }).data.page
      assert.ok(page !== undefined, 'a three-event transaction paged at one prints no page line')
      return page.split(' ').at(-1) as string
    })()
    assert.equal(rows.length, 3)
    const run = await cli(['history', '--txn', eventId])
    assert.equal(run.code, EXIT_OF.NOT_FOUND, run.out + run.err)
    assert.match(run.err, /is an event here, not a transaction/, run.err)
    assert.match(run.err, new RegExp(`^fix treadling history --txn ${commit}$`, 'm'), run.err)
  })

  it('refuses an unknown cursor with a first page that keeps the transaction', async () => {
    const run = await cli(['history', '--txn', commit, '--cursor', 'nope'])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.out + run.err)
    assert.match(run.err, new RegExp(`^fix treadling history --txn ${commit}$`, 'm'), run.err)
  })

  it('carries the transaction through all three renderings', async () => {
    for (const rendering of ['agent', 'json', 'human']) {
      const run = await cli(['history', '--txn', commit, '--out', rendering])
      assert.equal(run.code, 0, run.err)
      assert.ok(run.out.includes(commit), `${rendering} does not name the transaction`)
      assert.ok(run.out.includes('auth-refresh'), `${rendering} does not name the record`)
    }
  })

  it('refuses --txn with no value, rather than a refusal that names no id', async () => {
    // Measured before the guard: `--txn=` reached the store as an empty transaction id and
    // came back `"cause  names no transaction here`, with the `entity` line dropped for being
    // empty. A refusal that names nothing is the one thing this flag's refusals must not be.
    const run = await cli(['history', '--txn='])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.out + run.err)
    assert.match(run.err, /^"cause --txn needs the transaction id a write returned/m, run.err)
    assert.doesNotMatch(run.err, /^entity $/m, run.err)
  })

  it('cannot be made to forge a marker by a hand edit of the log', async () => {
    // The file's own rule: a stored value that would collide with a marker prints as the
    // absent cell, so no record's own content can forge one. `side` held it and `cell` did
    // not, and the entity is projected through `cell`: an event whose entity was the literal
    // `(unset)` printed `entity=(unset)`, which reads as no entity having been recorded.
    const forged = path.join(root, '.work', 'events', '2026-03.jsonl')
    const event = (id: string, entity: string): string => JSON.stringify({
      id, at: '2026-03-04T09:00:00Z', actor: 'dana', actor_kind: 'human', entity_kind: 'item',
      entity, op: 'item.set', after: { assignee: 'kim' }, cmd: 'set', txn: 'tforged',
    })
    await writeFile(forged, [event('eforged1', '(unset)'), event('eforged2', 'one two'), ''].join('\n'))
    const run = await cli(['history', '--txn', 'tforged'])
    assert.equal(run.code, 0, run.err)
    assert.doesNotMatch(run.out, /entity=\(/, run.out)
    assert.equal(run.out.split('\n').filter((line) => line.includes('entity=-')).length, 2, run.out)
    await rm(forged, { force: true })
  })

  it('is named by help, so a caller finds it by asking', async () => {
    const run = await cli(['help', 'history'])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /--txn <txn>/, run.out)
  })
})

describe('a transaction larger than one page', () => {
  let demo: Demo
  const TXN = 't0050'
  const SIZE = 50

  before(async () => {
    demo = await aDemoWorkspace()
    const applied = await demo.store.apply({
      txn: TXN,
      writes: [],
      events: Array.from({ length: SIZE }, (_, at) => makeEvent({
        id: `e5${String(at).padStart(3, '0')}`,
        at: '2026-09-05T09:00:00Z',
        actor: { id: 'dana', kind: 'human' },
        entity: 'auth-refresh',
        op: 'item.set',
        txn: TXN,
        command: 'set',
        before: { assignee: '-' },
        after: { assignee: `dev${at}` },
      })),
    })
    assert.equal(applied.ok, true, 'the fifty-event transaction was refused')
  })

  after(async () => { await demo.dispose() })

  it('pages at the limit and continues under the same transaction', async () => {
    const PAGE = 5
    const first = await history(demo.store, { scope: { kind: 'txn', txn: TXN }, limit: PAGE })
    assert.equal(first.ok, true)
    const events = first.data['events'] as Rows
    assert.equal(events.shown, PAGE)
    assert.equal(events.total, SIZE)
    assert.equal(first.data['more'], SIZE - PAGE)
    const page = first.data['page'] as string
    assert.match(page, new RegExp(`^treadling history --txn ${TXN} --limit ${PAGE} --cursor e\\S+$`), page)

    // Walk it to the end by its own cursor lines: every row of the transaction, once.
    const seen: string[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < SIZE; pages += 1) {
      const result = await history(demo.store, {
        scope: { kind: 'txn', txn: TXN }, limit: PAGE, ...(cursor === undefined ? {} : { cursor }),
      })
      assert.equal(result.ok, true)
      const block = result.data['events'] as Rows
      for (const row of block.rows) seen.push(String(row['what']))
      const next = result.data['page'] as string | undefined
      if (next === undefined) break
      cursor = next.split(' ').at(-1) as string
    }
    assert.equal(seen.length, SIZE, 'walking the page lines did not read the transaction once through')
    assert.equal(new Set(seen).size, SIZE, 'a row was read twice')
  })
})
