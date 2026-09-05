// SPDX-License-Identifier: Apache-2.0
// One explicit lifecycle (domain model 2.2). Every state change goes through this table,
// which is why the guards live in one place instead of once per verb.
//
// The evaluator is pure: it decides, it does not write. The caller supplies the derived
// facts each guard needs (gate verdicts, blockers, column usage, membership) and applies
// the outcome. docs/DOMAIN.md carries the rule table the errors name.

import { fail, type DomainError } from './errors.ts'
import type { GateVerdict } from './gates.ts'
import {
  ATTEMPT_OUTCOMES,
  RESOLUTIONS,
  WORK_ITEM_STATES,
  type AttemptOutcome,
  type GuardId,
  type ItemId,
  type Resolution,
  type TransitionName,
  type WorkItem,
  type WorkItemState,
} from './types.ts'

type TransitionSpec = {
  readonly name: TransitionName
  readonly from: WorkItemState
  readonly to: WorkItemState
  readonly guards: readonly GuardId[]
  readonly requiresReason: boolean
}

const HOLDABLE: readonly WorkItemState[] = ['draft', 'ready', 'in_progress', 'in_review']

export const TRANSITION_TABLE: readonly TransitionSpec[] = [
  { name: 'groom', from: 'draft', to: 'ready', guards: ['G1'], requiresReason: false },
  { name: 'ungroom', from: 'ready', to: 'draft', guards: [], requiresReason: true },
  { name: 'start', from: 'ready', to: 'in_progress', guards: ['G2', 'G3', 'G4'], requiresReason: false },
  { name: 'submit', from: 'in_progress', to: 'in_review', guards: ['G5'], requiresReason: false },
  { name: 'finish', from: 'in_progress', to: 'done', guards: ['G5', 'G6'], requiresReason: false },
  { name: 'rework', from: 'in_review', to: 'in_progress', guards: [], requiresReason: true },
  { name: 'accept', from: 'in_review', to: 'done', guards: ['G6'], requiresReason: false },
  { name: 'reopen', from: 'done', to: 'in_progress', guards: [], requiresReason: true },
  ...HOLDABLE.map((from): TransitionSpec => (
    { name: 'hold', from, to: 'on_hold', guards: [], requiresReason: true }
  )),
  ...HOLDABLE.map((to): TransitionSpec => (
    { name: 'resume', from: 'on_hold', to, guards: [], requiresReason: false }
  )),
  ...[...HOLDABLE, 'on_hold' as const].map((from): TransitionSpec => (
    { name: 'cancel', from, to: 'cancelled', guards: ['G7'], requiresReason: true }
  )),
  // An attempt that ended without the work being done has no legal exit that says so: a
  // hold leaves `next`, which ranks `ready` only, and a cancel leaves the board. The item
  // goes back to the queue and the log carries who tried and why it did not take.
  { name: 'release', from: 'in_progress', to: 'ready', guards: [], requiresReason: true },
  { name: 'revive', from: 'cancelled', to: 'draft', guards: [], requiresReason: true },
]

/**
 * The two closed-set values a transition carries, and the one edge each belongs to. Both
 * are on the same rule (`T6`) because they are the same rule: an edge that records a
 * machine-readable outcome refuses to be taken without one, and refuses one it does not own.
 */
const CLOSED_VALUE: Readonly<Record<string, {
  readonly on: TransitionName
  readonly allowed: readonly string[]
  readonly what: string
}>> = {
  resolution: { on: 'cancel', allowed: RESOLUTIONS, what: 'why the item stopped' },
  outcome: { on: 'release', allowed: ATTEMPT_OUTCOMES, what: 'how the attempt ended' },
}

/** G2, G3 and G7 yield to an explicit override with a reason (2.2). The rest never do. */
export const OVERRIDABLE_GUARDS: readonly GuardId[] = ['G2', 'G3', 'G7']

export type GuardResult = {
  readonly guard: GuardId
  readonly pass: boolean
  /** The value the guard saw, such as `4/5` for a column limit, not merely its verdict. */
  readonly observed?: string
  readonly reason?: string
  readonly remedy?: string
  readonly overridden?: boolean
}

export type TransitionContext = {
  readonly item: WorkItem
  /** G1 and G6: the same evaluation the gate command prints. */
  readonly readyGate: GateVerdict
  readonly doneGate: GateVerdict
  /** G2: active blockers, derived from the relation graph. */
  readonly blockers: readonly ItemId[]
  /** G3: the target column's usage. A limit of zero means unlimited. Absent means no board. */
  readonly column?: { readonly name: string; readonly used: number; readonly limit: number }
  /** G4: the item is in the active sprint, or on the board. */
  readonly iterationMember: boolean
  /** G5: this type has a review step in this workspace. */
  readonly reviewStep: boolean
  /** G7: active items this one blocks. */
  readonly blockedByThis: readonly ItemId[]
  /** G8: children of an epic that are neither done nor cancelled. */
  readonly openChildren: readonly ItemId[]
}

