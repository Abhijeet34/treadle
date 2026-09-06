// SPDX-License-Identifier: Apache-2.0
// Definition of ready and definition of done as a rule evaluator (domain model 2.6).
// The evaluator is shared by the built-in gates and by a workspace-configured gate,
// which is the Policy seam's second implementation.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_DONE_GATE,
  DEFAULT_READY_GATE,
  evaluateGate,
  validateGate,
} from '../../src/domain/index.ts'
import type { Gate } from '../../src/domain/index.ts'
import { child, errorOf, gateContext, item, unwrap } from '../helpers/fixtures.ts'

function failed(verdict: ReturnType<typeof evaluateGate>): readonly string[] {
  return verdict.rules.filter((r) => !r.pass).map((r) => r.rule)
}

describe('gate shape', () => {
  it('gives every rule an id, a human sentence and a scope', () => {
    for (const gate of [DEFAULT_READY_GATE, DEFAULT_DONE_GATE]) {
      for (const rule of gate.rules) {
        assert.ok(rule.id.length > 0)
        assert.ok(rule.sentence.length > 0, `${rule.id} needs a sentence`)
        assert.ok(rule.scope === 'all' || rule.scope.length > 0)
      }
      assert.equal(new Set(gate.rules.map((r) => r.id)).size, gate.rules.length, 'rule ids are unique')
    }
  })

  it('reports the verdict per rule, and passes only when every rule passes', () => {
    const verdict = evaluateGate(DEFAULT_READY_GATE, gateContext(item('task', { state: 'draft' })))
    assert.equal(verdict.gate, 'ready')
    assert.equal(verdict.pass, true)
    assert.ok(verdict.rules.length > 0)
    assert.ok(verdict.rules.every((r) => r.pass))
  })

  it('evaluates only the rules in scope for the item type', () => {
    const storyRules = evaluateGate(DEFAULT_READY_GATE, gateContext(item('story'))).rules.map((r) => r.rule)
    const taskRules = evaluateGate(DEFAULT_READY_GATE, gateContext(item('task'))).rules.map((r) => r.rule)
    assert.ok(storyRules.length > taskRules.length)
    assert.ok(taskRules.every((r) => storyRules.includes(r)))
  })
})

describe('the default ready gate', () => {
  it('fails a story with no acceptance criteria and no points, and says what would satisfy each', () => {
    const verdict = evaluateGate(DEFAULT_READY_GATE, gateContext(item('story')))
    assert.equal(verdict.pass, false)
    assert.deepEqual(failed(verdict), ['DOR4', 'DOR5'])
    for (const rule of verdict.rules.filter((r) => !r.pass)) {
      assert.ok(rule.reason !== undefined && rule.reason.length > 0, `${rule.rule} needs a reason`)
      assert.ok(rule.remedy !== undefined && rule.remedy.length > 0, `${rule.rule} needs a remedy`)
    }
  })

  it('passes the same story once it has a criterion and points', () => {
    const ready = item('story', {
      points: 5,
      acceptance_criteria: [{ text: 'A 401 refreshes the token once', ticked: false }],
    })
    assert.equal(evaluateGate(DEFAULT_READY_GATE, gateContext(ready)).pass, true)
  })

  it('fails any item with an active blocker', () => {
    const verdict = evaluateGate(DEFAULT_READY_GATE, gateContext(item('task'), { blockers: ['auth-refresh'] }))
    assert.deepEqual(failed(verdict), ['DOR3'])
    assert.ok(verdict.rules.find((r) => r.rule === 'DOR3')?.reason?.includes('auth-refresh'))
  })

  it('fails a bug that has no expected and actual, which the model makes a ready-time rule', () => {
    const verdict = evaluateGate(DEFAULT_READY_GATE, gateContext(item('bug')))
    assert.deepEqual(failed(verdict), ['DOR6', 'DOR7'])
  })

  it('fails an epic with no child story and passes it once one exists', () => {
    const bare = evaluateGate(DEFAULT_READY_GATE, gateContext(item('epic')))
    assert.deepEqual(failed(bare), ['DOR8'])
    const withTask = evaluateGate(
      DEFAULT_READY_GATE,
      gateContext(item('epic'), { children: [child('t-1', 'task', 'draft')] }),
    )
    assert.deepEqual(failed(withTask), ['DOR8'], 'a task child is not a story child')
    const withStory = evaluateGate(
      DEFAULT_READY_GATE,
      gateContext(item('epic'), { children: [child('s-1', 'story', 'draft')] }),
    )
    assert.equal(withStory.pass, true)
  })

  it('fails a type whose creation-required field was removed by a hand edit', () => {
    const broken = { ...item('spike') } as Record<string, unknown>
    delete broken['question']
    const verdict = evaluateGate(DEFAULT_READY_GATE, gateContext(broken as never))
    assert.deepEqual(failed(verdict), ['DOR2'])
    assert.ok(verdict.rules.find((r) => r.rule === 'DOR2')?.reason?.includes('question'))
  })
})

