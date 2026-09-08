// SPDX-License-Identifier: Apache-2.0
// The two refusals of the referential rule (ADR-0025), in one place because both store
// implementations raise them and a caller reads the sentence rather than the rule id.
//
// The rule itself is not here. Each store answers "does any record still name this id"
// against what it has - the sharded store against two index lookups under its write lock,
// the overlay against the arrays it already merges - and only the wording is shared, which
// is the half that would otherwise drift between them.

import { storeFail, type StoreResult } from '../../application/ports/store.ts'

/** One record that would be left naming a removed id, as the two ways one record holds another's. */
export type Referrer =
  | { readonly kind: 'parent'; readonly id: string }
  | { readonly kind: 'relation'; readonly id: string; readonly relation: string }

function clauseOf(id: string, by: Referrer): string {
  return by.kind === 'parent'
    ? `${by.id} has ${id} as its parent`
    : `${by.id} ${by.relation} ${id}`
}

/**
 * A removal that would leave `by` naming `id`. `CONFLICT` rather than `VALIDATION` because
 * the caller's decision is what is stale: the neighbour was written after the guards read
 * the store, and the same command run again against what is there now answers correctly.
 */
export function stillNamed(id: string, by: Referrer): StoreResult<never> {
  return storeFail(
    'CONFLICT', 'S17',
    `${clauseOf(id, by)}, written after this removal was decided; retry so the decision reads what is there now`,
    [id, by.id],
  )
}

/** A write naming a parent the store does not hold, which is the same defect in the other order. */
export function parentMissing(parent: string, child: string): StoreResult<never> {
  return storeFail(
    'CONFLICT', 'S10',
    `${parent} is not in the store, so ${child} cannot name it as its parent; retry so the decision reads what is there now`,
    [parent, child],
  )
}
