// SPDX-License-Identifier: Apache-2.0
// What `doctor` reports, and what the exit status and `status` say beside it.
//
// The findings from round five that survived ADR-0029 meet here and they are one question
// asked three ways: which set is a membership test run against, and which findings does a
// reader actually get shown. A record the store quarantined still exists, so a neighbour
// pointing at it is not dangling; a finding that hides nothing is not the verdict; and a
// count that names one set has to say which set it names.
//
// Two of the round's findings were about `sprint_id`, and both went with the sprint.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLING_ACTOR: 'dana' } as const

type Cli = (argv: readonly string[]) => Promise<{ code: number; out: string; err: string }>

async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadling-r5d-'))
  const cli: Cli = (argv) => runCli(argv, { cwd: root, env: ENV })
  assert.equal((await cli(['init'])).code, 0)
  return { root, cli }
}

const shardOf = (root: string): string =>
  path.join(root, '.work', 'items', `${new Date().toISOString().slice(0, 7)}.md`)

/** Rewrite one file through a function, which is the hand edit D1 permits. */
async function edit(file: string, change: (text: string) => string): Promise<void> {
  await writeFile(file, change(await readFile(file, 'utf8')))
}

describe('a quarantined item is still an item its neighbour may point at', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    assert.equal((await cli(['file', 'task', 'item aa', '--id', 'item-aa'])).code, 0)
    assert.equal((await cli(['file', 'task', 'item bb', '--id', 'item-bb'])).code, 0)
    assert.equal((await cli(['relation', 'add', 'item-aa', 'blocks', 'item-bb'])).code, 0)
    // A type no dictionary carries, on item-bb's own record and on no other, so the store
    // holds that one record and refuses to serve it.
    await edit(shardOf(root), (text) => {
      const records = text.split(/(?=^# )/m)
      return records.map((record) => (record.startsWith('# item-bb:') ? record.replace(/^type: task$/m, 'type: widget') : record)).join('')
    })
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // `H24` says the edge "names an item the store does not hold, so the edge counts for
  // nothing", and its remedy drops the edge. Both are false about a record that is right
  // there and quarantined, and following the remedy would destroy a live edge.
  it('reports the quarantined record and raises no H24 against the edge that names it', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.match(run.out, /^V4 item-bb items\/\S+ /m)
    assert.doesNotMatch(run.out, /^H24 /m, 'the store holds item-bb; it is quarantined, not absent')
    assert.doesNotMatch(run.out, /relation remove item-aa blocks item-bb/, 'and the remedy that would drop a live edge is gone')
  })
})

describe('doctor exits on what a finding hides, not on the table being non-empty', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    assert.equal((await cli(['file', 'task', 'alpha task', '--id', 'alpha-task'])).code, 0)
    await edit(shardOf(root), (text) => text.replace(/\n/g, '\r\n'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // A git checkout with autocrlf produces exactly this, and it exited 7, which is also what a
  // truncated shard exits: a CI job could not tell the two apart.
  it('prints the H16 row, says the store serves it, and exits 0', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /^H16 - items\/\S+ /m)
    assert.match(run.out, /^serving 1 finding reports content this store still serves and the next write normalises; no record here is hidden$/m)
    assert.doesNotMatch(run.out, /^clean /m)
  })

  it('exits 7 again the moment a finding on the same store hides a record', async () => {
    await edit(shardOf(root), (text) => `${text}\r\n# not-a-record\r\n`)
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.doesNotMatch(run.out, /^serving /m)
  })
})

describe('status says which set its findings line counts', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    assert.equal((await cli(['file', 'epic', 'an epic', '--id', 'an-epic', '--set', 'outcome=a shipped thing'])).code, 0)
    assert.equal((await cli(['file', 'task', 'alpha task', '--id', 'alpha-task', '--parent', 'an-epic'])).code, 0)
    // A parent no record carries, which the store refuses to write and a hand edit produces.
    await edit(shardOf(root), (text) => text.replace(/^parent_id: an-epic$/m, 'parent_id: nope'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // `findings 0` beside `doctor` exit 7 is the reading a caller acts on, and the orientation
  // call stays cheap, so the line says what it did not do rather than doing it.
  it('prints findings 0 beside the line naming the check it did not run, while doctor exits 7', async () => {
    const audit = await cli(['doctor'])
    assert.equal(audit.code, 7, audit.out)
    assert.match(audit.out, /^H30 alpha-task parent_id /m)

    const orient = await cli(['status'])
    assert.equal(orient.code, 0, orient.err)
    assert.match(orient.out, /^findings 0$/m)
    assert.match(orient.out, /^audit not run here; treadling doctor reads every record against the event log$/m)
  })
})