describe('the default done gate', () => {
  it('fails a story whose acceptance criteria are not all ticked', () => {
    const story = item('story', {
      state: 'in_review',
      points: 5,
      acceptance_criteria: [
        { text: 'refresh once', ticked: true },
        { text: 'log the refusal', ticked: false },
      ],
    })
    const verdict = evaluateGate(DEFAULT_DONE_GATE, gateContext(story))
    assert.deepEqual(failed(verdict), ['DOD4'])
    assert.ok(verdict.rules.find((r) => r.rule === 'DOD4')?.reason?.includes('1'))
  })

  it('passes the same story once every criterion is ticked', () => {
    const story = item('story', {
      state: 'in_review',
      points: 5,
      acceptance_criteria: [{ text: 'refresh once', ticked: true }],
    })
    assert.equal(evaluateGate(DEFAULT_DONE_GATE, gateContext(story)).pass, true)
  })

  it('fails a spike with no findings and a bug whose fix is unconfirmed', () => {
    assert.deepEqual(failed(evaluateGate(DEFAULT_DONE_GATE, gateContext(item('spike')))), ['DOD5'])
    assert.deepEqual(failed(evaluateGate(DEFAULT_DONE_GATE, gateContext(item('bug')))), ['DOD6'])
  })

  it('fails an item with an open child, and passes when every child is closed', () => {
    const open = gateContext(item('epic'), {
      children: [child('s-1', 'story', 'done'), child('s-2', 'story', 'in_progress')],
    })
    assert.deepEqual(failed(evaluateGate(DEFAULT_DONE_GATE, open)), ['DOD1'])
    const closed = gateContext(item('epic'), {
      children: [child('s-1', 'story', 'done'), child('s-2', 'story', 'cancelled')],
    })
    assert.equal(evaluateGate(DEFAULT_DONE_GATE, closed).pass, true)
  })

  it('refuses a done that points at no evidence, and only where the type has a review step', () => {
    const bare = gateContext(item('story', {
      state: 'in_review', points: 5, reviewer: 'kim', assignee: 'dana',
      acceptance_criteria: [{ text: 'refresh once', ticked: true }],
    }), { reviewStep: true })
    assert.deepEqual(failed(evaluateGate(DEFAULT_DONE_GATE, bare)), ['DOD7'])
    assert.ok(evaluateGate(DEFAULT_DONE_GATE, bare).rules
      .find((r) => r.rule === 'DOD7')?.remedy?.startsWith('treadle evidence add'))

    const pointed = gateContext(item('story', {
      state: 'in_review', points: 5, reviewer: 'kim', assignee: 'dana',
      acceptance_criteria: [{ text: 'refresh once', ticked: true }],
      evidence: [{ kind: 'pr', ref: 'https://example.test/pr/42', label: 'the fix' }],
    }), { reviewStep: true })
    assert.equal(evaluateGate(DEFAULT_DONE_GATE, pointed).pass, true)

    // A chore has no review step, so the anti-attestation pair is inert for it, exactly as
    // DOD3 already is.
    const chore = gateContext(item('chore'), { reviewStep: false })
    assert.equal(evaluateGate(DEFAULT_DONE_GATE, chore).pass, true)
  })

  it('fails an item with an open impediment', () => {
    const verdict = evaluateGate(DEFAULT_DONE_GATE, gateContext(item('task'), { openImpediments: ['cert-expired', 'vendor-hold'] }))
    assert.deepEqual(failed(verdict), ['DOD2'])
    const rule = verdict.rules.find((r) => r.rule === 'DOD2')
    assert.equal(rule?.reason, 'cert-expired, vendor-hold are still open against the item')
    assert.equal(rule?.remedy, 'treadle transition cert-expired done', 'resolving the impediment is the remedy')
  })

  it('requires a reviewer only when the type has a review step, and never the assignee', () => {
    const noReview = gateContext(item('task', { assignee: 'dana' }), { reviewStep: false })
    assert.equal(evaluateGate(DEFAULT_DONE_GATE, noReview).pass, true)

    const missing = gateContext(item('task', { assignee: 'dana' }), { reviewStep: true })
    assert.deepEqual(failed(evaluateGate(DEFAULT_DONE_GATE, missing)), ['DOD3', 'DOD7'])

    const self = gateContext(item('task', { assignee: 'dana', reviewer: 'dana' }), { reviewStep: true })
    assert.deepEqual(failed(evaluateGate(DEFAULT_DONE_GATE, self)), ['DOD3', 'DOD7'])

    const other = gateContext(
      item('task', { assignee: 'dana', reviewer: 'kim', evidence: [{ kind: 'run', ref: '8813' }] }),
      { reviewStep: true },
    )
    assert.equal(evaluateGate(DEFAULT_DONE_GATE, other).pass, true)
  })
})

