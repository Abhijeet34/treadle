// SPDX-License-Identifier: Apache-2.0
// A sprint at the command surface, driven the way a caller drives it: open one, commit work,
// meet the refusals, close it with the carry-over recorded, read it back, reopen it. The
// judgement calls ADR-0016 argues are each held here as a line a caller sees: an item is in
// one sprint, a close leaves unfinished items pointing at the closed sprint and names them,
// a cancelled item stays in the committed set, and a date is a UTC calendar day.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { displayWidth } from '../../src/adapters/render/width.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

const WIDTHS = [40, 60, 80, 100, 200] as const

describe('a sprint from open to close, at the command surface', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  /** The human rendering of one invocation stays inside every width the contract names. */
  async function insideEveryWidth(argv: readonly string[]): Promise<void> {
    for (const width of WIDTHS) {
      const run = await cli([...argv, '--out', 'human', '--width', String(width)])
      for (const line of (run.out + run.err).trimEnd().split('\n')) {
        assert.ok(displayWidth(line) <= width, `${argv.join(' ')} at ${width}: "${line}" is ${displayWidth(line)} cells`)
      }
    }
  }

  it('refuses to open a sprint without an end, with a date that is not a day, or with an end before its start', async () => {
    const noEnd = await cli(['sprint', 'open', 'Sprint 31'])
    assert.equal(noEnd.code, 2)
    assert.match(noEnd.err, /^"cause sprint open needs --end <date>, the last day of the sprint$/m)

    const rolled = await cli(['sprint', 'open', 'Sprint 31', '--start', '2026-09-07', '--end', '2026-09-31'])
    assert.equal(rolled.code, 2)
    assert.match(rolled.err, /^rule I1$/m)
    assert.match(rolled.err, /^"cause end must be a calendar date written YYYY-MM-DD that names a real day/m)

    const backwards = await cli(['sprint', 'open', 'Sprint 31', '--start', '2026-09-19', '--end', '2026-09-18'])
    assert.equal(backwards.code, 2)
    assert.match(backwards.err, /^"cause end 2026-09-18 is before start 2026-09-19; a sprint ends on or after the day it starts$/m)
  })

  it('opens a sprint as one record in sprints.md, with the goal as a section', async () => {
    const opened = await cli(['sprint', 'open', 'Sprint 31', '--start', '2026-09-07', '--end', '2026-09-18', '--goal', 'Ship the token refresh'])
    assert.equal(opened.code, 0, opened.err)
    assert.match(opened.out, /^ok sprint acme-platform \S+ 1$/m)
    assert.match(opened.out, /^sprint sprint-31$/m)
    assert.match(opened.out, /^state open$/m)
    assert.match(opened.out, /^set start - -> 2026-09-07$/m)
    assert.match(opened.out, /^set end - -> 2026-09-18$/m)
    const file = await readFile(path.join(demo.root, 'sprints.md'), 'utf8')
    assert.match(file, /^# sprint-31: Sprint 31$/m)
    assert.match(file, /^type: sprint\nstate: open\nfiled_at: \S+\nversion: 1\nstart: 2026-09-07\nend: 2026-09-18\n\n## Goal\n\nShip the token refresh$/m)

    const again = await cli(['sprint', 'open', 'Sprint 31 again', '--id', 'sprint-31', '--end', '2026-09-18'])
    assert.equal(again.code, 2)
    assert.match(again.err, /^"cause sprint-31 is already a sprint here$/m)
  })

  it('commits ready items in one transaction and reports each move', async () => {
    const committed = await cli(['sprint', 'commit', 'sprint-31', 'csv-export', 'avatar-crop', 'webhook-retry'])
    assert.equal(committed.code, 0, committed.err)
    assert.match(committed.out, /^ok sprint acme-platform \S+ 3$/m)
    assert.match(committed.out, /^committed csv-export - -> sprint-31$/m)
    assert.match(committed.out, /^committed webhook-retry - -> sprint-31$/m)
    assert.match(committed.out, /^events 3 item.commit$/m)
    const shown = await cli(['show', 'csv-export', '--field', 'sprint'])
    assert.match(shown.out, /^sprint sprint-31$/m)

    const already = await cli(['sprint', 'commit', 'sprint-31', 'csv-export'])
    assert.equal(already.code, 0, already.err)
    assert.match(already.out, /^ok sprint acme-platform - 0$/m)
    assert.match(already.out, /^already csv-export$/m)
  })

  it('refuses a draft story with no criterion and a done task, each as I4 with the remedy', async () => {
    const draft = await cli(['sprint', 'commit', 'sprint-31', 'theme-dark'])
    assert.equal(draft.code, 3)
    assert.match(draft.err, /^rule I4$/m)
    assert.match(draft.err, /^"cause theme-dark is not ready to be worked: DOR4 acceptance_criteria is empty$/m)
    assert.match(draft.err, /^fix treadle set theme-dark acceptance_criteria=/m)

    const done = await cli(['sprint', 'commit', 'sprint-31', 'login-cta'])
    assert.equal(done.code, 3)
    assert.match(done.err, /^"cause login-cta is done, and finished work does not enter a sprint$/m)
    const untouched = await cli(['show', 'theme-dark'])
    assert.doesNotMatch(untouched.out, /^sprint /m, 'a refused commit wrote nothing')
  })

  it('refuses to commit an item to a second open sprint while it sits in the first', async () => {
    const second = await cli(['sprint', 'open', 'Sprint 32', '--start', '2026-09-21', '--end', '2026-10-02'])
    assert.equal(second.code, 0, second.err)
    const twice = await cli(['sprint', 'commit', 'sprint-32', 'csv-export'])
    assert.equal(twice.code, 3)
    assert.match(twice.err, /^err GUARD_REFUSED acme-platform$/m)
    assert.match(twice.err, /^rule I3$/m)
    assert.match(twice.err, /^entity csv-export$/m)
    assert.match(twice.err, /^"cause csv-export is committed to sprint-31, which is open; an item is in one sprint$/m)
    assert.match(twice.err, /^fix treadle sprint uncommit csv-export$/m)
    assert.match(twice.err, /^fix treadle sprint close sprint-31$/m)
    assert.equal(twice.out, '')
  })

  it('shows the open sprints on status, and no longer lists sprint as absent', async () => {
    const status = await cli(['status'])
    assert.equal(status.code, 0, status.err)
    assert.doesNotMatch(status.out, /^absent_features/m, 'every feature it named has landed')
    assert.match(status.out, /^~sprints 2 2$/m)
    assert.match(status.out, /^#id day items pts "title$/m)
    assert.match(status.out, /^sprint-31 -?\d+\/12 0\/3 0\/10 Sprint 31$/m)
    assert.match(status.out, /^sprint-32 -?\d+\/12 0\/0 0\/0 Sprint 32$/m)
    await insideEveryWidth(['status'])
  })

  it('feeds the spr component of next for an item in an open sprint, and only there', async () => {
    const ranked = await cli(['next', '--limit', '9'])
    assert.equal(ranked.code, 0, ranked.err)
    assert.match(ranked.out, /^csv-export 5 \d+ p3\/a\d+\/d0\/s1\/m0\/u0\/v0 /m)
    assert.match(ranked.out, /^gdpr-export 5 \d+ p4\/a\d+\/d0\/s0\/m0\/u0\/v0 /m)
  })

  it('refuses set on sprint_id and names the command that owns it', async () => {
    const set = await cli(['set', 'csv-export', 'sprint=sprint-32'])
    assert.equal(set.code, 2)
    assert.match(set.err, /^rule V5$/m)
    assert.match(set.err, /^"cause sprint_id is not set here; treadle sprint commit <sprint> csv-export$/m)
  })

  it('holds file --sprint to the same rules as commit', async () => {
    const missing = await cli(['file', 'task', 'A task in no sprint', '--sprint', 'sprint-99'])
    assert.equal(missing.code, 5)
    assert.match(missing.err, /^rule I5$/m)
    assert.match(missing.err, /^"cause sprint-99 is no sprint here; this workspace holds 2 sprints$/m)
    assert.match(missing.err, /^near sprint-3[12]$/m)

    const filed = await cli(['file', 'task', 'Rotate the deploy key', '--id', 'deploy-key', '--points', '1', '--sprint', 'sprint-32'])
    assert.equal(filed.code, 0, filed.err)
    assert.match(filed.out, /^set sprint_id - -> sprint-32$/m)
  })

  it('closes the sprint, records the items still open as carried, and leaves them pointing at it', async () => {
    for (const target of ['in_progress', 'done']) {
      const moved = await cli(['transition', 'webhook-retry', target])
      assert.equal(moved.code, 0, moved.err)
    }
    const closed = await cli(['sprint', 'close', 'sprint-31'])
    assert.equal(closed.code, 0, closed.err)
    assert.match(closed.out, /^state open -> closed$/m)
    assert.match(closed.out, /^v 1 -> 2$/m)
    assert.match(closed.out, /^set carried - -> avatar-crop,csv-export$/m)
    assert.match(closed.out, /^carried avatar-crop,csv-export$/m)

    const record = await cli(['sprints', 'sprint-31'])
    assert.equal(record.code, 0, record.err)
    assert.match(record.out, /^state closed$/m)
    assert.match(record.out, /^closed \S+Z$/m)
    assert.match(record.out, /^committed 3$/m)
    assert.match(record.out, /^done 1$/m)
    assert.match(record.out, /^pts 3\/10$/m)
    assert.match(record.out, /^carried avatar-crop,csv-export$/m)
    assert.match(record.out, /^"goal Ship the token refresh$/m)
    assert.doesNotMatch(record.out, /^day /m, 'a closed sprint has no day')

    // Unfinished work is left where it was: its own record still says which sprint planned it.
    const listed = await cli(['backlog', '--sprint', 'sprint-31', '--fields', 'id,state'])
    assert.match(listed.out, /^avatar-crop ready$/m)
    assert.match(listed.out, /^csv-export ready$/m)
    assert.match(listed.out, /^webhook-retry done$/m)
    // And it earns no ranking lift from a sprint that is over.
    const ranked = await cli(['next', '--limit', '9'])
    assert.match(ranked.out, /^csv-export 5 \d+ p3\/a\d+\/d0\/s0\/m0\/u0\/v0 /m)

    const again = await cli(['sprint', 'close', 'sprint-31'])
    assert.equal(again.code, 0)
    assert.match(again.out, /^already sprint-31$/m)
    await insideEveryWidth(['sprints', 'sprint-31'])
    await insideEveryWidth(['sprints'])
  })

  it('lists every sprint with how much of its committed set is done', async () => {
    const list = await cli(['sprints'])
    assert.equal(list.code, 0, list.err)
    assert.match(list.out, /^~sprints 2 2$/m)
    assert.match(list.out, /^#id state start end items pts "title$/m)
    assert.match(list.out, /^sprint-31 closed 2026-09-07 2026-09-18 1\/3 3\/10 Sprint 31$/m)
    assert.match(list.out, /^sprint-32 open 2026-09-21 2026-10-02 0\/1 0\/1 Sprint 32$/m)
  })

  it('refuses to commit into a closed sprint or uncommit out of one, and lets carried work move on', async () => {
    const intoClosed = await cli(['sprint', 'commit', 'sprint-31', 'gdpr-export'])
    assert.equal(intoClosed.code, 3)
    assert.match(intoClosed.err, /^rule I2$/m)
    assert.match(intoClosed.err, /^fix treadle sprint reopen sprint-31$/m)

    const outOfClosed = await cli(['sprint', 'uncommit', 'csv-export'])
    assert.equal(outOfClosed.code, 3)
    assert.match(outOfClosed.err, /^rule I2$/m)
    assert.match(outOfClosed.err, /^"cause csv-export is in sprint-31, which is closed, and a closed sprint's committed set is a record; commit it to an open sprint instead$/m)

    const onward = await cli(['sprint', 'commit', 'sprint-32', 'csv-export', 'avatar-crop'])
    assert.equal(onward.code, 0, onward.err)
    assert.match(onward.out, /^committed csv-export sprint-31 -> sprint-32$/m)
    // The closed sprint's record is unchanged by the move: it still says what it committed and carried.
    const record = await cli(['sprints', 'sprint-31'])
    assert.match(record.out, /^committed 3$/m)
    assert.match(record.out, /^carried avatar-crop,csv-export$/m)
    const listed = await cli(['backlog', '--sprint', 'sprint-31', '--fields', 'id'])
    assert.match(listed.out, /^~items 1 1$/m)

    const out = await cli(['sprint', 'uncommit', 'deploy-key'])
    assert.equal(out.code, 0, out.err)
    assert.match(out.out, /^committed deploy-key sprint-32 -> -$/m)
    const shown = await cli(['show', 'deploy-key'])
    assert.doesNotMatch(shown.out, /^sprint /m)
  })

  it('keeps a cancelled item in the committed set and does not carry it', async () => {
    const stopped = await cli(['transition', 'avatar-crop', 'cancelled', '--resolution', 'wont_do', '--reason', 'the crop is done client side now'])
    assert.equal(stopped.code, 0, stopped.err)
    const record = await cli(['sprints', 'sprint-32'])
    assert.match(record.out, /^committed 2$/m)
    assert.match(record.out, /^cancelled 1$/m)
    const closed = await cli(['sprint', 'close', 'sprint-32'])
    assert.equal(closed.code, 0, closed.err)
    assert.match(closed.out, /^carried csv-export$/m)
  })

  it('reopens a closed sprint, clears the carry-over its close recorded, and records that in the log', async () => {
    const reopened = await cli(['sprint', 'reopen', 'sprint-32'])
    assert.equal(reopened.code, 0, reopened.err)
    assert.match(reopened.out, /^state closed -> open$/m)
    assert.match(reopened.out, /^set carried csv-export -> -$/m)
    const record = await cli(['sprints', 'sprint-32'])
    assert.match(record.out, /^state open$/m)
    assert.doesNotMatch(record.out, /^carried /m)

    const log = await cli(['history', 'sprint-32'])
    assert.equal(log.code, 0, log.err)
    assert.match(log.out, /^\S+ human sprint.reopen state=closed->open,carried=csv-export->\(unset\) dana$/m)
    assert.match(log.out, /^\S+ human sprint.close state=open->closed,carried=\(unset\)->csv-export dana$/m)
    assert.match(log.out, /^\S+ human sprint.open state=open,start=2026-09-21,end=2026-10-02 dana$/m)
    await insideEveryWidth(['history', 'sprint-32'])
  })

  it('reports an item pointing at no sprint record as H26 on doctor, rather than refusing the record', async () => {
    // csv-export was filed in August, so its record lives in that month's shard.
    const shard = path.join(demo.root, 'items', '2026-08.md')
    const before = await readFile(shard, 'utf8')
    assert.match(before, /^sprint_id: sprint-32$/m, 'the fixture no longer points csv-export at sprint-32')
    await writeFile(shard, before.replace('sprint_id: sprint-32', 'sprint_id: sprint-99'))
    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 7)
    assert.match(doctor.out, /^H26 csv-export sprint_id sprint_id is sprint-99 and no sprint record carries that id; open one with --id sprint-99, or commit the item to a sprint that exists$/m)
    const shown = await cli(['show', 'csv-export'])
    assert.equal(shown.code, 0, 'the record still serves')
    const why = await cli(['explain', 'csv-export'])
    assert.match(why.out, /^H26 /m)
  })

  it('refuses a sprint id an item holds and an item id a sprint holds, because history is keyed by id alone', async () => {
    const asItem = await cli(['sprint', 'open', 'Sprint over an item', '--id', 'csv-export', '--end', '2026-09-12'])
    assert.equal(asItem.code, 2, asItem.out)
    assert.match(asItem.err, /^rule I5$/m)
    assert.match(asItem.err, /^"cause csv-export is an item here, and an id names one thing/m)
    const asSprint = await cli(['file', 'task', 'A task named like a sprint', '--id', 'sprint-31'])
    assert.equal(asSprint.code, 2, asSprint.out)
    assert.match(asSprint.err, /^rule I5$/m)
    assert.match(asSprint.err, /^"cause sprint-31 is a sprint here, and an id names one thing/m)
    const history = await cli(['history', 'sprint-31', '--out', 'agent'])
    assert.equal(history.code, 0, history.err)
    assert.doesNotMatch(history.out, /item\.file/, 'the sprint\'s history carries no item event')
  })
})

// A closed sprint's completion used to rise after it closed. `committedTo` restores what the
// carry-over took away and the tally read the states of the moment, so an item carried out of
// one sprint and finished in the next was counted done in both and throughput was inflated by
// construction. ADR-0022 records the decision to freeze the tally at close.
describe('a carried item counts as done in the sprint that finished it, and in no other', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('leaves the closed sprint at 0/1 while the sprint that finished the work reports 1/1', async () => {
    assert.equal((await cli(['sprint', 'open', 'Sprint A', '--id', 'sprint-a', '--start', '2026-09-07', '--end', '2026-09-18'])).code, 0)
    const committed = await cli(['sprint', 'commit', 'sprint-a', 'avatar-crop'])
    assert.equal(committed.code, 0, committed.err)
    const closed = await cli(['sprint', 'close', 'sprint-a'])
    assert.equal(closed.code, 0, closed.err)
    assert.match(closed.out, /^set done - -> 0$/m)
    assert.match(closed.out, /^set done_points - -> 0$/m)
    assert.match(closed.out, /^carried avatar-crop$/m)

    assert.equal((await cli(['sprint', 'open', 'Sprint B', '--id', 'sprint-b', '--start', '2026-09-21', '--end', '2026-10-02'])).code, 0)
    const onward = await cli(['sprint', 'commit', 'sprint-b', 'avatar-crop'])
    assert.equal(onward.code, 0, onward.err)
    for (const target of ['in_progress', 'done']) {
      const moved = await cli(['transition', 'avatar-crop', target])
      assert.equal(moved.code, 0, moved.err)
    }

    const first = await cli(['sprints', 'sprint-a'])
    assert.match(first.out, /^committed 1$/m, 'the carry-over is still in the closed sprint\'s committed set')
    assert.match(first.out, /^done 0$/m, 'and it was not done when the sprint closed')
    assert.match(first.out, /^pts 0\/2$/m)
    const second = await cli(['sprints', 'sprint-b'])
    assert.match(second.out, /^done 1$/m)
    assert.match(second.out, /^pts 2\/2$/m)
    const list = await cli(['sprints'])
    assert.match(list.out, /^sprint-a closed 2026-09-07 2026-09-18 0\/1 0\/2 Sprint A$/m)
    assert.match(list.out, /^sprint-b open 2026-09-21 2026-10-02 1\/1 2\/2 Sprint B$/m)

    // The two numbers are on the record, so a reader of sprints.md sees the same velocity.
    const file = await readFile(path.join(demo.root, 'sprints.md'), 'utf8')
    assert.match(file, /^carried: avatar-crop\ndone: 0\ndone_points: 0$/m)
  })

  it('reads live again once the sprint is reopened, because the freeze is what the close recorded', async () => {
    const reopened = await cli(['sprint', 'reopen', 'sprint-a'])
    assert.equal(reopened.code, 0, reopened.err)
    assert.match(reopened.out, /^set done 0 -> -$/m)
    assert.match(reopened.out, /^set done_points 0 -> -$/m)
    const record = await cli(['sprints', 'sprint-a'])
    assert.match(record.out, /^committed 0$/m, 'the carry-over is cleared, so nothing points at it any more')
    assert.doesNotMatch(record.out, /^carried /m)
  })
})

// A sprint is a record with an id, and `show` and `explain` used to answer NOT_FOUND with
// "is in no record here" while `history` answered from the same id (ADR-0022).
describe('an id-taking read that is handed a sprint id names the read that works', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  before(async () => {
    assert.equal((await runCli(['sprint', 'open', 'Sprint 31', '--id', 'sprint-31', '--end', '2026-09-18'], { cwd: demo.root })).code, 0)
  })

  it('refuses show and explain by saying it is a sprint, and names sprints and backlog --sprint', async () => {
    for (const command of ['show', 'explain']) {
      const refused = await cli([command, 'sprint-31'])
      assert.equal(refused.code, 5, refused.out)
      assert.match(refused.err, /^rule I5$/m)
      assert.match(refused.err, new RegExp(`^"cause sprint-31 is a sprint here, not an item, and ${command} reads items$`, 'm'))
      assert.match(refused.err, /^fix treadle sprints sprint-31$/m)
      assert.match(refused.err, /^fix treadle backlog --sprint sprint-31$/m)
    }
    assert.equal((await cli(['sprints', 'sprint-31'])).code, 0)
    assert.equal((await cli(['history', 'sprint-31'])).code, 0)
  })

  it('offers a mistyped sprint id as a near miss, so the next line reaches the refusal above', async () => {
    const missed = await cli(['show', 'sprint-3'])
    assert.equal(missed.code, 5)
    assert.match(missed.err, /^near sprint-31$/m)
  })
})

// Row 12 of the audit: a sprint admits work `next` will never suggest, and nothing said why.
// The admission is deliberate, so what is held here is that every surface a caller reads
// names those ids rather than leaving them inside a tally (ADR-0022).
describe('a sprint says which of its committed work is not groomed yet', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    assert.equal((await runCli(['sprint', 'open', 'Sprint 31', '--id', 'sprint-31', '--end', '2026-09-18'], { cwd: demo.root })).code, 0)
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('says it at the moment of committing, with the line that grooms the first one', async () => {
    // metrics-p95 and queue-drain are draft; avatar-crop is ready.
    const committed = await cli(['sprint', 'commit', 'sprint-31', 'avatar-crop', 'metrics-p95', 'queue-drain'])
    assert.equal(committed.code, 0, committed.err)
    assert.match(committed.out, /^not_ready metrics-p95,queue-drain$/m)
    assert.match(committed.out, /^note metrics-p95,queue-drain are draft, and next ranks ready work; treadle transition metrics-p95 ready$/m)
  })

  it('says it on file --sprint, which files in draft and so always has something to say', async () => {
    const filed = await cli(['file', 'task', 'Rotate the deploy key', '--id', 'deploy-key', '--points', '1', '--sprint', 'sprint-31'])
    assert.equal(filed.code, 0, filed.err)
    assert.match(filed.out, /^set sprint_id - -> sprint-31$/m)
    assert.match(filed.out, /^not_ready deploy-key$/m)
    assert.match(filed.out, /^note deploy-key is draft, and next ranks ready work; treadle transition deploy-key ready$/m)
  })

  it('names them on sprints <id> and on status, beside the tally rather than inside it', async () => {
    const record = await cli(['sprints', 'sprint-31'])
    assert.match(record.out, /^committed 4$/m)
    assert.match(record.out, /^done 0$/m)
    assert.match(record.out, /^not_ready deploy-key,metrics-p95,queue-drain$/m, 'three of the four committed items are not workable')
    const orientation = await cli(['status'])
    assert.match(orientation.out, /^not_ready deploy-key,metrics-p95,queue-drain$/m)
  })

  it('lists them by id in the board draft column, which is the read that made this visible', async () => {
    const board = await cli(['board'])
    assert.equal(board.code, 0, board.err)
    const draft = board.out.slice(board.out.indexOf('~draft'), board.out.indexOf('~ready'))
    for (const id of ['deploy-key', 'metrics-p95', 'queue-drain']) {
      assert.match(draft, new RegExp(`^${id} `, 'm'), `the draft column does not name ${id}`)
    }
  })

  it('stops saying it once the work is groomed, and next then ranks it', async () => {
    for (const id of ['deploy-key', 'metrics-p95', 'queue-drain']) {
      assert.equal((await cli(['transition', id, 'ready'])).code, 0)
    }
    const record = await cli(['sprints', 'sprint-31'])
    assert.doesNotMatch(record.out, /^not_ready /m)
    assert.doesNotMatch((await cli(['status'])).out, /^not_ready /m)
    assert.match((await cli(['next', '--limit', '20'])).out, /^deploy-key /m)
  })
})
