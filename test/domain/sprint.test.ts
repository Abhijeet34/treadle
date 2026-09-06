// SPDX-License-Identifier: Apache-2.0
// The sprint's own rules: what a record must carry, how a day is counted, what a close
// records, and the three refusals that decide what enters a sprint. Everything here takes
// the clock and the derived facts as arguments, as the rest of this layer does, so every
// case is a fixed instant rather than a sleep.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_READY_GATE,
  carryOver,
  dayOfSprint,
  evaluateCommit,
  evaluateGate,
  isCalendarDate,
  validateSprint,
  type GateVerdict,
  type Sprint,
  type WorkItem,
} from '../../src/domain/index.ts'
import { errorOf, item, unwrap } from '../helpers/fixtures.ts'

const OPEN: Sprint = {
  id: 'sprint-31', title: 'Sprint 31', state: 'open', filed_at: '2026-09-06T09:00:00Z', version: 1,
  start: '2026-09-07', end: '2026-09-18',
}
const CLOSED: Sprint = { ...OPEN, id: 'sprint-30', state: 'closed', closed_at: '2026-09-06T09:00:00Z', carried: ['a-task'] }

function readyGate(subject: WorkItem, blockers: readonly string[] = []): GateVerdict {
  return evaluateGate(DEFAULT_READY_GATE, {
    item: subject, blockers, children: [], reviewStep: false, openImpediments: 0,
  })
}

describe('a calendar date names the day it denotes', () => {
  it('accepts a real date and refuses a shape that is not one', () => {
    assert.equal(isCalendarDate('2026-09-07'), true)
    assert.equal(isCalendarDate('2026-9-7'), false)
    assert.equal(isCalendarDate('2026-09-07T00:00:00Z'), false)
    assert.equal(isCalendarDate(20260907), false)
  })

  it('refuses a date the calendar does not have, which Date.parse would have rolled over', () => {
    assert.equal(isCalendarDate('2026-02-30'), false)
    assert.equal(isCalendarDate('2026-13-01'), false)
    assert.equal(isCalendarDate('2028-02-29'), true, 'a leap day is a real day')
    assert.equal(isCalendarDate('2027-02-29'), false)
  })
})

describe('the sprint dictionary', () => {
  it('accepts an open sprint with its two dates and a closed one with its carry-over', () => {
    unwrap(validateSprint(OPEN))
    unwrap(validateSprint(CLOSED))
  })

  it('refuses a date that is not a calendar day as I1, naming the field', () => {
    const error = errorOf(validateSprint({ ...OPEN, end: '2026-09-18T00:00:00Z' }))
    assert.equal(error.rule, 'I1')
    assert.match(error.message, /^end must be a calendar date written YYYY-MM-DD/)
  })

  it('refuses an end before the start as I1, with both dates in the sentence', () => {
    const error = errorOf(validateSprint({ ...OPEN, start: '2026-09-19' }))
    assert.equal(error.rule, 'I1')
    assert.equal(error.message, 'end 2026-09-18 is before start 2026-09-19; a sprint ends on or after the day it starts')
    unwrap(validateSprint({ ...OPEN, start: '2026-09-18' }))
  })

  it('keeps closed_at and carried to a closed sprint', () => {
    assert.match(errorOf(validateSprint({ ...OPEN, closed_at: '2026-09-06T09:00:00Z' })).message, /closed_at is set on a sprint whose state is open/)
    assert.match(errorOf(validateSprint({ ...OPEN, carried: ['a-task'] })).message, /carried is set on a sprint whose state is open/)
  })

  it('refuses a carried list that is not item ids, or names one twice', () => {
    assert.match(errorOf(validateSprint({ ...CLOSED, carried: ['A Task'] })).message, /carried must be a list of item ids/)
    assert.match(errorOf(validateSprint({ ...CLOSED, carried: ['a-task', 'a-task'] })).message, /names an item twice/)
  })

  it('bounds the goal and names the overrun', () => {
    const error = errorOf(validateSprint({ ...OPEN, goal: 'g'.repeat(501) }))
    assert.equal(error.message, 'goal is 501 characters and the limit is 500, which is 1 over')
  })
})

describe('the day of a sprint is counted in UTC calendar days, inclusive at both ends', () => {
  it('reads day 1 on the start date at any hour of it, and the length from the end date', () => {
    assert.deepEqual(dayOfSprint(OPEN, '2026-09-07T00:00:00Z'), { day: 1, days: 12 })
    assert.deepEqual(dayOfSprint(OPEN, '2026-09-07T23:59:59Z'), { day: 1, days: 12 })
    assert.deepEqual(dayOfSprint(OPEN, '2026-09-18T12:00:00Z'), { day: 12, days: 12 })
  })

  it('is not clamped: before the start it is 0 or less, and after the end it runs past the length', () => {
    assert.deepEqual(dayOfSprint(OPEN, '2026-09-06T23:59:59Z'), { day: 0, days: 12 })
    assert.deepEqual(dayOfSprint(OPEN, '2026-09-20T00:00:00Z'), { day: 14, days: 12 })
  })
})