export type TransitionRequest = {
  readonly target: WorkItemState | 'resume'
  readonly reason?: string
  readonly overrides?: readonly GuardId[]
  /** Required by `cancel` and refused elsewhere; stored on the record. */
  readonly resolution?: Resolution
  /** Required by `release` and refused elsewhere; carried in the event, never on the record. */
  readonly outcome?: AttemptOutcome
}

export type TransitionOutcome =
  | { readonly outcome: 'already'; readonly state: WorkItemState }
  | {
    readonly outcome: 'allowed'
    readonly transition: TransitionName
    readonly from: WorkItemState
    readonly to: WorkItemState
    readonly guards: readonly GuardResult[]
  }
  | { readonly outcome: 'refused'; readonly error: DomainError; readonly guards: readonly GuardResult[] }

function specFor(item: WorkItem, to: WorkItemState): TransitionSpec | undefined {
  return TRANSITION_TABLE.find((spec) =>
    spec.from === item.state
    && spec.to === to
    && (spec.name !== 'resume' || to === item.held_from))
}

/** The states this particular item may move to now, resume resolved against held_from. */
export function legalTargetsFrom(item: WorkItem): readonly WorkItemState[] {
  return TRANSITION_TABLE
    .filter((spec) => spec.from === item.state && (spec.name !== 'resume' || spec.to === item.held_from))
    .map((spec) => spec.to)
}

function refuse(error: DomainError, guards: readonly GuardResult[] = []): TransitionOutcome {
  return { outcome: 'refused', error, guards }
}

function guardsFor(spec: TransitionSpec, item: WorkItem, to: WorkItemState): readonly GuardId[] {
  // An epic carries one guard the other types do not: it cannot close while a child is open
  // (2.2, "Epics use the same machine with two additional guards"). The model states that
  // rule without numbering it, so it is G8 here and docs/DOMAIN.md records the numbering.
  return item.type === 'epic' && to === 'done' ? [...spec.guards, 'G8'] : spec.guards
}

function evaluateGuard(guard: GuardId, context: TransitionContext, spec: TransitionSpec): GuardResult {
  const pass = (observed?: string): GuardResult =>
    (observed === undefined ? { guard, pass: true } : { guard, pass: true, observed })
  const no = (reason: string, remedy: string, observed?: string): GuardResult =>
    (observed === undefined
      ? { guard, pass: false, reason, remedy }
      : { guard, pass: false, reason, remedy, observed })

  switch (guard) {
    case 'G1': {
      const failed = context.readyGate.rules.filter((r) => !r.pass).map((r) => r.rule)
      return context.readyGate.pass
        ? pass()
        : no(`the ready gate fails: ${failed.join(', ')}`, `run the ready gate on ${context.item.id} and fix ${failed.join(' and ')}`)
    }
    case 'G2':
      return context.blockers.length === 0
        ? pass()
        : no(`${context.item.id} is blocked by ${context.blockers.join(', ')}`, `finish or cancel ${context.blockers.join(' and ')}, or override G2 with a reason`)
    case 'G3': {
      const column = context.column
      if (column === undefined) return pass()
      const observed = `${column.used}/${column.limit}`
      if (column.limit === 0 || column.used < column.limit) return pass(observed)
      return no(`the ${column.name} column is at its limit of ${column.limit}`, 'finish something in that column, or override G3 with a reason', observed)
    }
    case 'G4':
      return context.iterationMember
        ? pass()
        : no(`${context.item.id} is in no sprint and on no board`, `add ${context.item.id} to the active sprint or the board`)
    case 'G5': {
      const wantsReview = spec.name === 'submit'
      if (wantsReview === context.reviewStep) return pass(context.reviewStep ? 'review' : 'no-review')
      return context.reviewStep
        ? no(`a ${context.item.type} has a review step, so in_progress exits through in_review`, `run the submit transition on ${context.item.id} instead`)
        : no(`a ${context.item.type} has no review step, so in_progress exits through done`, `run the finish transition on ${context.item.id} instead`)
    }
    case 'G6': {
      const failed = context.doneGate.rules.filter((r) => !r.pass).map((r) => r.rule)
      return context.doneGate.pass
        ? pass()
        : no(`the done gate fails: ${failed.join(', ')}`, `run the done gate on ${context.item.id} and fix ${failed.join(' and ')}`)
    }
    case 'G7':
      return context.blockedByThis.length === 0
        ? pass()
        : no(`${context.blockedByThis.join(', ')} are still blocked by ${context.item.id}`, 'cascade the cancellation with a reason, which raises an impediment on each of them')
    case 'G8':
      return context.openChildren.length === 0
        ? pass()
        : no(`the epic still has open children: ${context.openChildren.join(', ')}`, `finish or cancel ${context.openChildren.join(' and ')}`)
  }
}

