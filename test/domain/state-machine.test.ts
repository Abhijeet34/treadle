// SPDX-License-Identifier: Apache-2.0
// The lifecycle (domain model 2.2). The legality table below is transcribed from the
// model's own state diagram and is this test's oracle; the implementation's table is
// never consulted to build it, so a wrong edge in either one shows up as a failure.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ATTEMPT_OUTCOMES,
  GUARD_IDS,
  RESOLUTIONS,
  TRANSITIONS,
  WORK_ITEM_STATES,
  evaluateTransition,
  legalTargetsFrom,
} from '../../src/domain/index.ts'
import type { TransitionName, WorkItemState } from '../../src/domain/index.ts'
import { allowance, context, failing, idempotence, item, neighbour, refusal } from '../helpers/fixtures.ts'

/** from -> to -> the transition the model names for that edge. */
const LEGAL: Readonly<Record<WorkItemState, Readonly<Partial<Record<WorkItemState, TransitionName>>>>> = {
  draft: { ready: 'groom', on_hold: 'hold', cancelled: 'cancel' },
  ready: { draft: 'ungroom', in_progress: 'start', on_hold: 'hold', cancelled: 'cancel' },
  in_progress: { ready: 'release', in_review: 'submit', done: 'finish', on_hold: 'hold', cancelled: 'cancel' },
  in_review: { in_progress: 'rework', done: 'accept', on_hold: 'hold', cancelled: 'cancel' },
  done: { in_progress: 'reopen' },
  // on_hold resumes only to the state it was held from; the fixture below holds from ready,
  // so three of the diagram's four resume edges are illegal for this particular item.
  on_hold: { ready: 'resume', cancelled: 'cancel' },
  cancelled: { draft: 'revive' },
}

const REASON_REQUIRED: ReadonlySet<TransitionName> = new Set<TransitionName>([
  'ungroom', 'rework', 'reopen', 'hold', 'cancel', 'release', 'revive',
])

/** T6: two edges name a value from a closed set, and every other edge refuses one. */
const CLOSED_VALUE: Readonly<Partial<Record<TransitionName, Record<string, string>>>> = {
  cancel: { resolution: 'wont_do' },
  release: { outcome: 'failed' },
}

function subject(state: WorkItemState) {
  return state === 'on_hold'
    ? item('task', { state, held_from: 'ready', hold_reason: 'waiting on the vendor' })
    : item('task', { state })
}

function firstEdgeFor(name: TransitionName): readonly [WorkItemState, WorkItemState] {
  for (const from of WORK_ITEM_STATES) {
    for (const [to, transition] of Object.entries(LEGAL[from])) {
      if (transition === name) return [from, to as WorkItemState]
    }
  }
  throw new Error(`the oracle has no edge for ${name}`)
}

