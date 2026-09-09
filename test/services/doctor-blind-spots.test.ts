// SPDX-License-Identifier: Apache-2.0
// Four ways a damaged workspace answered `clean ... ` at exit 0, held closed here.
//
// Each is the load-time half of a rule the write path already enforces, and each was found by
// damaging a real workspace and running the command a caller runs, so every assertion here
// drives the published surface rather than the audit class: the symptom is what `doctor`
// prints and what it exits with, and three of the four are invisible one layer down.
//
// 1. `H31`. Deleting the event log left `clean checked 8 items and 0 events` at exit 0. The
//    store reports the log's own findings, and a file that is GONE has none to report.
// 2. `H32`, on the record. A `blocks` edge hand-written onto a done record left `show`
//    printing `blocked_by` while `explain` said `blocked no`, with nothing between them.
//    `relation add` refuses that edge as `R5`.
// 3. `H32`, on the log. An edge is stored once, on its source, so deleting a blocker's record
//    by hand takes the edge with it and every dependent silently reads `blocked no`.
// 4. `H18`. A hold is written with `hold_until` in the future and read with no liveness rule
//    at all, so a hold that ran out held its dependents with nothing anywhere saying so.
//
// The negative cases carry the weight: a workspace nothing is wrong with, and the same
// damage done THROUGH the tool, both stay clean. A finding that fires on the ordinary case is
// the trap `H27` had to be narrowed to escape.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

type Work = {
  readonly cwd: string
  readonly run: (argv: readonly string[]) => ReturnType<typeof runCli>
  readonly shard: () => Promise<string>
  readonly editShard: (edit: (text: string) => string) => Promise<void>
  readonly dispose: () => Promise<void>
}

/** A real workspace on disk, made by `init`, because a hand edit is what these tests apply. */
async function aWorkspace(): Promise<Work> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'treadle-blind-'))
  const run = (argv: readonly string[]) => runCli(argv, { cwd, env: { TREADLE_ACTOR: 'alice' } })
  const started = await run(['init'])
  assert.equal(started.code, 0, started.err)
  const file = path.join(cwd, '.work', 'items', '2026-09.md')
  return {
    cwd,
    run,
    shard: () => readFile(file, 'utf8'),
    editShard: async (edit) => { await writeFile(file, edit(await readFile(file, 'utf8')), 'utf8') },
    dispose: () => rm(cwd, { recursive: true, force: true }),
  }
}

/** The record heading a hand edit cuts at, which is where one record ends and the next begins. */
function headingOf(id: string): string {
  return `# ${id}:`
}

describe('H31: the log is held to what the records remember of it', () => {
  it('reports every record the deleted log no longer accounts for, and exits 7', async () => {
    const work = await aWorkspace()
    try {
      for (const n of [1, 2, 3]) {
        assert.equal((await work.run(['file', 'task', `task number ${n}`])).code, 0)
      }
      const intact = await work.run(['doctor'])
      assert.equal(intact.code, 0, 'the workspace is sound before the log is touched')
      assert.match(intact.out, /^clean checked 3 items and 4 events$/m)

      const log = path.join(work.cwd, '.work', 'events', '2026-09.jsonl')
      await unlink(log)

      const after = await work.run(['doctor'])
      assert.equal(after.code, 7, 'a workspace whose log has gone is not clean')
      assert.doesNotMatch(after.out, /^clean /m)
      for (const n of [1, 2, 3]) {
        assert.match(
          after.out,
          new RegExp(`^H31 task-number-${n} version the record is at version 1 and the log holds 0 events naming it;`, 'm'),
        )
      }
    } finally {
      await work.dispose()
    }
  })

  it('says nothing about a record the log holds more events for than the record has versions', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'a task'])).code, 0)
      // Removed and refiled under one id, which is the migration a retired `type` value takes
      // (ADR-0029): the log keeps the old record's trail and the new record restarts at
      // version 1, so the count runs AHEAD of the version and this rule is silent on it.
      assert.equal((await work.run(['remove', 'a-task', '--reason', 'mis-typed', '--yes'])).code, 0)
      assert.equal((await work.run(['file', 'task', 'a task'])).code, 0)
      const checked = await work.run(['doctor'])
      assert.doesNotMatch(checked.out, /^H31 /m)
    } finally {
      await work.dispose()
    }
  })
})

