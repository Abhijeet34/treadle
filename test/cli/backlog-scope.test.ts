// SPDX-License-Identifier: Apache-2.0
// The three things the default list did not do, driven through the command surface a caller
// drives, because every one of them was a fact about what a read answers rather than about
// what a function returns.
//
// `backlog` listed every state, so the default read carried finished work: 1,257 B for 23
// items of which 18 were done or cancelled, on a store that small. Whether an item was held
// up was on no list, so learning it cost one `explain` per row at 669 B a call. How long a
// thing had sat was on no list at all, though `explain` carries the instant one item entered
// its state and `next` scores by an age nothing prints.
//
// The scope is an ordinary `--state` clause rather than a window, which is what puts it in
// the `filter` line, in the `page` line that continues the list, in `narrowest` and in the
// clause `--explain-absence` names. A scope none of those carried would be a list that
// silently answers a narrower question than it was asked, which is the failure the record
// exists to prevent.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLING_ACTOR: 'dana' } as const

type Run = { code: number; out: string; err: string }
type Cli = (argv: readonly string[]) => Promise<Run>

function must(run: Run, what: string): Run {
  assert.equal(run.code, 0, `${what}: ${run.err}`)
  return run
}

/**
 * Two open items, one of them blocked by the other, and two finished ones. The blocker is
 * added after both are ready, which is how a blocker really arrives: work is queued and then
 * something stops it, so a ready item can carry one.
 */
async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadling-backlog-scope-'))
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: root, env: ENV })
  must(await cli(['init']), 'init')
  must(await cli(['file', 'task', 'Rotate the signing key', '--id', 'key-rotate', '--priority', '1']), 'file')
  must(await cli(['file', 'task', 'Publish the runbook', '--id', 'runbook', '--priority', '2']), 'file')
  must(await cli(['file', 'task', 'Ship the fix', '--id', 'shipped', '--priority', '3']), 'file')
  must(await cli(['file', 'task', 'Drop the duplicate', '--id', 'dropped', '--priority', '4']), 'file')
  for (const id of ['key-rotate', 'runbook', 'shipped']) must(await cli(['transition', id, 'ready']), `ready ${id}`)
  must(await cli(['relation', 'add', 'key-rotate', 'blocks', 'runbook']), 'blocks')
  must(await cli(['transition', 'shipped', 'in_progress']), 'start')
  must(await cli(['transition', 'shipped', 'done', '--reason', 'it shipped']), 'finish')
  must(await cli(['transition', 'dropped', 'cancelled', '--resolution', 'duplicate', '--reason', 'filed twice']), 'cancel')
  return { root, cli }
}

describe('the default backlog is open work, and every line says which list it is', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('leaves finished work out of the default read, and names the clause that left it out', async () => {
    const listed = must(await cli(['backlog']), 'backlog')
    assert.match(listed.out, /^filter state open$/m, 'the scope is not in the filter line')
    assert.match(listed.out, /^~items 2 2$/m, listed.out)
    assert.match(listed.out, /^key-rotate /m)
    assert.match(listed.out, /^runbook /m)
    assert.doesNotMatch(listed.out, /^shipped /m, 'a done item is in the default list')
    assert.doesNotMatch(listed.out, /^dropped /m, 'a cancelled item is in the default list')
  })

  it('answers every state under --state all, which is the read the default one narrows', async () => {
    const every = must(await cli(['backlog', '--state', 'all']), 'backlog --state all')
    assert.match(every.out, /^filter state all$/m)
    assert.match(every.out, /^~items 4 4$/m, every.out)
    assert.match(every.out, /^shipped /m)
    assert.match(every.out, /^dropped /m)
  })

  it('keeps a caller who named a state, rather than intersecting two scopes into nothing', async () => {
    const done = must(await cli(['backlog', '--state', 'done']), 'backlog --state done')
    assert.match(done.out, /^filter state done$/m, 'the default scope was added beside the caller\'s own')
    assert.match(done.out, /^shipped /m)
    assert.match(done.out, /^~items 1 1$/m)
  })

  // T6 lets only the cancel transition record a resolution, so a resolution is a fact about a
  // cancelled record and nothing else: under an open scope the clause can never hold, and the
  // read answered `matched 0` with the contradiction printed on its own filter line.
  it('treats a resolution clause as its own scope, because only a cancelled record carries one', async () => {
    const dupes = must(await cli(['backlog', '--resolution', 'duplicate']), 'backlog --resolution')
    assert.doesNotMatch(dupes.out, /^filter state open/m, 'the open scope was kept over a terminal-only field')
    assert.match(dupes.out, /^dropped /m, dupes.out)
  })

  it('carries the scope into the page line, so the walk continues the list that printed it', async () => {
    const first = must(await cli(['backlog', '--limit', '1']), 'first page')
    const page = /^page (treadling backlog .+)$/m.exec(first.out)
    assert.ok(page !== null, `no page line to follow:\n${first.out}`)
    assert.match(page[1] as string, /--state open /, 'the page line dropped the scope it walked')
    const second = must(await cli((page[1] as string).split(' ').slice(1)), 'second page')
    assert.doesNotMatch(second.out, /^shipped /m, 'the followed page walked a wider list than the one that named it')
  })

  it('names the scope as the clause that excluded an item, rather than calling it a match', async () => {
    const absent = must(await cli(['backlog', '--explain-absence', 'shipped']), 'absence')
    assert.match(absent.out, /^clause state want open got done$/m, absent.out)
  })

  it('refuses a state outside the set, and the set it names includes both groups', async () => {
    const bad = await cli(['backlog', '--state', 'banana'])
    assert.equal(bad.code, 2)
    assert.match(bad.err, /the set is draft, ready, in_progress, in_review, done, on_hold, cancelled, open, all$/m)
  })
})

