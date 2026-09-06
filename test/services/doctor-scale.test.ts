// SPDX-License-Identifier: Apache-2.0
// `doctor` read the whole event log once per item, which is O(items x events) and is the
// one place in this tree where the cost of an answer grew with the product of two corpora
// rather than with their sum. Measured on the bench corpora before the fix: 375 ms at 100
// items and 1,000 events, 1,338 ms at 1,000 and 10,000, 273,554 ms at 10,000 and 100,000,
// and no answer at all inside ten minutes at 50,000 and 500,000. After it: 272, 342, 991
// and 4,438 ms, with the finding list byte-identical at all three scales that had one.
//
// It then held what it read: 50,000 decoded records and 500,000 decoded events at once,
// 1,043,456 KiB peak against a 102,400 KiB budget, to look at each once. The audit is now
// fed one record and one event at a time through the store's streaming reads, and the third
// test here holds that `doctor` never asks the store for the array forms.
//
// The property is asserted as passes over the log rather than as a wall time, because a wall
// time on a shared machine is a fact about the machine. A log that counts how many times it
// was iterated makes the shape observable and the assertion deterministic.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { WorkspaceAudit, auditItem, doctor } from '../../src/application/services/doctor.ts'
import type { Store, StoreEvent } from '../../src/application/ports/store.ts'
import type { WorkItem } from '../../src/domain/index.ts'
import { aWorkspace } from '../helpers/store-fixtures.ts'

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
    repro_steps: 'open it',
    found_in: 'dev',
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

const NO_SPRINTS: ReadonlySet<string> = new Set()

function auditWorkspace(items: readonly WorkItem[], events: readonly StoreEvent[]): readonly string[] {
  const audit = new WorkspaceAudit(NO_SPRINTS)
  for (const item of items) audit.record(item)
  for (const event of events) audit.event(event)
  return audit.findings().map((finding) => JSON.stringify(finding))
}

describe('doctor audits a workspace in one pass over the log', () => {
  const items = Array.from({ length: ITEMS }, (_, index) => anItem(index))
  const events = aLog(items)

  it('walks the whole log a bounded number of times, not once per item', () => {
    const { log, passes } = countingLog(events)
    auditWorkspace(items, log)
    // One pass folds the log into the audit. Anything that grows with the item count is the
    // shape this test exists to refuse: the version before the fix made three passes per
    // item, 150 here.
    assert.ok(passes() <= 2, `the audit walked the whole log ${passes()} times over ${ITEMS} items`)
  })

  it('returns exactly what auditing each item against the whole log returns', () => {
    const streamed = auditWorkspace(items, events)
    const whole = items.flatMap((item) => auditItem(item, events, NO_SPRINTS)).map((finding) => JSON.stringify(finding))
    assert.deepEqual(streamed, whole)
    assert.ok(streamed.length > 0, 'the fixture produced no findings, so the comparison proved nothing')
  })

  it('holds one record and one event at a time: doctor never asks the store for the arrays', async () => {
    const workspace = await aWorkspace()
    try {
      const base = workspace.store
      const written = await base.apply({ txn: 't1', writes: items.map((item) => ({ item })), events: [...events] })
      assert.ok(written.ok, written.ok ? '' : written.error.message)
      const calls = { list: 0, events: 0, eachItem: 0, eachEvent: 0 }
      const counting: Store = {
        ...base,
        identity: () => base.identity(),
        get: (id) => base.get(id),
        summaries: (query) => base.summaries(query),
        sprints: () => base.sprints(),
        findings: () => base.findings(),
        apply: (transaction) => base.apply(transaction),
        close: () => base.close(),
        list: (query) => { calls.list += 1; return base.list(query) },
        events: (query) => { calls.events += 1; return base.events(query) },
        eachItem: (query, visit) => { calls.eachItem += 1; return base.eachItem(query, visit) },
        eachEvent: (query, visit) => { calls.eachEvent += 1; return base.eachEvent(query, visit) },
      }
      const result = await doctor(counting)
      assert.equal(result.data['checked'], ITEMS)
      assert.equal((result.data['findings'] as { total: number }).total, ITEMS * 2, 'H20 and H19 once per item')
      assert.deepEqual(calls, { list: 0, events: 0, eachItem: 1, eachEvent: 1 })
    } finally {
      await workspace.dispose()
    }
  })
})
