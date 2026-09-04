// SPDX-License-Identifier: Apache-2.0
// The field dictionary and the per-type required-field policy (domain model 2.1, 2.14).
// Creation-time rules live here; readiness and doneness rules live in gates.ts, because
// the model's own design is that the gate is what makes a type's fields bite.

import { fail, ok, type Failure, type Result } from './errors.ts'
import { validateFieldKeys } from './record.ts'
import { isSafeText } from './text.ts'
import {
  BUG_SEVERITIES,
  DEFAULT_POINT_SCALE,
  FOUND_IN_STAGES,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
  type Instant,
  type WorkItem,
  type WorkItemType,
} from './types.ts'

export const COMMON_FIELDS = [
  'id', 'type', 'state', 'title', 'filed_at', 'version',
  'description', 'priority', 'points', 'hours_estimate', 'parent_id',
  'assignee', 'reporter', 'reviewer', 'component', 'labels', 'sprint_id',
  'hold_reason', 'hold_until', 'held_from', 'extra',
] as const

const TYPE_FIELDS: Readonly<Record<WorkItemType, readonly string[]>> = {
  epic: ['outcome', 'target_date'],
  story: ['acceptance_criteria'],
  task: [],
  bug: ['severity', 'repro_steps', 'expected', 'actual', 'found_in', 'fix_confirmed'],
  spike: ['question', 'timebox_hours', 'findings'],
  chore: [],
}

const REQUIRED_AT_CREATION: Readonly<Record<WorkItemType, readonly string[]>> = {
  epic: ['outcome'],
  story: [],
  task: [],
  bug: ['severity', 'repro_steps', 'found_in'],
  spike: ['question', 'timebox_hours'],
  chore: [],
}

/** The fields a creation refuses to go without, per type (2.1). */
export function requiredAtCreation(type: WorkItemType): readonly string[] {
  return REQUIRED_AT_CREATION[type]
}

/** Every field name this type may carry: the common set plus its own. */
export function fieldsOf(type: WorkItemType): readonly string[] {
  return [...COMMON_FIELDS, ...TYPE_FIELDS[type]]
}

export function isKnownField(name: string): boolean {
  return (COMMON_FIELDS as readonly string[]).includes(name)
    || WORK_ITEM_TYPES.some((t) => TYPE_FIELDS[t].includes(name))
}

// Both patterns are bounded and linear: one character class per position, no nested
// quantifier, so neither can backtrack (threat model F8's ReDoS discipline).
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

// DR3 rule 7, widened to the whole class by finding F5. text.ts owns the class so the
// store boundary and this validator cannot drift; a single-line value additionally carries
// no newline and no tab, which `line` mode is.

function isSingleLine(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max
    && isSafeText(value, 'line')
    && value.trim() === value
}

function isText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && isSafeText(value, 'text')
}