describe('a blocked item is legible in the list, without a call per row', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('carries the blocking ids as a column of the default set, and a dash where nothing blocks', async () => {
    const listed = must(await cli(['backlog']), 'backlog')
    assert.match(listed.out, /^#id type state sev blocked age "title$/m, listed.out)
    assert.match(listed.out, /^runbook task ready - key-rotate \d+ Publish the runbook$/m, listed.out)
    assert.match(listed.out, /^key-rotate task ready - - \d+ Rotate the signing key$/m, listed.out)
  })

  // The ids and not a `yes`: a caller who reads `yes` still has to call `explain` to learn by
  // what, and removing that call is the whole point of the column.
  it('says the same thing explain says, so the second call is the one that is no longer needed', async () => {
    const listed = must(await cli(['backlog']), 'backlog')
    const said = /^runbook \S+ \S+ \S+ (\S+) /m.exec(listed.out)
    const explained = must(await cli(['explain', 'runbook']), 'explain')
    assert.match(explained.out, new RegExp(`^blocked yes ${said?.[1] as string}$`, 'm'), explained.out)
  })

  it('filters to the held-up items, and to the startable ones, off the same clause', async () => {
    const held = must(await cli(['backlog', '--blocked', 'yes']), 'blocked yes')
    assert.match(held.out, /^filter state open blocked yes$/m)
    assert.match(held.out, /^~items 1 1$/m)
    assert.match(held.out, /^runbook /m)

    const free = must(await cli(['backlog', '--blocked', 'no']), 'blocked no')
    assert.match(free.out, /^~items 1 1$/m)
    assert.match(free.out, /^key-rotate /m)
  })

  it('names the clause under --explain-absence with a value every item has', async () => {
    const absent = must(await cli(['backlog', '--blocked', 'yes', '--explain-absence', 'key-rotate']), 'absence')
    assert.match(absent.out, /^clause blocked want yes got no$/m, absent.out)
  })

  it('refuses a value outside yes and no, in a sentence about a value rather than a field', async () => {
    const bad = await cli(['backlog', '--blocked', 'maybe'])
    assert.equal(bad.code, 2)
    assert.match(bad.err, /^"cause maybe is not a blocked value; the set is yes, no$/m, bad.err)
  })

  it('stops naming a blocker the moment that blocker is finished', async () => {
    must(await cli(['transition', 'key-rotate', 'in_progress']), 'start')
    must(await cli(['transition', 'key-rotate', 'done', '--reason', 'rotated']), 'finish')
    const listed = must(await cli(['backlog']), 'backlog')
    assert.match(listed.out, /^runbook task ready - - \d+ Publish the runbook$/m, listed.out)
    const none = must(await cli(['backlog', '--blocked', 'yes']), 'blocked yes')
    assert.match(none.out, /^none searched \d+ matched 0$/m, none.out)
  })
})

describe('the age of a thing is on the list that dispatches it', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('prints whole days since filing, which for a workspace made now is nought', async () => {
    const listed = must(await cli(['backlog', '--fields', 'id,age']), 'backlog --fields id,age')
    assert.match(listed.out, /^#id age$/m)
    assert.match(listed.out, /^key-rotate 0$/m, listed.out)
  })

  it('is a column a caller can ask for alone, and one the default set already carries', async () => {
    const listed = must(await cli(['backlog']), 'backlog')
    assert.match(listed.out, /^#id type state sev blocked age "title$/m)
    const twice = await cli(['backlog', '--fields', '+age'])
    assert.equal(twice.code, 2, 'a column already in the default set was silently printed twice')
    assert.match(twice.err, /^"cause age is named twice and a column is printed once/m)
  })
})
