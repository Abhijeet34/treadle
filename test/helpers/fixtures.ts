// SPDX-License-Identifier: Apache-2.0
// Fixture builders shared by the domain tests. Every builder returns a value that
// passes validateWorkItem, so a test that wants a failure has to introduce it.

import assert from 'node:assert/strict'

import type {
  DomainError,
  GateContext,
  GateVerdict,
  Instant,
  Result,
  TransitionContext,
  TransitionOutcome,
  WorkItem,
  WorkItemState,
  WorkItemType,
} from '../../src/domain/index.ts'

export const NOW: Instant = '2026-09-05T12:00:00Z'

// Narrowing helpers. node:assert's `ok` is declared `asserts value`, so these give the
// tests a typed value instead of a cast, and a readable message when the shape is wrong.

export function unwrap<T>(result: Result<T>): T {
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`)
  return result.value
}

export function errorOf(result: Result<unknown>): DomainError {
  assert.ok(!result.ok, `expected a refusal, got ${JSON.stringify(result)}`)
  return result.error
}

export function allowance(outcome: TransitionOutcome): Extract<TransitionOutcome, { outcome: 'allowed' }> {
  assert.ok(outcome.outcome === 'allowed', `expected allowed, got ${JSON.stringify(outcome)}`)
  return outcome
}

export function refusal(outcome: TransitionOutcome): Extract<TransitionOutcome, { outcome: 'refused' }> {
  assert.ok(outcome.outcome === 'refused', `expected refused, got ${JSON.stringify(outcome)}`)
  return outcome
}

export function idempotence(outcome: TransitionOutcome): Extract<TransitionOutcome, { outcome: 'already' }> {
  assert.ok(outcome.outcome === 'already', `expected already, got ${JSON.stringify(outcome)}`)
  return outcome
}

const TYPE_DEFAULTS: Record<WorkItemType, Partial<WorkItem>> = {
  epic: { outcome: 'Enterprise tenants can sign in with their own identity provider' },
  story: {},
  task: {},
  bug: { severity: 'S2', repro_steps: 'Sign in, wait for the token to expire, reload', found_in: 'test' },
  spike: { question: 'Which ranker do we adopt', timebox_hours: 8 },
  chore: {},
  impediment: { severity: 'S2', proposed_resolution: 'The platform team renews the staging certificate' },
}

export function item(type: WorkItemType, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: over.id ?? `${type}-1`,
    type,
    state: 'draft',
    title: `A ${type}`,
    filed_at: '2026-09-01T09:00:00Z',
    version: 1,
    ...TYPE_DEFAULTS[type],
    ...over,
  }
}

export function passing(gate: GateVerdict['gate']): GateVerdict {
  return { gate, pass: true, rules: [] }
}

export function failing(gate: GateVerdict['gate'], rule: string): GateVerdict {
  return {
    gate,
    pass: false,
    rules: [{ rule, sentence: `rule ${rule}`, pass: false, reason: 'seeded failure' }],
  }
}

/** A context in which every guard passes, so a test isolates the one thing it changes. */
export function context(subject: WorkItem, over: Partial<TransitionContext> = {}): TransitionContext {
  return {
    item: subject,
    readyGate: passing('ready'),
    doneGate: passing('done'),
    blockers: [],
    iterationMember: true,
    reviewStep: false,
    blockedByThis: [],
    openChildren: [],
    ...over,
  }
}

export function gateContext(subject: WorkItem, over: Partial<GateContext> = {}): GateContext {
  return {
    item: subject,
    blockers: [],
    children: [],
    reviewStep: false,
    openImpediments: [],
    ...over,
  }
}

export function child(id: string, type: WorkItemType, state: WorkItemState): GateContext['children'][number] {
  return { id, type, state }
}
