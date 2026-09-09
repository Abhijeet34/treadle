// SPDX-License-Identifier: Apache-2.0
// The list's two computed answers, at the layer that computes them rather than through the
// command surface: what the default scope adds and when, and what the age column measures.
//
// Both are here because the interesting cases are ones a command line cannot easily reach. An
// age over the ranking's own thirty-day ceiling needs a clock months past the fixture, and a
// blocker that finishes mid-life needs the write and the read in one process.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { backlog, scoped, type Filter } from '../../src/application/services/items.ts'
import { relate } from '../../src/application/services/relation.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { targetFor } from '../../src/adapters/target.ts'
import type { ResultObject } from '../../src/application/result.ts'
import { aDemoWorkspace, ACTOR, NOW, type Demo } from '../helpers/cli-fixtures.ts'

const COLUMNS = ['id', 'state', 'blocked', 'age']

function rowsOf(result: ResultObject): readonly Record<string, unknown>[] {
  const block = result.data['items'] as { rows: readonly Record<string, unknown>[] }
  return block.rows
}

function rowFor(result: ResultObject, id: string): Record<string, unknown> {
  const row = rowsOf(result).find((entry) => entry['id'] === id)
  assert.ok(row !== undefined, `no row for ${id}`)
  return row
}

describe('the clause the default scope adds, and the clauses it leaves alone', () => {
  const clause = (field: Filter['field'], value: string): Filter => ({ field, value })
  const names = (filters: readonly Filter[]): string => filters.map((f) => `${f.field} ${f.value}`).join(' ')

  it('scopes a list that named no state to open work, and puts the clause first', () => {
    assert.equal(names(scoped([])), 'state open')
    assert.equal(names(scoped([clause('type', 'bug')])), 'state open type bug')
  })

  it('adds nothing where the caller named a state, whichever state it is', () => {
    assert.equal(names(scoped([clause('state', 'done')])), 'state done')
    assert.equal(names(scoped([clause('state', 'all')])), 'state all')
    assert.equal(names(scoped([clause('state', 'open')])), 'state open')
  })

  // A resolution is written by the cancel transition alone (T6), so it is a fact about a
  // cancelled record: adding an open scope beside one builds a clause that can never hold.
  it('adds nothing beside a resolution, which is a clause about finished work already', () => {
    assert.equal(names(scoped([clause('resolution', 'duplicate')])), 'resolution duplicate')
  })

  it('is not fooled by a clause that merely mentions a state-shaped value', () => {
    assert.equal(names(scoped([clause('title', 'done')])), 'state open title done')
    assert.equal(names(scoped([clause('assignee', 'open')])), 'state open assignee open')
  })
})

describe('what the age column measures, and what it does not', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const list = (now: string) => backlog(demo.store, fixedClock(now), {
    filters: [{ field: 'state', value: 'all' }], columns: COLUMNS, limit: 50,
  })

  it('counts whole days from the instant the item was filed', async () => {
    // auth-refresh was filed 2026-08-20T09:00:00Z and NOW is 2026-09-04T09:30:00Z.
    assert.equal(rowFor(await list(NOW), 'auth-refresh')['age'], 15)
  })

  // The ranking's own age component stops at thirty because a score has to stop growing. A
  // list that printed 30 for a year-old item would be reporting a cap as a fact about the work.
  it('does not stop at the thirty days the ranking caps its own age component at', async () => {
    assert.equal(rowFor(await list('2026-12-01T09:00:00Z'), 'auth-refresh')['age'], 103)
  })

  it('floors at nought rather than going negative when the clock is behind the record', async () => {
    assert.equal(rowFor(await list('2026-08-01T09:00:00Z'), 'auth-refresh')['age'], 0)
  })
})

describe('what the blocked column names, and when it stops naming it', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const clock = fixedClock(NOW)
  const ids = sequentialIds(700)
  const list = () => backlog(demo.store, clock, {
    filters: [{ field: 'state', value: 'all' }], columns: COLUMNS, limit: 50,
  })

  it('is a dash for an item nothing holds up', async () => {
    assert.equal(rowFor(await list(), 'theme-dark')['blocked'], null)
  })

  it('names the blocker once an edge exists, on the record the edge points at', async () => {
    const edge = await relate(targetFor(demo.store, 'apply'), clock, ids, {
      verb: 'add', id: 'queue-drain', kind: 'blocks', other: 'theme-dark', actor: ACTOR,
    })
    assert.equal(edge.ok, true, String(edge.data['cause']))
    const listed = await list()
    assert.equal(rowFor(listed, 'theme-dark')['blocked'], 'queue-drain')
    assert.equal(rowFor(listed, 'queue-drain')['blocked'], null, 'the blocker was marked as blocked itself')
  })

  // The same clause `activeBlockerIndex` carries: finished work holds nothing up, so a caller
  // reading the list is never sent to `explain` over an edge that no longer stops anything.
  it('stops naming a blocker that has finished, without the edge being removed', async () => {
    for (const target of ['ready', 'in_progress', 'done'] as const) {
      const moved = await transition(targetFor(demo.store, 'apply'), clock, ids, {
        id: 'queue-drain', target, reason: 'fixture', actor: ACTOR,
      })
      assert.equal(moved.ok, true, `${target}: ${String(moved.data['cause'])}`)
    }
    assert.equal(rowFor(await list(), 'theme-dark')['blocked'], null)
  })
})