describe('H32: a record and the log are held to the same set of edges', () => {
  it('reports an edge the record stores that no event recorded, and its fix line clears it', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'blocker work'])).code, 0)
      assert.equal((await work.run(['file', 'task', 'dependent work'])).code, 0)
      for (const to of ['ready', 'in_progress', 'done']) {
        assert.equal((await work.run(['transition', 'blocker-work', to])).code, 0)
      }
      // The write path's own answer, which is the rule this finding is the load-time half of.
      const refused = await work.run(['relation', 'add', 'blocker-work', 'blocks', 'dependent-work'])
      assert.equal(refused.code, 3)
      assert.match(refused.err, /^rule R5$/m)

      await work.editShard((text) => {
        const at = text.indexOf(headingOf('dependent-work'))
        return `${text.slice(0, at)}## Relations\n\n- blocks dependent-work\n\n${text.slice(at)}`
      })

      const found = await work.run(['doctor'])
      assert.equal(found.code, 7, 'an edge no write path would have accepted is not a clean store')
      assert.match(found.out, /^H32 blocker-work relations the record stores blocks dependent-work and no event in the log recorded it,/m)
      // The per-item half of the same audit, which is the half `explain` reads: this direction
      // needs only the holder's own record and its own events, so both surfaces raise it.
      assert.match((await work.run(['explain', 'blocker-work'])).out,
        /^H32 the record stores blocks dependent-work and no event in the log recorded it,/m)
      // The two surfaces that disagreed over this edge, which is the symptom a reader saw.
      assert.match((await work.run(['show', 'dependent-work'])).out, /^blocked_by blocker-work$/m)
      assert.match((await work.run(['explain', 'dependent-work'])).out, /^blocked no$/m)

      // Every line the tool prints for a reader to run, runs as printed from the state that
      // printed it, so the finding's own remedy is driven rather than asserted.
      assert.equal((await work.run(['relation', 'remove', 'blocker-work', 'blocks', 'dependent-work'])).code, 0)
      const cleared = await work.run(['doctor'])
      assert.equal(cleared.code, 0)
      assert.match(cleared.out, /^clean /m)
    } finally {
      await work.dispose()
    }
  })

  it('reports an edge the log records whose holder record was deleted outside the tool', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'blocker one'])).code, 0)
      assert.equal((await work.run(['file', 'task', 'dependent one'])).code, 0)
      assert.equal((await work.run(['relation', 'add', 'blocker-one', 'blocks', 'dependent-one'])).code, 0)

      await work.editShard((text) =>
        text.slice(0, text.indexOf(headingOf('blocker-one'))) + text.slice(text.indexOf(headingOf('dependent-one'))))

      const found = await work.run(['doctor'])
      assert.equal(found.code, 7, 'a blocker that vanished with its edge is not a clean store')
      assert.match(found.out, /^H32 blocker-one relations the log records blocks dependent-one held by blocker-one and no record here carries that id,/m)
      // The symptom the finding exists for: nothing else anywhere says the blocker was there.
      const dependent = await work.run(['explain', 'dependent-one'])
      assert.match(dependent.out, /^blocked no$/m)
      // And why `doctor` alone raises this direction, which the H table says in words: the
      // finding belongs to the holder, and the holder is no record for `explain` to be asked
      // about, so no per-item read can reach it however the caller spells the question.
      assert.doesNotMatch(dependent.out, /^H32 /m)
      assert.equal((await work.run(['explain', 'blocker-one'])).code, 5, 'the holder is not a record here to explain')
    } finally {
      await work.dispose()
    }
  })

  it('says nothing when the same record leaves through remove, which records its going', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'blocker two'])).code, 0)
      assert.equal((await work.run(['file', 'task', 'dependent two'])).code, 0)
      assert.equal((await work.run(['relation', 'add', 'blocker-two', 'blocks', 'dependent-two'])).code, 0)
      assert.equal((await work.run(['relation', 'remove', 'blocker-two', 'blocks', 'dependent-two'])).code, 0)
      assert.equal((await work.run(['remove', 'blocker-two', '--reason', 'mis-filed', '--yes'])).code, 0)

      const checked = await work.run(['doctor'])
      assert.equal(checked.code, 0, 'the tool doing the same thing is not a finding')
      assert.match(checked.out, /^clean /m)
    } finally {
      await work.dispose()
    }
  })
})