describe('a close records what was still open, and nothing else', () => {
  it('carries the open items in id order and leaves done and cancelled ones in the set unnamed', () => {
    const committed = [
      item('task', { id: 'zulu', state: 'in_progress', sprint_id: 'sprint-31' }),
      item('task', { id: 'alpha', state: 'ready', sprint_id: 'sprint-31' }),
      item('task', { id: 'shipped', state: 'done', sprint_id: 'sprint-31' }),
      item('task', { id: 'dropped', state: 'cancelled', resolution: 'wont_do', sprint_id: 'sprint-31' }),
    ]
    assert.deepEqual(carryOver(committed), ['alpha', 'zulu'])
    assert.deepEqual(carryOver([]), [])
  })
})

describe('what may enter a sprint', () => {
  const ready = item('task', { id: 'a-task', state: 'ready' })

  it('allows a ready item that sits in no sprint, and reports one already in this sprint as already', () => {
    assert.deepEqual(evaluateCommit({ sprint: OPEN, item: ready, current: undefined, readyGate: readyGate(ready) }), { outcome: 'allowed' })
    const here = { ...ready, sprint_id: OPEN.id }
    assert.deepEqual(evaluateCommit({ sprint: OPEN, item: here, current: OPEN, readyGate: readyGate(here) }), { outcome: 'already' })
  })

  it('refuses a closed sprint as I2, before anything about the item is read', () => {
    const outcome = evaluateCommit({ sprint: CLOSED, item: ready, current: undefined, readyGate: readyGate(ready) })
    assert.equal(outcome.outcome, 'refused')
    if (outcome.outcome !== 'refused') return
    assert.equal(outcome.error.rule, 'I2')
    assert.match(outcome.error.message, /sprint-30 is closed, and a closed sprint's committed set is a record/)
    assert.deepEqual(outcome.fix, ['treadle sprints', 'treadle sprint reopen sprint-30'])
  })

  it('refuses an item that sits in another open sprint as I3, and lets one leave a closed sprint', () => {
    const other: Sprint = { ...OPEN, id: 'sprint-32' }
    const elsewhere = { ...ready, sprint_id: 'sprint-32' }
    const outcome = evaluateCommit({ sprint: OPEN, item: elsewhere, current: other, readyGate: readyGate(elsewhere) })
    assert.equal(outcome.outcome, 'refused')
    if (outcome.outcome !== 'refused') return
    assert.equal(outcome.error.rule, 'I3')
    assert.equal(outcome.error.message, 'a-task is committed to sprint-32, which is open; an item is in one sprint')
    assert.deepEqual(outcome.fix, ['treadle sprint uncommit a-task', 'treadle sprint close sprint-32'])

    // Carry-over is how an item leaves a closed sprint: the record stays and the item moves on.
    const carried = { ...ready, sprint_id: 'sprint-30' }
    assert.deepEqual(evaluateCommit({ sprint: OPEN, item: carried, current: CLOSED, readyGate: readyGate(carried) }), { outcome: 'allowed' })
  })

  it('refuses finished work as I4', () => {
    for (const state of ['done', 'cancelled'] as const) {
      const stopped = state === 'cancelled' ? item('task', { state, resolution: 'wont_do' }) : item('task', { state })
      const outcome = evaluateCommit({ sprint: OPEN, item: stopped, current: undefined, readyGate: readyGate(stopped) })
      assert.equal(outcome.outcome, 'refused', state)
      if (outcome.outcome !== 'refused') return
      assert.equal(outcome.error.rule, 'I4')
      assert.match(outcome.error.message, new RegExp(`is ${state}, and finished work does not enter a sprint$`))
    }
  })

  it('refuses an item whose ready gate fails as I4, naming the rule and its remedy', () => {
    const story = item('story', { id: 'dark-theme', state: 'draft' })
    const outcome = evaluateCommit({ sprint: OPEN, item: story, current: undefined, readyGate: readyGate(story) })
    assert.equal(outcome.outcome, 'refused')
    if (outcome.outcome !== 'refused') return
    assert.equal(outcome.error.rule, 'I4')
    assert.equal(outcome.error.message, 'dark-theme is not ready to be worked: DOR4 acceptance_criteria is empty')
    assert.deepEqual(outcome.fix, ['treadle set dark-theme acceptance_criteria="<entry>|<entry>"', 'treadle explain dark-theme'])
  })
})
