// SPDX-License-Identifier: Apache-2.0
// `doctor` read the whole event log once per item, which is O(items x events) and is the
// one place in this tree where the cost of an answer grew with the product of two corpora
// rather than with their sum. Measured on the bench corpora before the fix: 375 ms at 100
// items and 1,000 events, 1,338 ms at 1,000 and 10,000, 273,554 ms at 10,000 and 100,000,
// and no answer at all inside ten minutes at 50,000 and 500,000. After it: 272, 342, 991
// and 4,438 ms, with the finding list byte-identical at all three scales that had one.
//
// The property is asserted as passes over the log rather than as a wall time, because a wall
// time on a shared machine is a fact about the machine. A log that counts how many times it
// was iterated makes the shape observable and the assertion deterministic.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { auditItem, auditWorkspace } from '../../src/application/services/doctor.ts'
import type { WorkspaceView } from '../../src/application/services/context.ts'
import type { StoreEvent } from '../../src/application/ports/store.ts'
import { emptyRelationGraph, hierarchyFrom, type WorkItem } from '../../src/domain/index.ts'

const ITEMS = 50
const EVENTS_PER_ITEM = 8

function anItem(index: number): WorkItem {
  return {
    id: `wi-${String(index).padStart(4, '0')}`,
    type: 'bug',
    state: 'in_progress',
    title: `bug ${index}`,
    filed_at: '2026-09-01T09:00:00Z',
    version: 1,
    assignee: 'ada',
    // The record says S3 and the log below last recorded S1, which is finding H20: every
    // item carries one, so the comparison covers a populated answer rather than an empty one.
    severity: 'S3',
  } as WorkItem
}

function aLog(items: readonly WorkItem[]): readonly StoreEvent[] {
  const events: StoreEvent[] = []
  for (const item of items) {
    for (let n = 0; n < EVENTS_PER_ITEM; n += 1) {
      events.push({
        id: `ev-${item.id}-${n}`,
        at: '2026-09-01T09:00:00Z',
        actor: 'ada',
        actor_kind: 'human',
        entity_kind: 'work_item',
        entity: item.id,
        op: n === 0 ? 'item.mark' : 'item.set',
        after: n === 0 ? { severity: 'S1' } : { title: item.title },
        txn: `txn-${item.id}-${n}`,
      } as unknown as StoreEvent)
    }
  }
  return events
}

function aView(items: readonly WorkItem[]): WorkspaceView {
  return {
    identity: { id: 'ws', name: 'ws', schema: 1 } as WorkspaceView['identity'],
    items,
    byId: new Map(items.map((item) => [item.id, item])),
    hierarchy: hierarchyFrom(items),
    relations: emptyRelationGraph(),
  }
}

/** The same events, over an array that records how many times something iterated it. */
function countingLog(events: readonly StoreEvent[]): { log: readonly StoreEvent[]; passes: () => number } {
  const log = [...events]
  let passes = 0
  Object.defineProperty(log, Symbol.iterator, {
    value: function* (this: readonly StoreEvent[]) {
      passes += 1
      yield* Array.prototype.values.call(this) as Iterable<StoreEvent>
    },
  })
  return { log, passes: () => passes }
}

describe('doctor audits a workspace in one pass over the log', () => {
  const items = Array.from({ length: ITEMS }, (_, index) => anItem(index))
  const events = aLog(items)
  const view = aView(items)

  it('walks the whole log a bounded number of times, not once per item', () => {
    const { log, passes } = countingLog(events)
    auditWorkspace(view, log)
    // One pass builds the buckets. Anything that grows with the item count is the shape this
    // test exists to refuse: the version before the fix made three passes per item, 150 here.
    assert.ok(passes() <= 2, `auditWorkspace walked the whole log ${passes()} times over ${ITEMS} items`)
  })

  it('returns exactly what auditing each item against the whole log returns', () => {
    const bucketed = auditWorkspace(view, events)
    const whole = items.flatMap((item) => auditItem(item, events))
    assert.deepEqual(bucketed, whole)
    assert.ok(bucketed.length > 0, 'the fixture produced no findings, so the comparison proved nothing')
  })
})
