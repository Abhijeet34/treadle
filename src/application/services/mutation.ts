// SPDX-License-Identifier: Apache-2.0
// The three things every mutating use case shares: the event it appends, the field diff it
// reports, and the mode it runs in.
//
// A mutation reports what changed rather than what was asked (A.5), so the diff is computed
// against the stored item and a field that was already correct produces no line and does not
// count. `dry-run` and `preview` are modes rather than flags read here: the caller hands in
// an overlay store for a dry run, so a guard that would refuse the real write refuses this
// one, and nothing in this file knows which store it holds.

import type { WorkItem } from '../../domain/index.ts'
import type { Store, StoreEvent } from '../ports/store.ts'

/** `apply` writes, `dry-run` evaluates every guard and writes nothing, `preview` evaluates nothing. */
export type Mode = 'apply' | 'dry-run' | 'preview'

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
    cmd: input.command,
    txn: input.txn,
  }
}

export type FieldChange = {
  readonly field: string
  readonly before: string
  readonly after: string
}

function render(value: unknown): string {
  if (value === undefined || value === null) return '-'
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.map(render).join(',')
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