describe('a workspace-configured gate runs through the same evaluator', () => {
  const workspaceGate: Gate = {
    name: 'ready',
    rules: [
      {
        id: 'WS1',
        sentence: 'A task belongs to a story before it is ready.',
        scope: 'task',
        check: { kind: 'parent_present' },
      },
    ],
  }

  it('fails a parentless task under the workspace rule and passes one with a parent', () => {
    const bare = evaluateGate(workspaceGate, gateContext(item('task')))
    assert.deepEqual(failed(bare), ['WS1'])
    const parented = evaluateGate(workspaceGate, gateContext(item('task', { parent_id: 'sso-saml' })))
    assert.equal(parented.pass, true)
  })

  it('is inert for a type it is not scoped to', () => {
    assert.deepEqual(evaluateGate(workspaceGate, gateContext(item('story'))).rules, [])
  })
})

describe('validateGate, which is what makes a configured gate safe to load', () => {
  it('accepts both built-in gates', () => {
    unwrap(validateGate(DEFAULT_READY_GATE))
    unwrap(validateGate(DEFAULT_DONE_GATE))
  })

  it('refuses a rule referencing a field the scoped type does not have', () => {
    const gate: Gate = {
      name: 'ready',
      rules: [{
        id: 'WS2',
        sentence: 'A chore records its severity.',
        scope: 'chore',
        check: { kind: 'field_present', field: 'severity' },
      }],
    }
    const error = errorOf(validateGate(gate))
    assert.equal(error.rule, 'V6')
    assert.ok(error.message.includes('severity') && error.message.includes('chore'), error.message)
  })

  it('refuses a rule referencing a field that is not in the dictionary at all', () => {
    const gate: Gate = {
      name: 'ready',
      rules: [{
        id: 'WS3',
        sentence: 'Nonsense.',
        scope: 'all',
        check: { kind: 'field_present', field: 'not_a_field' },
      }],
    }
    assert.equal(errorOf(validateGate(gate)).rule, 'V6')
  })

  it('refuses duplicate rule ids', () => {
    const rule = {
      id: 'WS4',
      sentence: 'Title present.',
      scope: 'all',
      check: { kind: 'field_present', field: 'title' },
    } as const
    assert.equal(errorOf(validateGate({ name: 'ready', rules: [rule, rule] })).rule, 'V7')
  })
})
