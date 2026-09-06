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
    assert.match(status.out, /^absent_features board$/m)
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
})