describe('H18: a hold is read against the clock the write path measured it by', () => {
  it('reports a hold that has run out while the item is still on_hold', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'vendor blocker'])).code, 0)
      assert.equal((await work.run(['file', 'task', 'waiting work'])).code, 0)
      assert.equal((await work.run(['relation', 'add', 'vendor-blocker', 'blocks', 'waiting-work'])).code, 0)
      assert.equal((await work.run(['transition', 'vendor-blocker', 'ready'])).code, 0)
      // The write path's own answer, which is the rule this finding is the load-time half of.
      const refused = await work.run(
        ['transition', 'vendor-blocker', 'on_hold', '--reason', 'vendor', '--until', '2020-01-01T00:00:00Z'])
      assert.equal(refused.code, 2)
      assert.match(refused.err, /hold_until 2020-01-01T00:00:00Z is not in the future/)

      assert.equal((await work.run(
        ['transition', 'vendor-blocker', 'on_hold', '--reason', 'vendor', '--until', '2099-01-01T00:00:00Z'])).code, 0)
      const live = await work.run(['doctor'])
      assert.equal(live.code, 0, 'a hold that is still running is a workspace nothing is wrong with')
      assert.match(live.out, /^clean /m)

      // The clock moving is what expires a hold, and a stored past instant is what the clock
      // moving leaves behind; the record is edited rather than the clock, because the same
      // bytes are what a workspace holds the morning after.
      await work.editShard((text) => text.replace('hold_until: 2099-01-01T00:00:00Z', 'hold_until: 2026-09-01T00:00:00Z'))

      const found = await work.run(['doctor'])
      assert.equal(found.code, 7)
      assert.match(found.out, /^H18 vendor-blocker hold_until the hold ran out at 2026-09-01T00:00:00Z and the item is still on_hold,/m)
      // The per-item half of the same audit, which is what a caller asking about one item reads.
      assert.match((await work.run(['explain', 'vendor-blocker'])).out, /^H18 the hold ran out at 2026-09-01T00:00:00Z/m)
      // The dependent is what the expired hold was holding, and it still reads blocked.
      assert.match((await work.run(['explain', 'waiting-work'])).out, /^blocked yes vendor-blocker$/m)
    } finally {
      await work.dispose()
    }
  })
})

describe('H19: the assignee marking their own work is a line a reader weighs', () => {
  it('reports the assignee writing severity, and does not refuse over it', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'bug', 'ship it', '--set', 'assignee=alice',
        '--set', 'severity=S3', '--set', 'found_in=production', '--set', 'repro_steps=retry'])).code, 0)
      assert.equal((await work.run(['mark', 'ship-it', '--severity', 'S1', '--reason', 'the revenue path'])).code, 0)

      const found = await work.run(['doctor'])
      assert.match(found.out, /^H19 ship-it \S+ alice changed severity on an item they are assigned;/m)
      // An audit note over a record that serves whole, so it prints and the store is sound:
      // the move that stops a self-review is DOD3, at write time, where a refusal belongs.
      assert.equal(found.code, 0, 'H19 names who wrote a field, not content this store cannot serve')
      assert.match(found.out, /^serving /m)
    } finally {
      await work.dispose()
    }
  })

  it('says nothing when somebody other than the assignee marks it', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'bug', 'ship it', '--set', 'assignee=alice',
        '--set', 'severity=S3', '--set', 'found_in=production', '--set', 'repro_steps=retry'])).code, 0)
      assert.equal((await work.run(
        ['mark', 'ship-it', '--severity', 'S1', '--reason', 'the revenue path', '--actor', 'kim'])).code, 0)
      assert.doesNotMatch((await work.run(['doctor'])).out, /^H19 /m)
    } finally {
      await work.dispose()
    }
  })

  // Half of the defect this rule was widened for, and the half easiest to forget: the audit
  // pointed at the compliant agent. `H19` fired on `item.set reviewer` by the assignee, which
  // is what the `DOD3` refusal's own fix line tells an assignee to do, and stayed silent on the
  // laundered record - because the launder rewrote the very field this test read. Naming your
  // own reviewer buys nothing now that `DOD3` reads the log for who did the work, so the arm
  // is gone and `H34` below reports the accept itself.
  it('does not flag the assignee who named a real reviewer, which is the printed remedy', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'story', 'ship it', '--set', 'assignee=alice'])).code, 0)
      assert.equal((await work.run(['set', 'ship-it', 'reviewer=bob'])).code, 0)
      const found = await work.run(['doctor'])
      assert.equal(found.code, 0, found.out)
      assert.match(found.out, /^clean /m, found.out)
    } finally {
      await work.dispose()
    }
  })
})

