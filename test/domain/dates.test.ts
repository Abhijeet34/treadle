// SPDX-License-Identifier: Apache-2.0
// One date field and the two derived reads over it (report section 3.3). The clock is an
// argument here as everywhere in this layer, so every case below is a fixed instant rather
// than a sleep, and the boundary cases are the ones a wall clock could never reach twice.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_OVERDUE_DAYS,
  daysOverdue,
  healthFindings,
  isOverdue,
  WORK_ITEM_STATES,
} from '../../src/domain/index.ts'
import { item } from '../helpers/fixtures.ts'

const NOW = '2026-09-05T12:00:00Z'

describe('overdue is derived on read and never written', () => {
  it('is false when the item carries no due date, whatever its state', () => {
    for (const state of WORK_ITEM_STATES) {
      assert.equal(isOverdue(item('task', { state }), NOW), false, state)
    }
  })

  it('is true only once the instant has passed, to the second', () => {
    const due = (at: string) => item('task', { state: 'ready', due: at })
    assert.equal(isOverdue(due('2026-09-05T11:59:59Z'), NOW), true)
    assert.equal(isOverdue(due('2026-09-05T12:00:00Z'), NOW), false)
    assert.equal(isOverdue(due('2026-09-05T12:00:01Z'), NOW), false)
  })

  it('is false for a terminal item, because the work has stopped and nobody can act', () => {
    for (const state of ['done', 'cancelled'] as const) {
      const stopped = state === 'cancelled'
        ? item('task', { state, due: '2026-01-01T00:00:00Z', resolution: 'wont_do' })
        : item('task', { state, due: '2026-01-01T00:00:00Z' })
      assert.equal(isOverdue(stopped, NOW), false, state)
    }
  })

  it('counts whole days and clamps them, so one forgotten item cannot own a ranking', () => {
    const due = (at: string) => item('task', { state: 'ready', due: at })
    assert.equal(daysOverdue(due('2026-09-05T11:00:00Z'), NOW), 0)
    assert.equal(daysOverdue(due('2026-09-02T12:00:00Z'), NOW), 3)
    assert.equal(daysOverdue(due('2020-01-01T00:00:00Z'), NOW), MAX_OVERDUE_DAYS)
  })
})

describe('H17, the finding that stops a due date from being decoration', () => {
  const overdue = { state: 'ready' as const, due: '2026-09-01T09:00:00Z' }

  it('names an overdue item that is assigned to nobody', () => {
    const found = healthFindings([item('task', { id: 'queue-drain', ...overdue })], NOW)
    assert.equal(found.length, 1)
    assert.equal(found[0]?.rule, 'H17')
    assert.equal(found[0]?.id, 'queue-drain')
    assert.match(String(found[0]?.reason), /2026-09-01T09:00:00Z/)
  })

  it('says nothing about an overdue item somebody owns, or an owned item that is on time', () => {
    assert.deepEqual(healthFindings([item('task', { id: 'owned', ...overdue, assignee: 'dana' })], NOW), [])
    assert.deepEqual(healthFindings([item('task', { id: 'later', state: 'ready', due: '2027-01-01T00:00:00Z' })], NOW), [])
  })

  it('reports in id order, so two runs over one workspace print the same lines', () => {
    const found = healthFindings([
      item('task', { id: 'zeta', ...overdue }),
      item('task', { id: 'alpha', ...overdue }),
    ], NOW)
    assert.deepEqual(found.map((finding) => finding.id), ['alpha', 'zeta'])
  })
})
