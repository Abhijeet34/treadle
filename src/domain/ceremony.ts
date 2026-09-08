// SPDX-License-Identifier: Apache-2.0
// The retrospective: a record of a judgement about the process, frozen at the instant it
// was made, and the ids of the work it produced.
//
// It is not a work item and it is not a period. ADR-0017 made the impediment a type because
// it moves through the lifecycle and blocks through an edge every item has; ADR-0016 refused
// the same shape for the sprint because a period has no gate, no estimate and no `done`. A
// retrospective is neither: it never becomes `in_progress`, nothing is assigned it, and
// `next` would have nothing to rank. So it is a record kind of its own, the third after the
// item and the sprint, in the same grammar and the same month-sharded layout.
//
// One kind, not a ceremony family. A standup restates `history`, `next`, `board` and
// `explain`, all of which are never a day old on an agent-driven board; a review restates
// the transitions that accepted the work. A retrospective is the one whose content no
// transition, event or projection reconstructs, and the one that produces something the
// store can hold honestly: the actions are chores, and the link to them is a fact the tool
// keeps true rather than prose it merely stores.
// docs/architecture/adr/0028-a-retrospective-is-a-record-of-its-own-kind.md carries the
// argument for each of these.

import { fail, ok, type Failure, type Result } from './errors.ts'
import { MAX_DESCRIPTION, isInstant } from './fields.ts'
import { validateFieldKeys } from './record.ts'
import { isSafeText } from './text.ts'
import type { Instant, ItemId } from './types.ts'

/**
 * A constant. The record grammar's damaged-heading resynchroniser keys on four mandatory
 * field lines, `type`, `state`, `filed_at` and `version`, and relaxing that per record kind
 * is a change to the one rule that closed axis A5. A retrospective has no lifecycle, so the
 * line says the one thing it can: this happened, and it is a record now.
 */
const CEREMONY_STATES = ['recorded'] as const
export type CeremonyState = (typeof CEREMONY_STATES)[number]

/**
 * The two prose halves are stored sections, so they take the bound the tool's other stored
 * section takes rather than the 500 a one-line reason takes: what a team says went badly
 * over a fortnight is several paragraphs, and a retrospective a `--badly` flag could not
 * carry is a record nobody would file twice. It stays far under the 128 KiB section ceiling.
 */
const MAX_CEREMONY_PROSE = MAX_DESCRIPTION

/** The most actions one retrospective may name, which bounds `actions` under the 8 KiB field ceiling. */
const MAX_CEREMONY_ACTIONS = 50

export type Ceremony = {
  readonly id: string
  readonly title: string
  readonly state: CeremonyState
  /** The instant the retrospective was held, and the month whose shard holds the record. */
  readonly filed_at: Instant
  readonly version: number
  /** The sprint it looked back over, when it looked back over one. */
  readonly sprint_id?: string
  /**
   * The chores this retrospective produced, named here and nowhere else. A relation targets
   * items only (`P4`) and the chore carries no back-pointer, so this list is the one place
   * the link is stored; `S17` refuses a removal that would leave it naming nothing.
   */
  readonly actions?: readonly ItemId[]
  /** What the team said went well, as the `Went well` section. */
  readonly well?: string
  /** What the team said went badly, as the `Went badly` section. */
  readonly badly?: string
  /** Keys a newer writer produced that this version does not know, preserved verbatim. */
  readonly extra?: ReadonlyMap<string, string>
}

/**
 * Every field a ceremony record persists, which is the list the visibility sweep in
 * test/architecture/field-visibility.test.ts holds to a read surface. `id` and `title` sit
 * in the record heading, as an item's and a sprint's do.
 */
export const CEREMONY_FIELDS = [
  'id', 'title', 'state', 'filed_at', 'version', 'sprint_id', 'actions', 'well', 'badly', 'extra',
] as const

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

function invalid(rule: string, message: string, id: string | undefined): Failure {
  return fail('VALIDATION', rule, message, id === undefined ? [] : [id])
}

function prose(ceremony: Ceremony, field: 'well' | 'badly'): Failure | undefined {
  const value = ceremony[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || !isSafeText(value, 'text')) {
    return invalid('V4', `${field} must be 1 to ${MAX_CEREMONY_PROSE} characters and may carry newlines but no other control characters`, ceremony.id)
  }
  if (value.length > MAX_CEREMONY_PROSE) {
    return invalid('V4', `${field} is ${value.length} characters and the limit is ${MAX_CEREMONY_PROSE}, which is ${value.length - MAX_CEREMONY_PROSE} over`, ceremony.id)
  }
  return undefined
}

/** The field dictionary of a retrospective. Every rule is `V4`; there is no date field to fail `I1`. */
export function validateCeremony(ceremony: Ceremony): Result<Ceremony> {
  const { id } = ceremony
  if (typeof id !== 'string' || !SLUG.test(id)) {
    return invalid('V4', 'id must be a slug of 3 to 64 lowercase letters, digits and hyphens', undefined)
  }
  if (typeof ceremony.title !== 'string' || ceremony.title.length === 0 || ceremony.title.length > 200
    || !isSafeText(ceremony.title, 'line') || ceremony.title.trim() !== ceremony.title) {
    return invalid('V4', 'title must be a single line of 1 to 200 characters with no control or bidi override characters', id)
  }
  if (!(CEREMONY_STATES as readonly string[]).includes(ceremony.state)) {
    return invalid('V4', `state must be one of ${CEREMONY_STATES.join(', ')}`, id)
  }
  if (!isInstant(ceremony.filed_at)) return invalid('V4', 'filed_at must be an RFC 3339 instant in UTC', id)
  if (!Number.isInteger(ceremony.version) || ceremony.version < 1) {
    return invalid('V4', 'version must be a whole number of 1 or more', id)
  }
  if (ceremony.sprint_id !== undefined && !SLUG.test(ceremony.sprint_id)) {
    return invalid('V4', `sprint_id must be a sprint id; ${String(ceremony.sprint_id)} is not one`, id)
  }
  const { actions } = ceremony
  if (actions !== undefined) {
    // An empty list would render as an empty field value, which the grammar refuses, so the
    // absence of the field is the only way to say "this retrospective produced no action".
    if (actions.length === 0) return invalid('V4', 'actions is empty; a retrospective that produced no action carries no actions field', id)
    if (actions.length > MAX_CEREMONY_ACTIONS) {
      return invalid('V4', `actions names ${actions.length} items and the limit is ${MAX_CEREMONY_ACTIONS}`, id)
    }
    for (const action of actions) {
      if (typeof action !== 'string' || !SLUG.test(action)) {
        return invalid('V4', `actions must be a list of item ids; ${String(action)} is not one`, id)
      }
    }
    if (new Set(actions).size !== actions.length) return invalid('V4', 'actions names an item twice', id)
    if (actions.includes(id)) return invalid('V4', `actions names ${id}, which is this record`, id)
  }
  for (const field of ['well', 'badly'] as const) {
    const bad = prose(ceremony, field)
    if (bad !== undefined) return bad
  }
  if (ceremony.extra !== undefined) {
    const keys = validateFieldKeys(ceremony.extra)
    if (!keys.ok) return keys
  }
  return ok(ceremony)
}