describe('the transition table matches the model diagram', () => {
  it('names thirteen transitions and eight guards', () => {
    assert.deepEqual(
      [...TRANSITIONS],
      ['groom', 'ungroom', 'start', 'submit', 'finish', 'rework', 'accept', 'reopen',
        'hold', 'resume', 'cancel', 'release', 'revive'],
    )
    assert.deepEqual([...GUARD_IDS], ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'])
  })

  it('draws 23 edges once the three resume edges this fixture cannot reach are added back', () => {
    const edges = WORK_ITEM_STATES.reduce((n, from) => n + Object.keys(LEGAL[from]).length, 0)
    assert.equal(edges + 3, 23)
  })
})

describe('every state-by-target pair, legal and illegal', () => {
  for (const from of WORK_ITEM_STATES) {
    for (const to of WORK_ITEM_STATES) {
      const expected = LEGAL[from][to]
      const label = `${from} -> ${to}`

      if (from === to) {
        it(`${label} is idempotent and writes nothing`, () => {
          assert.equal(idempotence(evaluateTransition(context(subject(from)), { target: to })).state, from)
        })
        continue
      }

      if (expected !== undefined) {
        it(`${label} is legal and is the ${expected} transition`, () => {
          // G5 makes exactly one of submit and finish the legal exit from in_progress, so
          // the edge gets the review setting it needs; the asymmetry has its own tests below.
          const setting = context(subject(from), { reviewStep: expected === 'submit' })
          const allowed = allowance(evaluateTransition(setting, {
            target: to,
            reason: REASON_REQUIRED.has(expected) ? 'because' : undefined,
            ...(CLOSED_VALUE[expected] ?? {}),
          }))
          assert.equal(allowed.transition, expected)
          assert.equal(allowed.from, from)
          assert.equal(allowed.to, to)
        })
        continue
      }

      it(`${label} is refused with a structured error naming the rule`, () => {
        const { error } = refusal(
          evaluateTransition(context(subject(from)), { target: to, reason: 'because' }),
        )
        assert.equal(error.code, 'GUARD_REFUSED')
        // T1 no such edge; T3 on_hold resumes only to the state it was held from.
        assert.ok(['T1', 'T3'].includes(error.rule ?? ''), `rule was ${error.rule}`)
        assert.ok(error.message.includes(from) && error.message.includes(to), error.message)
      })
    }
  }
})

describe('legalTargetsFrom agrees with the oracle', () => {
  for (const from of WORK_ITEM_STATES) {
    it(`lists the legal targets of ${from}`, () => {
      assert.deepEqual([...legalTargetsFrom(subject(from))].sort(), Object.keys(LEGAL[from]).sort())
    })
  }
})

describe('resume', () => {
  it('resolves to the state the item was held from', () => {
    const held = item('task', { state: 'on_hold', held_from: 'in_progress', hold_reason: 'vendor' })
    const allowed = allowance(evaluateTransition(context(held), { target: 'resume' }))
    assert.equal(allowed.to, 'in_progress')
    assert.equal(allowed.transition, 'resume')
  })

  it('is refused from any state other than on_hold', () => {
    const outcome = evaluateTransition(context(item('task', { state: 'ready' })), { target: 'resume' })
    assert.equal(refusal(outcome).error.rule, 'T3')
  })

  it('is refused when the held-from state is missing, rather than guessing one', () => {
    const broken = item('task', { state: 'on_hold', hold_reason: 'vendor' })
    assert.equal(refusal(evaluateTransition(context(broken), { target: 'resume' })).error.rule, 'T3')
  })
})

describe('T6, the closed-set value two edges record', () => {
  it('refuses a cancel that names no resolution, and lists the set it wanted', () => {
    const { error } = refusal(evaluateTransition(context(subject('ready')), {
      target: 'cancelled', reason: 'superseded by the export story',
    }))
    assert.equal(error.code, 'VALIDATION')
    assert.equal(error.rule, 'T6')
    for (const value of RESOLUTIONS) assert.ok(error.message.includes(value), error.message)
  })

  it('refuses a resolution that is not in the set, rather than storing it', () => {
    const { error } = refusal(evaluateTransition(context(subject('ready')), {
      target: 'cancelled', reason: 'why', resolution: 'obsolete' as 'wont_do',
    }))
    assert.equal(error.rule, 'T6')
    assert.ok(error.message.includes('obsolete'), error.message)
  })

  it('accepts each of the five resolutions on a cancel', () => {
    for (const resolution of RESOLUTIONS) {
      const allowed = allowance(evaluateTransition(context(subject('ready')), {
        target: 'cancelled', reason: 'why', resolution,
      }))
      assert.equal(allowed.transition, 'cancel')
    }
  })

  it('refuses a resolution on an edge that does not stop the item', () => {
    const { error } = refusal(evaluateTransition(context(subject('draft')), {
      target: 'ready', resolution: 'duplicate',
    }))
    assert.equal(error.rule, 'T6')
    assert.ok(error.message.includes('cancel'), error.message)
  })

  it('refuses a release that names no attempt outcome, and lists the set it wanted', () => {
    const { error } = refusal(evaluateTransition(context(subject('in_progress')), {
      target: 'ready', reason: 'the migration will not apply',
    }))
    assert.equal(error.rule, 'T6')
    for (const value of ATTEMPT_OUTCOMES) assert.ok(error.message.includes(value), error.message)
  })

  it('refuses an attempt outcome on an edge that is not a release', () => {
    const { error } = refusal(evaluateTransition(context(subject('ready')), {
      target: 'cancelled', reason: 'why', resolution: 'wont_do', outcome: 'failed',
    }))
    assert.equal(error.rule, 'T6')
    assert.ok(error.message.includes('release'), error.message)
  })

  it('evaluates no guard on the release edge, so a failed attempt always has an exit', () => {
    const allowed = allowance(evaluateTransition(
      context(subject('in_progress'), { reviewStep: true, blockers: [neighbour('sso-saml', 'story', 'in_progress')] }),
      { target: 'ready', reason: 'the vendor endpoint is down', outcome: 'yielded' },
    ))
    assert.equal(allowed.transition, 'release')
    assert.deepEqual(allowed.guards, [])
  })
})

describe('an unknown target', () => {
  it('is a validation error, not a guard refusal', () => {
    const { error } = refusal(
      evaluateTransition(context(item('task')), { target: 'blocked' as WorkItemState }),
    )
    assert.equal(error.code, 'VALIDATION')
    assert.equal(error.rule, 'T2')
  })
})

describe('reasons', () => {
  for (const name of REASON_REQUIRED) {
    it(`${name} is refused without a reason`, () => {
      const [from, to] = firstEdgeFor(name)
      const setting = context(subject(from), { reviewStep: false })
      const outcome = evaluateTransition(setting, { target: to, ...(CLOSED_VALUE[name] ?? {}) })
      assert.equal(refusal(outcome).error.rule, 'T4')
    })
  }

  it('does not require a reason for a transition that does not ask for one', () => {
    allowance(evaluateTransition(context(subject('draft')), { target: 'ready' }))
  })
})

describe('guards', () => {
  it('G1 refuses groom when the ready gate fails, and names the gate rule', () => {
    const { error } = refusal(evaluateTransition(
      context(subject('draft'), { readyGate: failing('ready', 'DOR4') }),
      { target: 'ready' },
    ))
    assert.equal(error.rule, 'G1')
    assert.ok(error.message.includes('DOR4'), error.message)
  })

  it('G2 refuses start while the item is blocked, and names the blocker', () => {
    const { error } = refusal(evaluateTransition(
      context(subject('ready'), { blockers: [neighbour('auth-refresh', 'story', 'ready')] }),
      { target: 'in_progress' },
    ))
    assert.equal(error.rule, 'G2')
    assert.ok(error.message.includes('auth-refresh'), error.message)
  })

  it('G2 can be overridden with a reason, and the guard result says it was', () => {
    const allowed = allowance(evaluateTransition(
      context(subject('ready'), { blockers: [neighbour('auth-refresh', 'story', 'ready')] }),
      { target: 'in_progress', overrides: ['G2'], reason: 'cosmetic' },
    ))
    const g2 = allowed.guards.find((g) => g.guard === 'G2')
    assert.equal(g2?.pass, true)
    assert.equal(g2?.overridden, true)
  })

  it('an override without a reason is refused', () => {
    const outcome = evaluateTransition(
      context(subject('ready'), { blockers: [neighbour('x')] }),
      { target: 'in_progress', overrides: ['G2'] },
    )
    assert.equal(refusal(outcome).error.rule, 'T4')
  })

  it('G1 cannot be overridden, and saying so is T5', () => {
    const outcome = evaluateTransition(
      context(subject('draft'), { readyGate: failing('ready', 'DOR1') }),
      { target: 'ready', overrides: ['G1'], reason: 'trust me' },
    )
    assert.equal(refusal(outcome).error.rule, 'T5')
  })

  it('an override naming a guard the edge does not evaluate is T5', () => {
    const outcome = evaluateTransition(context(subject('draft')), {
      target: 'ready', overrides: ['G3'], reason: 'why',
    })
    assert.equal(refusal(outcome).error.rule, 'T5')
  })

  it('G3 reports the value it saw, not just its verdict', () => {
    const allowed = allowance(evaluateTransition(
      context(subject('ready'), { column: { name: 'in_progress', used: 4, limit: 5 } }),
      { target: 'in_progress' },
    ))
    assert.equal(allowed.guards.find((g) => g.guard === 'G3')?.observed, '4/5')
  })

  it('G3 refuses a move that would exceed the column limit', () => {
    const outcome = evaluateTransition(
      context(subject('ready'), { column: { name: 'in_progress', used: 5, limit: 5 } }),
      { target: 'in_progress' },
    )
    assert.equal(refusal(outcome).error.rule, 'G3')
  })

  it('G3 treats a limit of zero as unlimited', () => {
    allowance(evaluateTransition(
      context(subject('ready'), { column: { name: 'in_progress', used: 99, limit: 0 } }),
      { target: 'in_progress' },
    ))
  })

  it('G4 refuses start for an item that is in no sprint and on no board', () => {
    const outcome = evaluateTransition(
      context(subject('ready'), { iterationMember: false }),
      { target: 'in_progress' },
    )
    assert.equal(refusal(outcome).error.rule, 'G4')
  })

  it('G4 cannot be overridden', () => {
    const outcome = evaluateTransition(
      context(subject('ready'), { iterationMember: false }),
      { target: 'in_progress', overrides: ['G4'], reason: 'why' },
    )
    assert.equal(refusal(outcome).error.rule, 'T5')
  })

  it('G5 makes submit the only exit from in_progress when the type has a review step', () => {
    const withReview = context(subject('in_progress'), { reviewStep: true })
    allowance(evaluateTransition(withReview, { target: 'in_review' }))
    assert.equal(refusal(evaluateTransition(withReview, { target: 'done' })).error.rule, 'G5')
  })

  it('G5 makes finish the only exit from in_progress when the type has no review step', () => {
    const noReview = context(subject('in_progress'), { reviewStep: false })
    allowance(evaluateTransition(noReview, { target: 'done' }))
    assert.equal(refusal(evaluateTransition(noReview, { target: 'in_review' })).error.rule, 'G5')
  })

  it('G6 refuses accept when the done gate fails', () => {
    const outcome = evaluateTransition(
      context(subject('in_review'), { doneGate: failing('done', 'DOD4') }),
      { target: 'done' },
    )
    assert.equal(refusal(outcome).error.rule, 'G6')
  })

  // Both cancels below carry a resolution, because T6 is evaluated before any guard is:
  // without one these would refuse for the wrong reason and assert nothing about G7.
  it('G7 refuses cancel while an active item is blocked by this one', () => {
    const { error } = refusal(evaluateTransition(
      context(subject('ready'), { blockedByThis: ['sso-saml', 'audit-log'] }),
      { target: 'cancelled', reason: 'superseded', resolution: 'superseded' },
    ))
    assert.equal(error.rule, 'G7')
    assert.ok(error.message.includes('sso-saml'), error.message)
  })

  it('G7 yields to the cascade override', () => {
    allowance(evaluateTransition(
      context(subject('ready'), { blockedByThis: ['sso-saml'] }),
      { target: 'cancelled', reason: 'superseded', resolution: 'superseded', overrides: ['G7'] },
    ))
  })

  it('G8 refuses an epic reaching done while a child is still open', () => {
    const epic = item('epic', { id: 'sso', state: 'in_progress' })
    const { error } = refusal(evaluateTransition(
      context(epic, { openChildren: [neighbour('sso-saml', 'story', 'in_progress')] }),
      { target: 'done' },
    ))
    assert.equal(error.rule, 'G8')
    assert.ok(error.message.includes('sso-saml'), error.message)
  })

  it('G8 is evaluated only for epics', () => {
    const allowed = allowance(evaluateTransition(
      context(item('task', { state: 'in_progress' }), { openChildren: [neighbour('x')] }),
      { target: 'done' },
    ))
    assert.equal(allowed.guards.some((g) => g.guard === 'G8'), false)
  })

  it('evaluates every guard on the edge and reports all of them, not only the first failure', () => {
    const outcome = refusal(evaluateTransition(
      context(subject('ready'), {
        blockers: [neighbour('a')],
        iterationMember: false,
        column: { name: 'in_progress', used: 5, limit: 5 },
      }),
      { target: 'in_progress' },
    ))
    assert.deepEqual(outcome.guards.map((g) => g.guard), ['G2', 'G3', 'G4'])
    assert.equal(outcome.guards.filter((g) => !g.pass).length, 3)
    // The error names the first failing guard; the body carries the rest.
    assert.equal(outcome.error.rule, 'G2')
    assert.deepEqual(outcome.error.entities, ['task-1'])
  })
})
