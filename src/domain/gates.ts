// SPDX-License-Identifier: Apache-2.0
// Definition of ready and definition of done (domain model 2.6).
// A gate is a named, ordered list of rules; a rule is an id, a human sentence, a scope and
// one check from a closed set. One evaluator serves both the built-in gates and a gate a
// workspace configures, which is the Policy seam: the second implementation is data, not
// a second code path, so what the gate prints is exactly what guards G1 and G6 decide.

import { fail, ok, type Result } from './errors.ts'
import { withArticle } from './text.ts'
import { fieldsOf, isKnownField, placeholderOf, requiredAtCreation, writeCommand, writerOf } from './fields.ts'
import { advance } from './state-machine.ts'
import {
  isTerminal,
  type GateItem,
  type GateRuleVerdict,
  type GateVerdict,
  type WorkItem,
  type WorkItemType,
} from './types.ts'

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
  | { readonly kind: 'blocks_something' }
  | { readonly kind: 'not_a_duplicate' }
  | { readonly kind: 'reviewer_distinct_from_assignee' }
  | { readonly kind: 'evidence_present' }

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


export type GateContext = {
  readonly item: WorkItem
  /** Active blockers, derived from the relation graph by the caller; DOD2 reads the impediments among them. */
  readonly blockers: readonly GateItem[]
  readonly children: readonly GateItem[]
  /** Whether this type has a review step in this workspace (guard G5's setting). */
  readonly reviewStep: boolean
  /**
   * DOR10: the original this item is a copy of, when the store holds it. Absent covers both
   * "no such edge" and "the edge names a record nothing holds", which is H24's finding and
   * must not hold the copy at draft forever on a record nobody can move.
   */
  readonly duplicateOf?: GateItem
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
    // Appended rather than filed beside DOR3, because a rule id is a name a refusal prints
    // and renumbering one would rewrite what every past refusal said. DOR10 is scoped to
    // every type and still sits last for the same reason.
    { id: 'DOR9', scope: 'impediment', sentence: 'The impediment says what it holds up.', check: { kind: 'blocks_something' } },
    { id: 'DOR10', scope: 'all', sentence: 'The item is not a copy of another item.', check: { kind: 'not_a_duplicate' } },
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
    { id: 'DOD7', scope: 'all', sentence: 'The item points at evidence, when the type has a review step.', check: { kind: 'evidence_present' } },
  ],
}

type Outcome =
  | { readonly pass: true }
  | { readonly pass: false; readonly reason: string; readonly remedy?: string }

const PASS: Outcome = { pass: true }

/**
 * A failed rule. The remedy is optional and is left off rather than filled with prose: a
 * caller reads it as a command line to run, so a sentence there is a promise nothing keeps.
 * test/domain/gate-remedies.test.ts is what holds every remedy that is emitted to that.
 */
