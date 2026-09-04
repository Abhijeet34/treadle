// SPDX-License-Identifier: Apache-2.0
// Definition of ready and definition of done (domain model 2.6).
// A gate is a named, ordered list of rules; a rule is an id, a human sentence, a scope and
// one check from a closed set. One evaluator serves both the built-in gates and a gate a
// workspace configures, which is the Policy seam: the second implementation is data, not
// a second code path, so what the gate prints is exactly what guards G1 and G6 decide.

import { fail, ok, type Result } from './errors.ts'
import { fieldsOf, isKnownField, requiredAtCreation } from './fields.ts'
import { isTerminal, type ItemId, type WorkItem, type WorkItemState, type WorkItemType } from './types.ts'

export type GateCheck =
  | { readonly kind: 'field_present'; readonly field: string }
  | { readonly kind: 'field_non_empty_list'; readonly field: string }
  | { readonly kind: 'list_all_ticked'; readonly field: string }
  | { readonly kind: 'field_is_true'; readonly field: string }
  | { readonly kind: 'type_required_fields' }
  | { readonly kind: 'estimate_set' }
  | { readonly kind: 'no_active_blocker' }
  | { readonly kind: 'parent_present' }
  | { readonly kind: 'child_present'; readonly childType?: WorkItemType }
  | { readonly kind: 'no_open_child' }
  | { readonly kind: 'no_open_impediment' }
  | { readonly kind: 'reviewer_distinct_from_assignee' }

export type GateRule = {
  readonly id: string
  readonly sentence: string
  readonly scope: 'all' | WorkItemType
  readonly check: GateCheck
}

export type Gate = {
  readonly name: string
  readonly rules: readonly GateRule[]
}

export type GateChild = {
  readonly id: ItemId
  readonly type: WorkItemType
  readonly state: WorkItemState
}

export type GateContext = {
  readonly item: WorkItem
  /** Active blockers, derived from the relation graph by the caller. */
  readonly blockers: readonly ItemId[]
  readonly children: readonly GateChild[]
  /** Whether this type has a review step in this workspace (guard G5's setting). */
  readonly reviewStep: boolean
  readonly openImpediments: number
}

export type GateRuleVerdict = {
  readonly rule: string
  readonly sentence: string
  readonly pass: boolean
  readonly reason?: string
  readonly remedy?: string
}

export type GateVerdict = {
  readonly gate: string
  readonly pass: boolean
  readonly rules: readonly GateRuleVerdict[]
}

export const DEFAULT_READY_GATE: Gate = {
  name: 'ready',
  rules: [
    { id: 'DOR1', scope: 'all', sentence: 'The item has a title.', check: { kind: 'field_present', field: 'title' } },
    { id: 'DOR2', scope: 'all', sentence: 'The fields the type requires at creation are present.', check: { kind: 'type_required_fields' } },
    { id: 'DOR3', scope: 'all', sentence: 'Nothing active is blocking the item.', check: { kind: 'no_active_blocker' } },
    { id: 'DOR4', scope: 'story', sentence: 'The story has at least one acceptance criterion.', check: { kind: 'field_non_empty_list', field: 'acceptance_criteria' } },
    { id: 'DOR5', scope: 'story', sentence: 'The story is estimated in points.', check: { kind: 'estimate_set' } },
    { id: 'DOR6', scope: 'bug', sentence: 'The bug records what was expected.', check: { kind: 'field_present', field: 'expected' } },
    { id: 'DOR7', scope: 'bug', sentence: 'The bug records what actually happened.', check: { kind: 'field_present', field: 'actual' } },
    { id: 'DOR8', scope: 'epic', sentence: 'The epic has at least one child story.', check: { kind: 'child_present', childType: 'story' } },
  ],
}

export const DEFAULT_DONE_GATE: Gate = {
  name: 'done',
  rules: [
    { id: 'DOD1', scope: 'all', sentence: 'Every child is done or cancelled.', check: { kind: 'no_open_child' } },
    { id: 'DOD2', scope: 'all', sentence: 'No impediment is still open against the item.', check: { kind: 'no_open_impediment' } },
    { id: 'DOD3', scope: 'all', sentence: 'A reviewer other than the assignee accepted it, when the type has a review step.', check: { kind: 'reviewer_distinct_from_assignee' } },
    { id: 'DOD4', scope: 'story', sentence: 'Every acceptance criterion is ticked.', check: { kind: 'list_all_ticked', field: 'acceptance_criteria' } },
    { id: 'DOD5', scope: 'spike', sentence: 'The spike records its findings.', check: { kind: 'field_present', field: 'findings' } },
    { id: 'DOD6', scope: 'bug', sentence: 'The fix is confirmed.', check: { kind: 'field_is_true', field: 'fix_confirmed' } },
  ],
}

type Outcome = { readonly pass: true } | { readonly pass: false; readonly reason: string; readonly remedy: string }

const PASS: Outcome = { pass: true }

function no(reason: string, remedy: string): Outcome {
  return { pass: false, reason, remedy }
}

