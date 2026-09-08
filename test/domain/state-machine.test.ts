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
  edgeRequirements,
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
    assert.deepEqual([...GUARD_IDS], ['G1', 'G2', 'G3', 'G5', 'G6', 'G7', 'G8'])
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

// `explain` printed guard ids alone, so eight of the thirteen transition names read as
// "this move needs nothing" on a move `transition` then refused as T4 or T6. The row and the
// refusal now come off one table, and the oracle above is what holds both to the model.
describe('edgeRequirements names what each edge records, and the evaluator refuses exactly that', () => {
  for (const from of WORK_ITEM_STATES) {
    for (const [to, name] of Object.entries(LEGAL[from]) as readonly [WorkItemState, TransitionName][]) {
      const closed = Object.keys(CLOSED_VALUE[name] ?? {})
      const expected = [...(REASON_REQUIRED.has(name) ? ['reason'] : []), ...closed]

      it(`${from} -> ${to} (${name}) records ${expected.join(',') || 'nothing'}`, () => {
        assert.deepEqual([...edgeRequirements(subject(from), to).records], expected)
      })

      it(`${from} -> ${to} (${name}) is refused with nothing recorded, and taken with all of it`, () => {
        // G5 decides which of the two `in_progress` exits this item has, and it is a guard
        // rather than something the edge records, so the context is set for the edge tried.
        const setting = context(subject(from), { reviewStep: to === 'in_review' })
        const bare = evaluateTransition(setting, { target: to })
        if (expected.length === 0) {
          assert.equal(bare.outcome, 'allowed', `${name} needs nothing and was ${JSON.stringify(bare)}`)
          return
        }
        // T4 is the missing reason and T6 the missing closed value; which of the two fires
        // first is the evaluator's order, and either proves the row was not empty.
        assert.ok(['T4', 'T6'].includes(refusal(bare).error.rule ?? ''), `${name}: rule was ${refusal(bare).error.rule}`)
        const whole = evaluateTransition(setting, {
          target: to, reason: 'because', ...(CLOSED_VALUE[name] ?? {}),
        })
        assert.equal(whole.outcome, 'allowed', `${name} was refused with everything the row names: ${JSON.stringify(whole)}`)
      })
    }
  }

  // The one guard no spec's own list carries; `explain` used to add it in a second copy of
  // this rule, in the service layer, where nothing held the two together.
  it('adds G8 to an epic closing, and to nothing else', () => {
    assert.deepEqual([...edgeRequirements(item('epic', { state: 'in_progress' }), 'done').guards], ['G5', 'G6', 'G8'])
    assert.deepEqual([...edgeRequirements(item('task', { state: 'in_progress' }), 'done').guards], ['G5', 'G6'])
  })

  it('names nothing at all for an edge the table does not carry', () => {
    assert.deepEqual(edgeRequirements(subject('done'), 'draft'), { guards: [], records: [] })
  })
})

describe('legalTargetsFrom agrees with the oracle', () => {
  for (const from of WORK_ITEM_STATES) {
    it(`lists the legal targets of ${from}`, () => {
      // The table's edge set is the oracle, and G5 then decides which of the two `in_progress`
      // exits this item's type actually has. Reading the table without it listed both for every
      // item, so `explain` on a task named `in_review` and on a story named `done`, each of
      // which `transition` then refused with G5.
      const reviews = Object.keys(LEGAL[from]).filter((to) => !(from === 'in_progress' && to === 'done'))
      const straight = Object.keys(LEGAL[from]).filter((to) => to !== 'in_review')
      assert.deepEqual([...legalTargetsFrom(subject(from), true)].sort(), reviews.sort())
      assert.deepEqual([...legalTargetsFrom(subject(from), false)].sort(), straight.sort())
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

  // An on_hold record with no `held_from` cannot reach this evaluator: `V4` requires the
  // field on every on_hold record and the store quarantines one without it, so ADR-0029
  // removed the branch that used to guess. What is asserted instead is that the field the
  // evaluator does read is the one it restores.
  it('restores the state the record says it was held from, and no other', () => {
    const held = item('task', { state: 'on_hold', hold_reason: 'vendor', held_from: 'in_progress' })
    const outcome = evaluateTransition(context(held), { target: 'resume' })
    assert.equal(outcome.outcome, 'allowed')
    assert.equal(outcome.outcome === 'allowed' ? outcome.to : '-', 'in_progress')
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

// `T2` refused a target that is not a state and was removed with ADR-0029, because
// `src/cli/main.ts` refuses one with `C1` before this evaluator runs and no other caller
// exists. `test/cli/contract.test.ts` holds that refusal from the surface a caller reaches.

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
        column: { name: 'in_progress', used: 5, limit: 5 },
      }),
      { target: 'in_progress' },
    ))
    assert.deepEqual(outcome.guards.map((g) => g.guard), ['G2', 'G3'])
    assert.equal(outcome.guards.filter((g) => !g.pass).length, 2)
    // The error names the first failing guard; the body carries the rest.
    assert.equal(outcome.error.rule, 'G2')
    assert.deepEqual(outcome.error.entities, ['task-1'])
  })
})

// The idempotent answer was given before an edge was chosen and every value check ran after
// it, so a line that is `T5` or `T6` on any real edge exited 0 when the item already stood
// in the state it asked for.
describe('a request whose values are wrong is wrong whatever state the item is in', () => {
  const draft = context(subject('draft'))

  it('refuses a closed-set value outside its set on the idempotent request', () => {
    const outcome = refusal(evaluateTransition(draft, {
      target: 'draft',
      resolution: 'bogus' as never,
      outcome: 'bogus' as never,
    }))
    assert.equal(outcome.error.rule, 'T6')
    assert.match(outcome.error.message, /bogus is not a resolution; the set is wont_do/)
    assert.match(outcome.error.message, /bogus is not an outcome; the set is failed, yielded/)
  })

  it('refuses an override naming something that is not a guard, and one that never yields', () => {
    const unknown = refusal(evaluateTransition(draft, { target: 'draft', overrides: ['G9' as never] }))
    assert.equal(unknown.error.rule, 'T5')
    assert.match(unknown.error.message, /^G9 is not a guard; the guards are G1, G2, G3, G5, G6, G7, G8$/)

    const fixed = refusal(evaluateTransition(draft, { target: 'draft', overrides: ['G1'] }))
    assert.match(fixed.error.message, /^G1 cannot be overridden; fix the item instead$/)
  })

  it('still answers already for a request whose values are right', () => {
    assert.equal(idempotence(evaluateTransition(draft, { target: 'draft' })).state, 'draft')
    assert.equal(
      idempotence(evaluateTransition(context(subject('cancelled')), { target: 'cancelled', resolution: 'wont_do' })).state,
      'cancelled',
    )
    assert.equal(
      idempotence(evaluateTransition(draft, { target: 'draft', overrides: ['G2'], reason: 'retrying' })).state,
      'draft',
    )
  })
})
