// SPDX-License-Identifier: Apache-2.0
// What `doctor` reports, and what the exit status and `status` say beside it.
//
// Three findings from round five meet here and they are one question asked three ways: which
// set is a membership test run against, and which findings does a reader actually get shown.
// A record the store quarantined still exists, so a neighbour pointing at it is not dangling;
// a finding that hides nothing is not the verdict; and a count that names one set has to say
// which set it names.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' } as const

type Cli = (argv: readonly string[]) => Promise<{ code: number; out: string; err: string }>

async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-r5d-'))
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

describe('a quarantined record does not turn its neighbours into false findings', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    assert.equal((await cli(['file', 'task', 'alpha task', '--id', 'alpha-task'])).code, 0)
    assert.equal((await cli(['sprint', 'open', 'Sprint two', '--id', 'sp2', '--end', '2026-09-30'])).code, 0)
    assert.equal((await cli(['transition', 'alpha-task', 'ready'])).code, 0)
    assert.equal((await cli(['sprint', 'commit', 'sp2', 'alpha-task'])).code, 0)
    // A value no write path produces, on the sprint record, so the store holds it and
    // refuses to serve it.
    await edit(path.join(root, '.work', 'sprints.md'), (text) => text.replace(/^state: open$/m, 'state: open\ncancelled: -1'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // The remedy was the worse half: `sprint open --id sp2` over a record that already carries
  // sp2 leaves two of them, which is `S3` and a strictly larger repair.
  it('reports the quarantined record and raises no H26 against the item pointing at it', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.match(run.out, /^S1 sp2 sprints\.md:\d+ /m)
    assert.doesNotMatch(run.out, /^H26 /m, 'a record does carry that id; it is quarantined two rows up')
    assert.doesNotMatch(run.out, /open one with --id sp2/, 'and the remedy that would have made a second one is gone')
  })

})

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

describe('a held id answers only for the record kind it is', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    assert.equal((await cli(['file', 'task', 'q one', '--id', 'q-one'])).code, 0)
    assert.equal((await cli(['file', 'task', 'q two', '--id', 'q-two'])).code, 0)
    // q-one is quarantined as an ITEM, and q-two is then pointed at it as if it were a sprint.
    await edit(shardOf(root), (text) => text.split(/(?=^# )/m).map((record) => (
      record.startsWith('# q-one:') ? record.replace(/^type: task$/m, 'type: widget')
        : record.startsWith('# q-two:') ? record.replace(/^version: 1$/m, 'version: 1\nsprint_id: q-one')
          : record)).join(''))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // Reading "held" as one flat set of ids turned a true H26 into silence: a quarantined item
  // is not a sprint, and no sprint record carries q-one at all.
  it('still reports H26 for a sprint_id that names a quarantined item', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.match(run.out, /^V4 q-one items\/\S+ /m)
    assert.match(run.out, /^H26 q-two sprint_id sprint_id is q-one and no sprint record carries that id/m)
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

describe('a closed sprint record says nothing about a set the store cannot show', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    assert.equal((await cli(['file', 'task', 'alpha task', '--id', 'alpha-task', '--points', '2'])).code, 0)
    assert.equal((await cli(['file', 'task', 'beta task', '--id', 'beta-task'])).code, 0)
    assert.equal((await cli(['sprint', 'open', 'Sprint one', '--id', 'sp1', '--end', '2026-09-18'])).code, 0)
    for (const id of ['alpha-task', 'beta-task']) assert.equal((await cli(['transition', id, 'ready'])).code, 0)
    assert.equal((await cli(['sprint', 'commit', 'sp1', 'alpha-task', 'beta-task'])).code, 0)
    for (const to of ['in_progress', 'done']) assert.equal((await cli(['transition', 'alpha-task', to])).code, 0)
    assert.equal((await cli(['sprint', 'close', 'sp1'])).code, 0)
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('is clean while the record agrees with the store', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /^clean /m)
  })

  // Both were served straight into `sprints` output as facts and doctor said nothing.
  it('reports H28 for a member no record carries, which sprints would otherwise count', async () => {
    await edit(path.join(root, '.work', 'sprints.md'), (text) =>
      text.replace(/^carried: beta-task$/m, 'carried: beta-task, ghost-task')
        .replace(/^alpha-task$/m, 'alpha-task\nghost-two'))
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.match(run.out, /^H28 sp1 carried carried names ghost-task and no record here carries that id/m)
    assert.match(run.out, /^H28 sp1 finished finished names ghost-two and no record here carries that id/m)
  })

  it('reports H29 for a frozen tally larger than the set it was counted over', async () => {
    await edit(path.join(root, '.work', 'sprints.md'), (text) =>
      text.replace(/^alpha-task\nghost-two$/m, 'alpha-task')
        .replace(/^carried: .*$/m, 'carried: beta-task')
        .replace(/^done: \d+$/m, 'done: 99'))
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.match(run.out, /^H29 sp1 done done is 99 over a committed set of 2/m)
  })
})

describe('status says which set its findings line counts', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    assert.equal((await cli(['file', 'task', 'alpha task', '--id', 'alpha-task'])).code, 0)
    assert.equal((await cli(['sprint', 'open', 'Sprint nine', '--id', 'sp9', '--end', '2026-09-30'])).code, 0)
    assert.equal((await cli(['transition', 'alpha-task', 'ready'])).code, 0)
    assert.equal((await cli(['sprint', 'commit', 'sp9', 'alpha-task'])).code, 0)
    await edit(shardOf(root), (text) => text.replace(/^sprint_id: sp9$/m, 'sprint_id: nope'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // `findings 0` beside `doctor` exit 7 is the reading a caller acts on, and the orientation
  // call stays cheap, so the line says what it did not do rather than doing it.
  it('prints findings 0 beside the line naming the check it did not run, while doctor exits 7', async () => {
    const audit = await cli(['doctor'])
    assert.equal(audit.code, 7, audit.out)
    assert.match(audit.out, /^H26 alpha-task sprint_id /m)

    const orient = await cli(['status'])
    assert.equal(orient.code, 0, orient.err)
    assert.match(orient.out, /^findings 0$/m)
    assert.match(orient.out, /^audit not run here; treadle doctor reads every record against the event log$/m)
  })
})