// What the audit says about a record one actor took the whole way. No write path refuses that
// shape and none should - one agent filing, working and accepting an item is legitimate and
// common in a fleet (ADR-0034) - so what was wrong was the audit calling such a record clean,
// which told a reader a second pair of eyes had been over it.
describe('H34: a done record whose whole log names one actor', () => {
  // `review_step` is workspace configuration, so widening it turns records already closed
  // into records that would not close now. One `config set` is the whole reproduction, and it
  // is the case the detail's last clause names: an accept nothing refused, under a rule that
  // did not apply to that type at the time.
  it('reports an accept the worker ran under a review step set afterwards', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'ship it', '--set', 'assignee=alice'])).code, 0)
      for (const to of ['ready', 'in_progress', 'done']) {
        assert.equal((await work.run(['transition', 'ship-it', to])).code, 0)
      }
      assert.equal((await work.run(['doctor'])).code, 0, 'a task has no review step, so DOD3 says nothing about it')

      assert.equal((await work.run(
        ['config', 'set', 'review_step', 'story, bug, epic, task'])).code, 0)
      const found = await work.run(['doctor'])
      assert.match(found.out, /^H34 ship-it state alice filed, worked and accepted this item and no other actor appears in its log, so this is single-actor completion and no second party saw the work; treadle history ship-it$/m)
    } finally {
      await work.dispose()
    }
  })

  // The defect this rule was rewritten for: alice named a reviewer who never touched the item
  // and accepted it herself, and every read said the work was clean. Nothing here is refused
  // now, and the audit is where the fact lands. The item carries no assignee at all, which is
  // the cheap version - the trail this used to be decided against was folded off `assignee`
  // and was empty, so the old finding could not see it.
  it('reports the item one actor filed, worked and accepted with nobody assigned', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'story', 'ship it'])).code, 0)
      assert.equal((await work.run(['set', 'ship-it', 'acceptance_criteria=[x] it ships'])).code, 0)
      assert.equal((await work.run(['set', 'ship-it', 'reviewer=bob'])).code, 0)
      for (const to of ['ready', 'in_progress', 'in_review']) {
        assert.equal((await work.run(['transition', 'ship-it', to])).code, 0)
      }
      assert.equal((await work.run(
        ['evidence', 'add', 'ship-it', 'url', 'https://example.invalid/pr/1', 'the pr'])).code, 0)
      assert.equal((await work.run(['transition', 'ship-it', 'done'])).code, 0,
        'a single actor taking an item the whole way is a shape the write path allows')

      const found = await work.run(['doctor'])
      assert.match(found.out, /^H34 ship-it state alice filed, worked and accepted this item and no other actor appears in its log, so this is single-actor completion and no second party saw the work; treadle history ship-it$/m)
      assert.doesNotMatch(found.out, /^clean /m)
    } finally {
      await work.dispose()
    }
  })

  it('says nothing about the accept a reviewer ran, which is the honest path', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'story', 'ship it', '--set', 'assignee=alice'])).code, 0)
      assert.equal((await work.run(['set', 'ship-it', 'acceptance_criteria=[x] it ships'])).code, 0)
      assert.equal((await work.run(['set', 'ship-it', 'reviewer=bob'])).code, 0)
      for (const to of ['ready', 'in_progress', 'in_review']) {
        assert.equal((await work.run(['transition', 'ship-it', to])).code, 0)
      }
      assert.equal((await work.run(
        ['evidence', 'add', 'ship-it', 'url', 'https://example.invalid/pr/1', 'the pr'])).code, 0)
      const accepted = await runCli(['transition', 'ship-it', 'done'], { cwd: work.cwd, env: { TREADLE_ACTOR: 'bob' } })
      assert.equal(accepted.code, 0, accepted.err)

      const found = await work.run(['doctor'])
      assert.equal(found.code, 0, found.out)
      assert.match(found.out, /^clean /m, found.out)
    } finally {
      await work.dispose()
    }
  })
})