/**
 * Decides one state change. Returns `already` for an idempotent request, `allowed` with
 * every guard result, or `refused` with a structured error naming the rule it broke.
 */
export function evaluateTransition(
  context: TransitionContext,
  request: TransitionRequest,
): TransitionOutcome {
  const { item } = context
  const { target } = request

  if (target !== 'resume' && !(WORK_ITEM_STATES as readonly string[]).includes(target)) {
    return refuse(fail('VALIDATION', 'T2', `${String(target)} is not a state; the targets are ${WORK_ITEM_STATES.join(', ')} and resume`, [item.id]).error)
  }

  if (target !== 'resume' && target === item.state) {
    return { outcome: 'already', state: item.state }
  }

  let to: WorkItemState
  if (target === 'resume') {
    if (item.state !== 'on_hold') {
      return refuse(fail('GUARD_REFUSED', 'T3', `resume is legal only from on_hold, and ${item.id} is ${item.state}`, [item.id]).error)
    }
    if (item.held_from === undefined) {
      return refuse(fail('INTEGRITY', 'T3', `${item.id} is on_hold with no held_from recorded, so resume has no state to restore`, [item.id]).error)
    }
    to = item.held_from
  } else {
    to = target
  }

  const spec = specFor(item, to)
  if (spec === undefined) {
    const isResumeEdge = TRANSITION_TABLE.some((s) => s.from === item.state && s.to === to && s.name === 'resume')
    const error = isResumeEdge
      ? fail('GUARD_REFUSED', 'T3', `an item in on_hold restores the state it was held from, which is ${String(item.held_from)}, not ${to}`, [item.id]).error
      : fail('GUARD_REFUSED', 'T1', `no transition moves an item from ${item.state} to ${to}`, [item.id]).error
    return refuse(error)
  }

  const evaluated = guardsFor(spec, item, to)
  const overrides = request.overrides ?? []
  for (const guard of overrides) {
    if (!evaluated.includes(guard)) {
      return refuse(fail('VALIDATION', 'T5', `the ${spec.name} transition does not evaluate ${guard}, so it cannot be overridden`, [item.id]).error)
    }
    if (!OVERRIDABLE_GUARDS.includes(guard)) {
      return refuse(fail('VALIDATION', 'T5', `${guard} cannot be overridden; fix the item instead`, [item.id]).error)
    }
  }

  for (const [name, rule] of Object.entries(CLOSED_VALUE)) {
    const given = request[name as 'resolution' | 'outcome']
    if (spec.name !== rule.on) {
      if (given === undefined) continue
      return refuse(fail('VALIDATION', 'T6', `only the ${rule.on} transition records ${name}, and this is ${spec.name}`, [item.id]).error)
    }
    if (given === undefined) {
      return refuse(fail('VALIDATION', 'T6', `the ${rule.on} transition records ${name}, ${rule.what}, and none was given; the set is ${rule.allowed.join(', ')}`, [item.id]).error)
    }
    if (!rule.allowed.includes(given)) {
      return refuse(fail('VALIDATION', 'T6', `${given} is not a ${name}; the set is ${rule.allowed.join(', ')}`, [item.id]).error)
    }
  }

  const needsReason = spec.requiresReason || overrides.length > 0
  if (needsReason && (request.reason === undefined || request.reason.trim() === '')) {
    return refuse(fail('VALIDATION', 'T4', spec.requiresReason
      ? `the ${spec.name} transition records a reason, and none was given`
      : `an override records a reason, and none was given`, [item.id]).error)
  }

  const results = evaluated.map((guard): GuardResult => {
    const result = evaluateGuard(guard, context, spec)
    return !result.pass && overrides.includes(guard)
      ? { ...result, pass: true, overridden: true }
      : result
  })

  const failures = results.filter((r) => !r.pass)
  const first = failures[0]
  if (first !== undefined) {
    return refuse(
      fail('GUARD_REFUSED', first.guard, failures.map((f) => f.reason).join('; '), [item.id]).error,
      results,
    )
  }

  return { outcome: 'allowed', transition: spec.name, from: item.state, to, guards: results }
}