function isBoundedInt(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

export function isInstant(value: unknown): value is Instant {
  return typeof value === 'string' && INSTANT.test(value)
}

export type ValidateOptions = {
  readonly now: Instant
  /** The workspace's estimation scale; defaults to the model's 1,2,3,5,8,13. */
  readonly pointScale?: readonly number[]
}

type Check = (value: unknown, item: WorkItem, options: ValidateOptions) => string | undefined

const oneOf = (name: string, allowed: readonly string[]): Check => (value) =>
  typeof value === 'string' && allowed.includes(value)
    ? undefined
    : `${name} must be one of ${allowed.join(', ')}`

const line = (name: string, max: number): Check => (value) =>
  typeof value === 'string' && isSingleLine(value, max)
    ? undefined
    : `${name} must be a single line of 1 to ${max} characters with no control or bidi override characters`

const text = (name: string, max: number): Check => (value) =>
  typeof value === 'string' && isText(value, max)
    ? undefined
    : `${name} must be 1 to ${max} characters and may carry newlines and tabs but no other control characters`

const int = (name: string, min: number, max: number): Check => (value) =>
  isBoundedInt(value, min, max) ? undefined : `${name} must be a whole number from ${min} to ${max}`

const slug = (name: string): Check => (value) =>
  typeof value === 'string' && SLUG.test(value)
    ? undefined
    : `${name} must be a slug of 3 to 64 lowercase letters, digits and hyphens`

const instant = (name: string): Check => (value) =>
  isInstant(value) ? undefined : `${name} must be an RFC 3339 instant in UTC, such as 2026-09-05T12:00:00Z`

const CHECKS: Readonly<Record<string, Check>> = {
  id: slug('id'),
  type: oneOf('type', WORK_ITEM_TYPES),
  state: oneOf('state', WORK_ITEM_STATES),
  title: line('title', 200),
  filed_at: instant('filed_at'),
  version: (value) => (isBoundedInt(value, 1, Number.MAX_SAFE_INTEGER) ? undefined : 'version must be a whole number of 1 or more'),

  description: text('description', 100_000),
  priority: int('priority', 1, 5),
  points: (value, _item, options) => {
    const scale = options.pointScale ?? DEFAULT_POINT_SCALE
    return typeof value === 'number' && scale.includes(value)
      ? undefined
      : `points must be one of the workspace scale ${scale.join(', ')}`
  },
  hours_estimate: int('hours_estimate', 1, 400),
  parent_id: slug('parent_id'),
  assignee: line('assignee', 200),
  reporter: line('reporter', 200),
  reviewer: line('reviewer', 200),
  component: line('component', 200),
  sprint_id: slug('sprint_id'),
  labels: (value) => {
    if (!Array.isArray(value)) return 'labels must be a list of slugs'
    const labels = value as readonly unknown[]
    for (const label of labels) {
      if (typeof label !== 'string' || !SLUG.test(label)) {
        return `labels must be slugs; ${String(label)} is not one`
      }
    }
    return new Set(labels).size === labels.length ? undefined : 'labels must be unique within one item'
  },

  hold_reason: line('hold_reason', 500),
  hold_until: (value, _item, options) => {
    if (!isInstant(value)) return 'hold_until must be an RFC 3339 instant in UTC'
    return value > options.now ? undefined : `hold_until ${value} is not in the future`
  },
  held_from: oneOf('held_from', ['draft', 'ready', 'in_progress', 'in_review']),
  extra: (value) => (value instanceof Map ? undefined : 'extra must be a Map of unknown field keys to their verbatim values'),

  outcome: text('outcome', 1000),
  target_date: instant('target_date'),
  acceptance_criteria: (value) => {
    if (!Array.isArray(value)) return 'acceptance_criteria must be a list'
    for (const entry of value as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) return 'each acceptance criterion is a text and a tick'
      const criterion = entry as { text?: unknown; ticked?: unknown }
      if (typeof criterion.text !== 'string' || !isText(criterion.text, 500)) {
        return 'each acceptance criterion needs text of 1 to 500 characters'
      }
      if (typeof criterion.ticked !== 'boolean') return 'each acceptance criterion needs a boolean tick'
    }
    return undefined
  },
  severity: oneOf('severity', BUG_SEVERITIES),
  repro_steps: text('repro_steps', 5000),
  expected: text('expected', 2000),
  actual: text('actual', 2000),
  found_in: oneOf('found_in', FOUND_IN_STAGES),
  fix_confirmed: (value) => (typeof value === 'boolean' ? undefined : 'fix_confirmed must be true or false'),
  question: text('question', 1000),
  timebox_hours: int('timebox_hours', 1, 80),
  findings: text('findings', 10_000),
}

const HOLD_FIELDS = ['hold_reason', 'hold_until', 'held_from'] as const

function invalid(rule: string, message: string, item: { id?: unknown }): Failure {
  return fail('VALIDATION', rule, message, typeof item.id === 'string' ? [item.id] : [])
}

/**
 * Validates one work item against the field dictionary and its type's creation policy.
 * The instant is an argument rather than a clock read, which is what keeps this layer pure.
 */
export function validateWorkItem(item: WorkItem, options: ValidateOptions): Result<WorkItem> {
  const typeFailure = CHECKS['type']?.(item.type, item, options)
  if (typeFailure !== undefined) return invalid('V4', typeFailure, item)

  const permitted = new Set(fieldsOf(item.type))
  const present = Object.entries(item).filter(([, value]) => value !== undefined)

  for (const [name] of present) {
    if (!permitted.has(name)) {
      return invalid(
        'V5',
        isKnownField(name)
          ? `${name} is not a field of a ${item.type}`
          : `${name} is not a field of any work item`,
        item,
      )
    }
  }

  for (const name of ['id', 'state', 'title', 'filed_at', 'version']) {
    if (item[name as keyof WorkItem] === undefined) {
      return invalid('V4', `a work item needs ${name}`, item)
    }
  }

  for (const name of requiredAtCreation(item.type)) {
    if (item[name as keyof WorkItem] === undefined) {
      return invalid('V4', `a ${item.type} needs ${name} at creation`, item)
    }
  }

  for (const [name, value] of present) {
    const why = CHECKS[name]?.(value, item, options)
    if (why !== undefined) return invalid('V4', why, item)
  }

  if (item.state === 'on_hold') {
    for (const name of ['hold_reason', 'held_from'] as const) {
      if (item[name] === undefined) return invalid('V4', `an item on hold needs ${name}`, item)
    }
  } else {
    for (const name of HOLD_FIELDS) {
      if (item[name] !== undefined) {
        return invalid('V4', `${name} is set on an item whose state is ${item.state}, not on_hold`, item)
      }
    }
  }

  if (item.extra !== undefined) {
    const keys = validateFieldKeys(item.extra)
    if (!keys.ok) return keys
  }

  return ok(item)
}