// The "not lost" clause, asked of the memory an agent reads back. A shard cut mid-file turned
// ten records into seven and no read said so: `doctor` reported `checked 7` with nothing about
// the three, `status` reported `items 7 findings 0`, and `history` for a vanished id printed
// the sentence a deliberate `remove` earns. The removal boundary this file already held covered
// EDGES, which is why the one lost record that happened to hold one was reported and the two
// that held none were not.
describe('H33: a record the log filed, nothing removed, and no shard carries', () => {
  it('names every record a cut shard took, and tells it from a removal', async () => {
    const work = await aWorkspace()
    try {
      for (const title of ['one thing', 'two thing', 'three thing', 'four thing']) {
        assert.equal((await work.run(['file', 'task', title])).code, 0)
      }
      assert.equal((await work.run(['remove', 'one-thing', '--reason', 'a duplicate', '--yes'])).code, 0)
      assert.equal((await work.run(['doctor'])).code, 0, 'a removal through the tool leaves nothing to report')

      // The cut falls on a record boundary, so every record left parses and the store reports
      // no finding of its own: this is the shape that read clean.
      await work.editShard((text) => text.slice(0, text.indexOf(headingOf('three-thing'))))

      const found = await work.run(['doctor'])
      assert.equal(found.code, 7, found.out)
      assert.match(found.out, /^H33 three-thing items the log filed three-thing at \S+ and recorded no removal of it, and no record here carries that id, so the record left the store outside the tool/m)
      assert.match(found.out, /^H33 four-thing items /m)
      assert.doesNotMatch(found.out, /^H33 one-thing /m, 'the record remove took is not lost, and the log says so')

      // The sentence a reader acts on: a loss and a removal must not read the same.
      const lost = await work.run(['history', 'three-thing'])
      assert.match(lost.out, /^note no record here carries this id and the log records no removal of it, so the record left the store outside the tool; these are the events it earned, and treadle doctor reports it as H33$/m)
      const removed = await work.run(['history', 'one-thing'])
      assert.match(removed.out, /^note this record was removed; the log keeps every event it earned while it was here$/m)
    } finally {
      await work.dispose()
    }
  })

  it('says nothing about an id the log filed, removed and filed again', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'one thing'])).code, 0)
      assert.equal((await work.run(['remove', 'one-thing', '--reason', 'the wrong type', '--yes'])).code, 0)
      assert.equal((await work.run(['file', 'story', 'one thing', '--id', 'one-thing'])).code, 0)
      assert.equal((await work.run(['doctor'])).code, 0)

      // Removed, refiled, and the refiled record then lost: the removal is older than the
      // filing it is read against, so it settles nothing and the loss is reported.
      await work.editShard((text) => text.slice(0, text.indexOf(headingOf('one-thing'))))
      assert.match((await work.run(['doctor'])).out, /^H33 one-thing items /m)
    } finally {
      await work.dispose()
    }
  })
})

// What `DOD3` still decides, now that who runs the accept is not its business: the record
// names a reviewer, and not the person the work is assigned to. The actor half it carried is
// gone with ADR-0034, and `H34` above is what reports the shape it used to refuse.
describe('DOD3: the record names a reviewer other than the assignee', () => {
  it('takes the accept the assignee runs and reports it, having refused the record naming no reviewer', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'story', 'ship it', '--set', 'assignee=alice'])).code, 0)
      assert.equal((await work.run(['set', 'ship-it', 'acceptance_criteria=[x] it ships'])).code, 0)
      for (const to of ['ready', 'in_progress', 'in_review']) {
        assert.equal((await work.run(['transition', 'ship-it', to])).code, 0)
      }
      assert.equal((await work.run(
        ['evidence', 'add', 'ship-it', 'url', 'https://example.invalid/pr/1', 'the pr'])).code, 0)

      // The field half, which still refuses: no reviewer is named.
      const refused = await work.run(['transition', 'ship-it', 'done'])
      assert.equal(refused.code, 3, refused.err)
      assert.match(refused.err, /^"cause the done gate fails: DOD3$/m)
      // And the actor half, which does not: alice names bob and runs her own accept.
      assert.equal((await work.run(['set', 'ship-it', 'reviewer=bob'])).code, 0)
      const accepted = await work.run(['transition', 'ship-it', 'done'])
      assert.equal(accepted.code, 0, accepted.err)
      assert.match(accepted.out, /^state in_review -> done$/m)

      // `explain` evaluates the gate the move is decided by, so the two cannot disagree.
      assert.match((await work.run(['explain', 'ship-it'])).out, /^rules 8\/8 pass$/m)
      assert.match((await work.run(['doctor'])).out, /^H34 ship-it state alice filed, worked and accepted this item /m)
    } finally {
      await work.dispose()
    }
  })
})

describe('an undamaged workspace stays clean through all of it', () => {
  it('reports nothing over a live hold, a real edge and a whole log', async () => {
    const work = await aWorkspace()
    try {
      assert.equal((await work.run(['file', 'task', 'one thing'])).code, 0)
      assert.equal((await work.run(['file', 'task', 'two thing'])).code, 0)
      assert.equal((await work.run(['relation', 'add', 'one-thing', 'blocks', 'two-thing'])).code, 0)
      assert.equal((await work.run(['transition', 'one-thing', 'ready'])).code, 0)
      assert.equal((await work.run(
        ['transition', 'one-thing', 'on_hold', '--reason', 'parked', '--until', '2099-01-01T00:00:00Z'])).code, 0)
      const checked = await work.run(['doctor'])
      assert.equal(checked.code, 0)
      assert.match(checked.out, /^clean checked 2 items and \d+ events$/m)
    } finally {
      await work.dispose()
    }
  })
})
