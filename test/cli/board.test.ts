// SPDX-License-Identifier: Apache-2.0
// The board at the command surface, driven the way a caller drives it. Each judgement call
// ADR-0018 argues is held here as a line a caller sees: five live-state columns in flow
// order with the empty ones printed, the terminal states as counts, a blocked row first in
// its column with its blocker named, the one open sprint as the default scope with the way
// out of it printed, two open sprints refused, and a cap per column with the total beside it.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { displayWidth } from '../../src/adapters/render/width.ts'
import { WORK_ITEM_STATES } from '../../src/domain/index.ts'
import { BOARD_STATES } from '../../src/application/services/board.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

const WIDTHS = [40, 60, 80, 100, 200] as const

/** The `~<state> <shown> <total>` headers of an agent rendering, in the order they were emitted. */
function blocks(out: string): readonly (readonly [string, number, number])[] {
  return [...out.matchAll(/^~(\S+) (\d+) (\d+)$/gm)].map((m) => [m[1] as string, Number(m[2]), Number(m[3])])
}

/** The rows under one block of an agent rendering, each split on its arity-1 spaces. */
function rowsOf(out: string, state: string): readonly (readonly string[])[] {
  const lines = out.split('\n')
  const at = lines.findIndex((line) => line.startsWith(`~${state} `))
  assert.ok(at >= 0, `no ${state} block in\n${out}`)
  const rows: string[][] = []
  for (const line of lines.slice(at + 1)) {
    if (line.startsWith('~') || line.length === 0) break
    if (line.startsWith('#')) continue
    rows.push(line.split(' '))
  }
  return rows
}

