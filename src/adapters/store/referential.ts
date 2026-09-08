// SPDX-License-Identifier: Apache-2.0
// The two refusals of the referential rule (ADR-0025), in one place because both store
// implementations raise them and a caller reads the sentence rather than the rule id.
//
// The rule itself is not here. Each store answers "does any record still name this id"
// against what it has - the sharded store against two index lookups under its write lock,
// the overlay against the arrays it already merges - and only the wording is shared, which
// is the half that would otherwise drift between them.

import { storeFail, type StoreResult } from '../../application/ports/store.ts'

/** One record that would be left naming a removed id, as the four ways one record holds another's. */
export type Referrer =
  | { readonly kind: 'parent'; readonly id: string }
  | { readonly kind: 'relation'; readonly id: string; readonly relation: string }
  | { readonly kind: 'sprint'; readonly id: string }
  | { readonly kind: 'ceremony'; readonly id: string }

function clauseOf(id: string, by: Referrer): string {
  if (by.kind === 'parent') return `${by.id} has ${id} as its parent`
  if (by.kind === 'relation') return `${by.id} ${by.relation} ${id}`
  // A retrospective's action list is the one place the retro-to-chore link is stored, so a
  // chore removed out from under it leaves the record naming nothing and the retrospective
  // unable to say what it produced. The frozen sprint's clause reads the same way.
  if (by.kind === 'ceremony') return `${by.id} names ${id} in its action list`
  return `${by.id} is closed and counts ${id} in its committed set`
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

/**
 * A retrospective naming an action the store does not hold, which is `parentMissing`'s shape
 * for the fourth referrer. `ceremony retro` files the record and its chores in one
 * transaction, so an action id that neither the transaction writes nor the store holds is a
 * record written already naming nothing, and this is the write that introduces it.
 */
export function actionMissing(action: string, ceremony: string): StoreResult<never> {
  return storeFail(
    'CONFLICT', 'S10',
    `${action} is not in the store, so ${ceremony} cannot name it in its action list; retry so the decision reads what is there now`,
    [action, ceremony],
  )
}

/**
 * A ceremony write under an id another record kind already holds. The three kinds share one
 * namespace because the event log is keyed by entity id alone, so two records under one id
 * would share their trail and every read that resolves an id would pick by lookup order.
 * `file` and `sprint open` state the rule from their side; this is the store's, and it is
 * what stops a ceremony write introducing the collision from the one side that can.
 */
export function idTaken(id: string, byKind: string): StoreResult<never> {
  return storeFail(
    'CONFLICT', 'S3',
    `${id} is already ${byKind} in this store, and an id names one thing; a ceremony cannot be written under it`,
    [id],
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
