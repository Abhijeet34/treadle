// SPDX-License-Identifier: Apache-2.0
// The three things every mutating use case shares: the event it appends, the field diff it
// reports, and the mode it runs in.
//
// A mutation reports what changed rather than what was asked (A.5), so the diff is computed
// against the stored item and a field that was already correct produces no line and does not
// count. `dry-run` is a mode rather than a flag read here: the caller hands in an overlay
// store for a dry run, so a guard that would refuse the real write refuses this one, and
// nothing in this file knows which store it holds.

import { isSafeText, type WorkItem } from '../../domain/index.ts'
import type { Store, StoreEvent } from '../ports/store.ts'

/** `apply` writes; `dry-run` evaluates every guard and writes nothing. */
export type Mode = 'apply' | 'dry-run'

/**
 * A store and the mode it is in, paired. A mutating use case takes one of these rather than
 * a store and a mode separately, because the two must agree: a `dry-run` whose store is the
 * real one writes, and nothing at the call site would say so. `targetFor` in the adapters
 * layer is the only thing that builds one, so the pairing is made once.
 */
export type Target = {
  readonly store: Store
  readonly mode: Mode
}

export type Actor = {
  readonly id: string
  readonly kind: 'human' | 'agent'
}

/** The bound the three identity fields of the dictionary already carry. */
const MAX_ACTOR = 200

/** What a refusal will echo of a wrong actor kind. The two right answers are six characters. */
const MAX_ACTOR_KIND_ECHO = 40

/**
 * Why an actor cannot be recorded, or `undefined`. The value comes from a flag or from the
 * environment and is written verbatim into a committed event log, so it is held to the same
 * class as `assignee`: one line, no control or bidi override characters, bounded.
 */
export function actorRefusal(actor: Actor): string | undefined {
  if (actor.id.length === 0 || actor.id.trim() !== actor.id) {
    return 'an actor must be a name with no leading or trailing whitespace'
  }
  if (actor.id.length > MAX_ACTOR) {
    return `an actor is ${actor.id.length} characters and the limit is ${MAX_ACTOR}, which is ${actor.id.length - MAX_ACTOR} over`
  }
  return isSafeText(actor.id, 'line')
    ? undefined
    : 'an actor must be a single line with no control or bidi override characters'
}

/**
 * Why an actor kind cannot be recorded, or `undefined`. `help` says
 * `TREADLING_ACTOR_KIND=human|agent`, and every other value was silently recorded as `human`:
 * `robot` and `AGENT` both landed there, so the field the purpose statement's "user-agent
 * interactions" is read from carried a value nobody wrote. It is the same class as an actor
 * with a control character in it, and it is refused the same way, on mutations only, because
 * that is where the kind reaches the log.
 */
export function actorKindRefusal(kind: string | undefined): string | undefined {
  if (kind === undefined || kind === 'human' || kind === 'agent') return undefined
  // The token is named because that is what makes a refusal actionable, and it is bounded and
  // held to the line class first: it comes from the environment, so it is as unbounded and as
  // unsafe as an actor's own name, which this file has always checked before printing it back.
  const named = kind.length <= MAX_ACTOR_KIND_ECHO && isSafeText(kind, 'line')
    ? `"${kind}"`
    : `${kind.length} characters`
  return `TREADLING_ACTOR_KIND is ${named}, and an actor kind is human or agent`
}

export type EventInput = {
  readonly id: string
  readonly at: string
  readonly actor: Actor
  readonly entity: string
  readonly entityKind?: string
  readonly op: string
  readonly txn: string
  readonly command: string
  readonly before?: unknown
  readonly after?: unknown
  readonly guards?: unknown
  readonly reason?: string
  readonly outcome?: string
}

export function makeEvent(input: EventInput): StoreEvent {
  return {
    id: input.id,
    at: input.at,
    actor: input.actor.id,
    actor_kind: input.actor.kind,
    entity_kind: input.entityKind ?? 'item',
    entity: input.entity,
    op: input.op,
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.guards === undefined ? {} : { guards: input.guards }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    cmd: input.command,
    txn: input.txn,
  }
}

/**
 * The fields a mutation event records before and after. It is `file`'s `REPORTED` set less
 * its six free-text fields: an event line is read by a machine and diffed by a person, and a
 * 5,000-character repro step in it duplicates the record it was copied from. Everything a
 * caller can be held to - the marker fields, the ownership, the date - is here, which is
 * what makes a hand edit of severity or priority detectable against the log.
 */
export const AUDITED_FIELDS = [
  'type', 'state', 'filed_at', 'priority', 'parent_id',
  'assignee', 'reviewer', 'labels', 'due',
  'severity', 'found_in', 'fix_confirmed',
] as const

/** The change list as an event's `before` or `after` object, keyed by field. */
export function snapshotOf(changes: readonly FieldChange[], side: 'before' | 'after'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const change of changes) out[change.field] = change[side]
  return out
}

/**
 * The same snapshot for a change list that may carry prose. A field in AUDITED_FIELDS is
 * recorded verbatim; anything else is recorded as its length, because a 10,000-character
 * description in the log duplicates the record it was copied from while the log still has to
 * say the field moved and by how much.
 */
export function auditedSnapshot(changes: readonly FieldChange[], side: 'before' | 'after'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const change of changes) {
    const value = change[side]
    out[change.field] = (AUDITED_FIELDS as readonly string[]).includes(change.field) || value === '-'
      ? value
      : `${value.length} chars`
  }
  return out
}

export type FieldChange = {
  readonly field: string
  readonly before: string
  readonly after: string
}

/**
 * An acceptance criterion, structurally. The list is the one stored value whose entries are
 * objects rather than scalars, and `String(criterion)` rendered every one of them as
 * `[object Object]`: two different checklists compared equal, so `set` reported `already` and
 * a criterion could never be ticked. The tick syntax below is the one `--set` itself takes,
 * so what a mutation echoes is what a caller would type to reproduce it.
 */
function isCriterion(value: unknown): value is { readonly text: string; readonly ticked: boolean } {
  return typeof value === 'object' && value !== null
    && typeof (value as { text?: unknown }).text === 'string'
    && typeof (value as { ticked?: unknown }).ticked === 'boolean'
}

function render(value: unknown): string {
  if (value === undefined || value === null) return '-'
  if (Array.isArray(value)) {
    if (value.length === 0) return '-'
    return value.every(isCriterion)
      ? value.map((criterion) => `[${criterion.ticked ? 'x' : ' '}] ${criterion.text}`).join('|')
      : value.map(render).join(',')
  }
  return String(value)
}

/**
 * Fields that differ between the stored item and the one about to be written, in the field
 * dictionary's order so two runs of the same change print the same lines.
 */
export function diffOf(before: WorkItem | undefined, after: WorkItem, fields: readonly string[]): readonly FieldChange[] {
  const from = before as unknown as Record<string, unknown> | undefined
  const to = after as unknown as Record<string, unknown>
  const changes: FieldChange[] = []
  for (const field of fields) {
    const was = render(from?.[field])
    const now = render(to[field])
    if (was !== now) changes.push({ field, before: was, after: now })
  }
  return changes
}