describe('the board at the command surface', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  async function insideEveryWidth(argv: readonly string[]): Promise<void> {
    for (const width of WIDTHS) {
      const run = await cli([...argv, '--out', 'human', '--width', String(width)])
      for (const line of (run.out + run.err).trimEnd().split('\n')) {
        assert.ok(displayWidth(line) <= width, `${argv.join(' ')} at ${width}: "${line}" is ${displayWidth(line)} cells`)
      }
    }
  }

  it('is the backlog grouped by state: one block per live state in flow order, the terminal states as counts', async () => {
    const run = await cli(['board', '--out', 'agent'])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /^ok board acme-platform$/m)
    assert.match(run.out, /^scope workspace$/m)
    assert.deepEqual(blocks(run.out).map(([state]) => state), [...BOARD_STATES])
    // Every column's total is what `backlog --state` counts for that state, and the two
    // states without a column are the two the backlog counts as done and cancelled.
    for (const state of WORK_ITEM_STATES) {
      const list = await cli(['backlog', '--state', state, '--out', 'agent'])
      const total = Number(/^~items \d+ (\d+)$/m.exec(list.out)?.[1])
      const column = blocks(run.out).find(([name]) => name === state)
      if (column === undefined) {
        assert.ok(state === 'done' || state === 'cancelled', `${state} has no column`)
        assert.match(run.out, new RegExp(`^${state} ${total}$`, 'm'))
      } else {
        assert.equal(column[2], total, `${state} total`)
      }
    }
    // Each row sits under the block that names its state.
    const typed = await cli(['board', '--fields', 'id,state', '--out', 'agent'])
    for (const state of BOARD_STATES) {
      for (const row of rowsOf(typed.out, state)) assert.equal(row[1], state, `${row[0]} is under ${state}`)
    }
  })

  it('prints an empty column rather than dropping it, and says when nothing at all matched', async () => {
    const one = await cli(['board', '--state', 'in_review', '--out', 'agent'])
    assert.equal(one.code, 0, one.err)
    assert.deepEqual(blocks(one.out), [['draft', 0, 0], ['ready', 0, 0], ['in_progress', 0, 0], ['in_review', 1, 1], ['on_hold', 0, 0]])
    const none = await cli(['board', '--assignee', 'nobody', '--out', 'agent'])
    assert.equal(none.code, 0, none.err)
    assert.match(none.out, /^none searched 24 matched 0$/m)
    assert.match(none.out, /^narrowest assignee nobody 0$/m)
    assert.doesNotMatch(none.out, /^sort /m)
    assert.equal(blocks(none.out).length, BOARD_STATES.length)
  })

  it('puts a blocked row first in its column with the blocker named, and lets it fall back when the block is lifted', async () => {
    const before = await cli(['board', '--out', 'agent'])
    assert.deepEqual(rowsOf(before.out, 'ready')[0]?.[0], 'flaky-e2e', 'priority order before anything is blocked')
    assert.match(before.out, /^blocked 0$/m)

    const linked = await cli(['relation', 'add', 'sess-timeout', 'blocks', 'gdpr-export'])
    assert.equal(linked.code, 0, linked.err)
    const run = await cli(['board', '--out', 'agent'])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /^sort blocked,priority,filed,id$/m)
    assert.match(run.out, /^blocked 1$/m)
    const ready = rowsOf(run.out, 'ready')
    assert.deepEqual(ready[0]?.slice(0, 5), ['gdpr-export', 'story', '5', '-', 'sess-timeout'])
    assert.deepEqual(ready[1]?.[0], 'flaky-e2e')
    for (const row of ready.slice(1)) assert.equal(row[4], '-', `${row[0]} is not blocked`)
    // The blocker is a draft, so it is on the same board, one column to the left.
    assert.ok(rowsOf(run.out, 'draft').some((row) => row[0] === 'sess-timeout'))

    const human = await cli(['board', '--out', 'human'])
    assert.match(human.out, /^ready  6 of 6$/m)
    assert.match(human.out, /^  gdpr-export +story +5 +- +sess-timeout +Export everything/m)
    await insideEveryWidth(['board'])

    const unlinked = await cli(['relation', 'remove', 'sess-timeout', 'blocks', 'gdpr-export'])
    assert.equal(unlinked.code, 0, unlinked.err)
    const after = await cli(['board', '--out', 'agent'])
    assert.deepEqual(rowsOf(after.out, 'ready')[0]?.[0], 'flaky-e2e')
    assert.match(after.out, /^blocked 0$/m)
  })

  it('caps every column at --limit with the total beside it, and refuses a cursor because there is no one order to resume', async () => {
    const capped = await cli(['board', '--limit', '1', '--out', 'agent'])
    assert.equal(capped.code, 0, capped.err)
    assert.deepEqual(blocks(capped.out), [['draft', 1, 11], ['ready', 1, 6], ['in_progress', 1, 3], ['in_review', 1, 1], ['on_hold', 1, 1]])
    const cursor = await cli(['board', '--cursor', 'flaky-e2e', '--out', 'agent'])
    assert.equal(cursor.code, 2)
    assert.match(cursor.err, /^"cause --cursor cannot apply to board/m)
  })

  it('takes every column backlog has and blocked, and refuses the same column sets backlog refuses', async () => {
    const chosen = await cli(['board', '--fields', 'id,pri,sprint,blocked', '--out', 'agent'])
    assert.equal(chosen.code, 0, chosen.err)
    assert.match(chosen.out, /^#id pri sprint blocked$/m)
    const unknown = await cli(['board', '--fields', 'nope', '--out', 'agent'])
    assert.equal(unknown.code, 2)
    assert.match(unknown.err, /^rule C2$/m)
    assert.match(unknown.err, /^"cause nope is not a column of this list; the columns are id, type, state, pts, pri, sprint, assignee, title, sev, blocked$/m)
    const two = await cli(['board', '--fields', 'id,title,assignee', '--out', 'agent'])
    assert.equal(two.code, 2)
    assert.match(two.err, /^rule C3$/m)
    assert.match(two.err, /^fix treadle board --fields id,assignee$/m)
  })

  it('scopes itself to the one open sprint, prints the way out, and takes --all or --sprint instead', async () => {
    const opened = await cli(['sprint', 'open', 'Sprint 31', '--start', '2026-09-01', '--end', '2026-09-12'])
    assert.equal(opened.code, 0, opened.err)
    const committed = await cli(['sprint', 'commit', 'sprint-31', 'csv-export', 'webhook-retry'])
    assert.equal(committed.code, 0, committed.err)

    const scoped = await cli(['board', '--out', 'agent'])
    assert.equal(scoped.code, 0, scoped.err)
    assert.match(scoped.out, /^scope sprint-31 open day -?\d+\/12$/m)
    assert.match(scoped.out, /^whole treadle board --all$/m)
    assert.doesNotMatch(scoped.out, /^filter /m, 'the default scope is not a clause the caller wrote')
    assert.deepEqual(blocks(scoped.out), [['draft', 0, 0], ['ready', 2, 2], ['in_progress', 0, 0], ['in_review', 0, 0], ['on_hold', 0, 0]])
    assert.deepEqual(rowsOf(scoped.out, 'ready').map((row) => row[0]), ['csv-export', 'webhook-retry'])
    assert.match(scoped.out, /^done 0$/m)

    const named = await cli(['board', '--sprint', 'sprint-31', '--out', 'agent'])
    assert.equal(named.code, 0, named.err)
    assert.match(named.out, /^filter sprint sprint-31$/m)
    assert.doesNotMatch(named.out, /^whole /m)
    assert.deepEqual(blocks(named.out), blocks(scoped.out))

    const whole = await cli(['board', '--all', '--out', 'agent'])
    assert.equal(whole.code, 0, whole.err)
    assert.match(whole.out, /^scope workspace$/m)
    assert.doesNotMatch(whole.out, /^whole /m)
    assert.deepEqual(blocks(whole.out), [['draft', 9, 11], ['ready', 6, 6], ['in_progress', 3, 3], ['in_review', 1, 1], ['on_hold', 1, 1]])

    const absent = await cli(['board', '--explain-absence', 'sso-saml', '--out', 'agent'])
    assert.equal(absent.code, 0, absent.err)
    assert.match(absent.out, /^absent sso-saml$/m)
    assert.match(absent.out, /^clause sprint want sprint-31 got -$/m)

    const both = await cli(['board', '--all', '--sprint', 'sprint-31', '--out', 'agent'])
    assert.equal(both.code, 2)
    assert.match(both.err, /^rule C1$/m)
    assert.match(both.err, /^"cause --all and --sprint ask different questions/m)
    assert.match(both.err, /^fix treadle board --sprint sprint-31$/m)

    await insideEveryWidth(['board'])
    await insideEveryWidth(['board', '--all'])
    const human = await cli(['board', '--out', 'human'])
    assert.match(human.out, /^  scope  sprint-31 open day -?\d+\/12$/m)
    assert.match(human.out, /^  whole  treadle board --all$/m)
  })

  it('refuses a --sprint that is no record and that nothing points at, with the near ids, and still serves one a record points at', async () => {
    const typo = await cli(['board', '--sprint', 'sprint-13', '--out', 'agent'])
    assert.equal(typo.code, 5, typo.out)
    assert.match(typo.err, /^rule I5$/m)
    assert.match(typo.err, /^near sprint-31$/m)

    // A value no sprint record carries but some item still does is doctor's H26, and the
    // board over it is the way to see where that work sits.
    const shard = path.join(demo.root, 'items', '2026-09.md')
    const before = await readFile(shard, 'utf8')
    assert.ok(before.includes('sprint_id: sprint-31'), 'the fixture committed an item in this shard')
    await writeFile(shard, before.replace('sprint_id: sprint-31', 'sprint_id: sprint-old'), 'utf8')
    try {
      const leftover = await cli(['board', '--sprint', 'sprint-old', '--out', 'agent'])
      assert.equal(leftover.code, 0, leftover.err)
      assert.match(leftover.out, /^scope sprint-old$/m)
      assert.equal(blocks(leftover.out).reduce((sum, [, , total]) => sum + (total as number), 0), 1)
    } finally {
      await writeFile(shard, before, 'utf8')
    }
  })

  it('refuses to choose between two open sprints, naming each and the whole workspace as the ways out', async () => {
    const opened = await cli(['sprint', 'open', 'Sprint 32', '--start', '2026-09-13', '--end', '2026-09-26'])
    assert.equal(opened.code, 0, opened.err)
    const run = await cli(['board', '--out', 'agent'])
    assert.equal(run.code, 2)
    assert.match(run.err, /^rule C1$/m)
    assert.match(run.err, /^"cause 2 sprints are open, sprint-31 and sprint-32; a board is over one sprint or over the whole workspace$/m)
    assert.match(run.err, /^fix treadle board --sprint sprint-31$/m)
    assert.match(run.err, /^fix treadle board --sprint sprint-32$/m)
    assert.match(run.err, /^fix treadle board --all$/m)
    await insideEveryWidth(['board'])
    const one = await cli(['board', '--sprint', 'sprint-32', '--out', 'agent'])
    assert.equal(one.code, 0, one.err)
    assert.match(one.out, /^none searched 24 matched 0$/m)
  })

  it('renders as one object in all three formats, and status no longer names it as absent', async () => {
    const json = await cli(['board', '--all', '--out', 'json'])
    assert.equal(json.code, 0, json.err)
    const parsed = JSON.parse(json.out) as { schema: string; data: Record<string, unknown> }
    assert.equal(parsed.schema, 'board/1')
    for (const state of BOARD_STATES) assert.ok(typeof parsed.data[state] === 'object', `${state} block`)
    const status = await cli(['status', '--out', 'agent'])
    assert.doesNotMatch(status.out, /^absent_features.*\bboard\b/m)
  })
})