function fieldOf(item: WorkItem, name: string): unknown {
  return (item as unknown as Record<string, unknown>)[name]
}

function run(check: GateCheck, context: GateContext): Outcome {
  const { item } = context
  switch (check.kind) {
    case 'field_present': {
      const value = fieldOf(item, check.field)
      return value === undefined || value === ''
        ? no(`${check.field} is not set`, `set ${check.field} on ${item.id}`)
        : PASS
    }
    case 'field_is_true':
      return fieldOf(item, check.field) === true
        ? PASS
        : no(`${check.field} is not true`, `set ${check.field} to true on ${item.id}`)
    case 'field_non_empty_list': {
      const value = fieldOf(item, check.field)
      return Array.isArray(value) && value.length > 0
        ? PASS
        : no(`${check.field} is empty`, `add at least one entry to ${check.field} on ${item.id}`)
    }
    case 'list_all_ticked': {
      const value = fieldOf(item, check.field)
      if (!Array.isArray(value) || value.length === 0) {
        return no(`${check.field} is empty`, `add at least one entry to ${check.field} on ${item.id}`)
      }
      const open = (value as readonly { ticked?: boolean }[]).filter((e) => e.ticked !== true).length
      return open === 0
        ? PASS
        : no(`${open} of ${value.length} entries in ${check.field} are not ticked`, `tick the remaining ${open} entries on ${item.id}`)
    }
    case 'type_required_fields': {
      const missing = requiredAtCreation(item.type).filter((f) => fieldOf(item, f) === undefined)
      return missing.length === 0
        ? PASS
        : no(`the ${item.type} is missing ${missing.join(', ')}`, `set ${missing.join(' and ')} on ${item.id}`)
    }
    case 'estimate_set':
      return typeof item.points === 'number'
        ? PASS
        : no('points are not set', `run an estimate on ${item.id}`)
    case 'no_active_blocker':
      return context.blockers.length === 0
        ? PASS
        : no(`blocked by ${context.blockers.join(', ')}`, `finish or cancel ${context.blockers.join(' and ')}`)
    case 'parent_present':
      return item.parent_id === undefined
        ? no('the item has no parent', `set a parent on ${item.id}`)
        : PASS
    case 'child_present': {
      const wanted = check.childType
      const matching = context.children.filter((c) => wanted === undefined || c.type === wanted)
      return matching.length > 0
        ? PASS
        : no(
          `the item has no ${wanted ?? 'child'} child`,
          `file a ${wanted ?? 'child'} with ${item.id} as its parent`,
        )
    }
    case 'no_open_child': {
      const open = context.children.filter((c) => !isTerminal(c.state)).map((c) => c.id)
      return open.length === 0
        ? PASS
        : no(`${open.join(', ')} are still open`, `finish or cancel ${open.join(' and ')}`)
    }
    case 'no_open_impediment':
      return context.openImpediments === 0
        ? PASS
        : no(`${context.openImpediments} impediments are still open`, `resolve them before closing ${item.id}`)
    case 'reviewer_distinct_from_assignee': {
      if (!context.reviewStep) return PASS
      if (item.reviewer === undefined) return no('no reviewer is recorded', `record a reviewer on ${item.id}`)
      return item.reviewer === item.assignee
        ? no(`the reviewer ${item.reviewer} is also the assignee`, `record a reviewer other than ${item.assignee}`)
        : PASS
    }
  }
}

/** Evaluates the rules in scope for the item's type, in the gate's own order. */
export function evaluateGate(gate: Gate, context: GateContext): GateVerdict {
  const rules = gate.rules
    .filter((rule) => rule.scope === 'all' || rule.scope === context.item.type)
    .map((rule): GateRuleVerdict => {
      const outcome = run(rule.check, context)
      return outcome.pass
        ? { rule: rule.id, sentence: rule.sentence, pass: true }
        : { rule: rule.id, sentence: rule.sentence, pass: false, reason: outcome.reason, remedy: outcome.remedy }
    })
  return { gate: gate.name, pass: rules.every((r) => r.pass), rules }
}

/**
 * What makes a workspace-configured gate safe to load. Doctor finding H14 is a gate rule
 * naming a field the type does not have; this is the check that produces it.
 */
export function validateGate(gate: Gate): Result<Gate> {
  const seen = new Set<string>()
  for (const rule of gate.rules) {
    if (seen.has(rule.id)) {
      return fail('VALIDATION', 'V7', `the gate ${gate.name} uses the rule id ${rule.id} twice`, [rule.id])
    }
    seen.add(rule.id)

    const field = 'field' in rule.check ? rule.check.field : undefined
    if (field === undefined) continue

    const permitted = rule.scope === 'all'
      ? isKnownField(field) && fieldsOf('task').includes(field)
      : fieldsOf(rule.scope).includes(field)
    if (!permitted) {
      return fail(
        'VALIDATION',
        'V6',
        `gate rule ${rule.id} reads ${field}, which is not a field of ${rule.scope === 'all' ? 'every type' : `a ${rule.scope}`}`,
        [rule.id, field],
      )
    }
  }
  return ok(gate)
}