function no(reason: string, remedy?: string): Outcome {
  return remedy === undefined ? { pass: false, reason } : { pass: false, reason, remedy }
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
        ? no(`${check.field} is not set`, writeCommand(check.field, item.id, '<value>'))
        : PASS
    }
    case 'field_is_true':
      return fieldOf(item, check.field) === true
        ? PASS
        : no(`${check.field} is not true`, writeCommand(check.field, item.id, 'true'))
    case 'field_non_empty_list': {
      const value = fieldOf(item, check.field)
      return Array.isArray(value) && value.length > 0
        ? PASS
        : no(`${check.field} is empty`, writeCommand(check.field, item.id, '"<entry>|<entry>"'))
    }
    case 'list_all_ticked': {
      const value = fieldOf(item, check.field)
      if (!Array.isArray(value) || value.length === 0) {
        return no(`${check.field} is empty`, writeCommand(check.field, item.id, '"<entry>|<entry>"'))
      }
      const open = (value as readonly { ticked?: boolean }[]).filter((e) => e.ticked !== true).length
      return open === 0
        ? PASS
        : no(
          `${open} of ${value.length} entries in ${check.field} are not ticked`,
          writeCommand(check.field, item.id, '"[x] <entry>|[x] <entry>"'),
        )
    }
    case 'type_required_fields': {
      const missing = requiredAtCreation(item.type).filter((f) => fieldOf(item, f) === undefined)
      if (missing.length === 0) return PASS
      const reason = `the ${item.type} is missing ${missing.join(', ')}`
      // The missing fields are not all one command's: a bug with no `severity` is `mark`'s
      // and a bug with no `repro_steps` is `set`'s. One remedy is one command line, so a
      // mixed set names the first field's own command and the reason names all of them; the
      // rule fails again on what is left, which is `set`'s and groups into one line.
      const first = missing[0] as string
      return missing.every((f) => writerOf(f).kind === 'set')
        ? no(reason, `treadle set ${item.id} ${missing.map((f) => `${f}=${placeholderOf(f)}`).join(' ')}`)
        : no(reason, writeCommand(first, item.id, placeholderOf(first)))
    }
    case 'estimate_set':
      return typeof item.points === 'number'
        ? PASS
        : no('points are not set', writeCommand('points', item.id, '<n>'))
    case 'no_active_blocker': {
      const first = context.blockers[0]
      return first === undefined
        ? PASS
        : no(`blocked by ${context.blockers.map((b) => b.id).join(', ')}`, advance(first))
    }
    case 'parent_present':
      return item.parent_id === undefined
        ? no('the item has no parent', writeCommand('parent_id', item.id, '<id>'))
        : PASS
    case 'child_present': {
      const wanted = check.childType
      const matching = context.children.filter((c) => wanted === undefined || c.type === wanted)
      return matching.length > 0
        ? PASS
        : no(
          `the item has no ${wanted ?? 'child'} child`,
          `treadle file ${wanted ?? '<type>'} "<title>" --set parent_id=${item.id}`,
        )
    }
    case 'no_open_child': {
      const open = context.children.filter((c) => !isTerminal(c.state))
      const first = open[0]
      return first === undefined
        ? PASS
        : no(`${open.map((c) => c.id).join(', ')} are still open`, advance(first))
    }
    // An impediment is resolved by reaching `done`, so the remedy is the same move DOR3
    // names for any blocker; the rule is kept beside it because it fails on the done gate,
    // where DOR3 is not evaluated: an impediment raised against work in progress holds the
    // work from finishing until it is resolved.
    case 'no_open_impediment': {
      const open = context.blockers.filter((b) => b.type === 'impediment')
      const first = open[0]
      return first === undefined
        ? PASS
        : no(
          `${open.map((b) => b.id).join(', ')} ${open.length === 1 ? 'is' : 'are'} still open against the item`,
          advance(first),
        )
    }
    // The impediment's own `blocks` edges, read off its own record, which is where ADR-0015
    // stores them and where doctor's H27 reads them. Grooming is where this belongs: an
    // impediment nobody has raised against anything is a record still being written, and
    // `draft` is the state for that, so H27 no longer fires there and this refuses the move out.
    case 'blocks_something':
      // Finished work is history on both rules below: the remedy each names is a move the
      // machine refuses from `done` or `cancelled`, and neither rule has anything to ask of
      // an item nobody is going to pick up.
      if (isTerminal(item.state)) return PASS
      return (item.relations ?? []).some((relation) => relation.kind === 'blocks')
        ? PASS
        : no('it holds nothing up', `treadle relation add ${item.id} blocks <id>`)
    case 'not_a_duplicate': {
      const original = context.duplicateOf
      return original === undefined || isTerminal(item.state)
        ? PASS
        : no(
          `it duplicates ${original.id}, and a copy is not separate work`,
          `treadle transition ${item.id} cancelled --resolution duplicate --reason "<why>"`,
        )
    }
    case 'reviewer_distinct_from_assignee': {
      if (!context.reviewStep) return PASS
      const reviewer = writeCommand('reviewer', item.id, '<name>')
      if (item.reviewer === undefined) return no('no reviewer is recorded', reviewer)
      return item.reviewer === item.assignee
        ? no(`the reviewer ${item.reviewer} is also the assignee`, reviewer)
        : PASS
    }
    // Scoped by the review step rather than by three per-type rules, the same way DOD3 is:
    // the two together are the anti-attestation pair, so they answer to one setting.
    case 'evidence_present': {
      if (!context.reviewStep) return PASS
      const entries = item.evidence ?? []
      return entries.length > 0
        ? PASS
        : no(
          'the item points at no evidence',
          `treadle evidence add ${item.id} <kind> <ref> [label]`,
        )
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
        `gate rule ${rule.id} reads ${field}, which is not a field of ${rule.scope === 'all' ? 'every type' : withArticle(rule.scope)}`,
        [rule.id, field],
      )
    }
  }
  return ok(gate)
}
