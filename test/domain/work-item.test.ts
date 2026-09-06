// SPDX-License-Identifier: Apache-2.0
// The six work-item types and the per-type required-field policy (domain model 2.1, 2.14).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  requiredAtCreation,
  validateWorkItem,
} from '../../src/domain/index.ts'
import { NOW, errorOf, item } from '../helpers/fixtures.ts'

const OPTIONS = { now: NOW }

describe('the closed type and state sets', () => {
  it('carries exactly the six types the model names and impediment', () => {
    assert.deepEqual([...WORK_ITEM_TYPES], ['epic', 'story', 'task', 'bug', 'spike', 'chore', 'impediment'])
  })

  it('carries exactly the seven states the model names, and blocked is not one of them', () => {
    assert.deepEqual(
      [...WORK_ITEM_STATES],
      ['draft', 'ready', 'in_progress', 'in_review', 'done', 'on_hold', 'cancelled'],
    )
    assert.ok(!(WORK_ITEM_STATES as readonly string[]).includes('blocked'))
  })
})

describe('per-type required fields at creation', () => {
  const expected: Record<string, readonly string[]> = {
    epic: ['outcome'],
    story: [],
    task: [],
    bug: ['severity', 'repro_steps', 'found_in'],
    spike: ['question', 'timebox_hours'],
    chore: [],
    impediment: ['severity', 'proposed_resolution'],
  }

  for (const type of WORK_ITEM_TYPES) {
    it(`${type} requires ${expected[type]?.length ?? 0} type-specific field(s)`, () => {
      assert.deepEqual([...requiredAtCreation(type)], expected[type])
    })
  }

  it('accepts a well-formed item of every type', () => {
    for (const type of WORK_ITEM_TYPES) {
      const result = validateWorkItem(item(type), OPTIONS)
      assert.equal(result.ok, true, `${type} should validate: ${JSON.stringify(result)}`)
    }
  })

  /** Spelled out rather than derived, so a message that read `a impediment` cannot pass. */
  const article = (type: string): string => (type === 'epic' || type === 'impediment' ? 'an' : 'a')

  for (const type of WORK_ITEM_TYPES) {
    for (const field of expected[type] ?? []) {
      it(`refuses a ${type} missing ${field}, naming the field and the rule`, () => {
        const subject = { ...item(type) } as Record<string, unknown>
        delete subject[field]
        const error = errorOf(validateWorkItem(subject as never, OPTIONS))
        assert.equal(error.code, 'VALIDATION')
        assert.equal(error.rule, 'V4')
        assert.equal(error.message, `${article(type)} ${type} needs ${field} at creation`)
      })
    }
  }
})

describe('fields a type does not own', () => {
  it('refuses a severity on a story', () => {
    const error = errorOf(validateWorkItem(item('story', { severity: 'S1' }), OPTIONS))
    assert.equal(error.rule, 'V5')
    assert.ok(error.message.includes('severity'))
  })

  it('refuses a timebox on a chore', () => {
    assert.equal(errorOf(validateWorkItem(item('chore', { timebox_hours: 4 }), OPTIONS)).rule, 'V5')
  })

  it('accepts a common field on every type', () => {
    for (const type of WORK_ITEM_TYPES) {
      const result = validateWorkItem(item(type, { priority: 2, labels: ['gate'] }), OPTIONS)
      assert.equal(result.ok, true, `${type}: ${JSON.stringify(result)}`)
    }
  })
})

describe('field validation from the field dictionary', () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['an id that is not a slug', { id: 'Not A Slug' }],
    ['an id shorter than three characters', { id: 'ab' }],
    ['a title with leading whitespace', { title: ' leading' }],
    ['a title carrying a newline', { title: 'two\nlines' }],
    ['a title carrying a tab', { title: 'two\tcolumns' }],
    ['a title carrying a C0 control', { title: 'bell\u0007' }],
    ['a title carrying a bidi override', { title: 'flip\u202Eflop' }],
    ['an empty title', { title: '' }],
    ['a priority outside 1 to 5', { priority: 9 }],
    ['a points value outside the scale', { points: 4 }],
    ['an hours estimate above 400', { hours_estimate: 401 }],
    ['a duplicate label', { labels: ['gate', 'gate'] }],
    ['a label that is not a slug', { labels: ['Not A Slug'] }],
    ['a description carrying a C0 control other than newline or tab', { description: 'x\u0000y' }],
    ['a filed_at that is not RFC 3339 UTC', { filed_at: '2026-09-01' }],
    ['a version below one', { version: 0 }],
  ]

  for (const [name, patch] of cases) {
    it(`refuses ${name}`, () => {
      const error = errorOf(validateWorkItem(item('task', patch), OPTIONS))
      assert.equal(error.code, 'VALIDATION', `expected a validation refusal for ${name}`)
    })
  }

  it('accepts a description that contains newlines, which the dictionary permits', () => {
    const result = validateWorkItem(item('task', { description: 'line one\nline two' }), OPTIONS)
    assert.equal(result.ok, true)
  })

  it('accepts every configured point value and refuses one off the configured scale', () => {
    for (const points of [1, 2, 3, 5, 8, 13]) {
      assert.equal(validateWorkItem(item('story', { points }), OPTIONS).ok, true)
    }
    assert.equal(validateWorkItem(item('story', { points: 20 }), OPTIONS).ok, false)
    // The scale is workspace configuration, not a constant.
    assert.equal(
      validateWorkItem(item('story', { points: 20 }), { now: NOW, pointScale: [20] }).ok,
      true,
    )
  })
})

describe('the hold fields', () => {
  it('requires a reason and a held-from state while the item is on hold', () => {
    assert.equal(errorOf(validateWorkItem(item('task', { state: 'on_hold' }), OPTIONS)).rule, 'V4')
  })

  it('accepts a complete hold', () => {
    const result = validateWorkItem(
      item('task', {
        state: 'on_hold',
        held_from: 'in_progress',
        hold_reason: 'waiting on the vendor',
        hold_until: '2026-09-20T00:00:00Z',
      }),
      OPTIONS,
    )
    assert.equal(result.ok, true, JSON.stringify(result))
  })

  it('refuses a hold expiry in the past, measured against the injected instant', () => {
    const error = errorOf(validateWorkItem(
      item('task', {
        state: 'on_hold',
        held_from: 'draft',
        hold_reason: 'waiting',
        hold_until: '2026-01-01T00:00:00Z',
      }),
      OPTIONS,
    ))
    assert.equal(error.rule, 'V4')
    assert.ok(error.message.includes('hold_until'))
  })

  it('refuses hold fields on an item that is not on hold', () => {
    const result = validateWorkItem(item('task', { hold_reason: 'why' }), OPTIONS)
    assert.equal(result.ok, false)
  })
})

describe('unknown fields carried alongside the known ones', () => {
  it('accepts an unknown field that matches the key grammar', () => {
    const extra = new Map([['team_note', 'kept verbatim']])
    assert.equal(validateWorkItem(item('task', { extra }), OPTIONS).ok, true)
  })

  it('refuses an unknown field whose key is __proto__', () => {
    const extra = new Map([['__proto__', 'x']])
    assert.equal(errorOf(validateWorkItem(item('task', { extra }), OPTIONS)).rule, 'V2')
  })
})
