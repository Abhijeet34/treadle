// SPDX-License-Identifier: Apache-2.0
// The lock's heartbeat is a timer on the writer's event loop, so a transaction whose
// records are encoded in one synchronous stretch cannot beat until the stretch ends. The
// bench's 50,000-item generator commits 2,144 records in one transaction, and under a
// 1-minute load of 134 that stretch ran 10.3 s without a beat: past the 5 s stale window,
// so the writer judged its own lock lost and refused while nothing else wanted it. Every
// product command writes one record and holds the lock under a second at that load, so this
// is the multi-record path alone, held here by the same timer the heartbeat runs on: a tick
// that cannot fire is a beat that cannot fire.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

const RECORDS = 1_500
const TICK_MS = 20

describe('a transaction of many records', () => {
  it('lets a timer fire between records, so the heartbeat is never starved by the record loop', async (t) => {
    const workspace = await aWorkspace()
    try {
      const writes = Array.from({ length: RECORDS }, (_, at) => ({
        item: anItem({ id: `bulk-${String(at).padStart(5, '0')}`, title: `Bulk record ${at}` }),
      }))

      let ticks = 0
      let lastTick = Date.now()
      let longestGapMs = 0
      const tick = setInterval(() => {
        const now = Date.now()
        longestGapMs = Math.max(longestGapMs, now - lastTick)
        lastTick = now
        ticks += 1
      }, TICK_MS)
      const started = Date.now()
      const applied = await workspace.store.apply({ txn: 'bulk', writes, events: [] })
      const wallMs = Date.now() - started
      clearInterval(tick)
      assert.ok(applied.ok, JSON.stringify(applied))
      assert.equal(applied.value.writes.length, RECORDS)

      t.diagnostic(`${RECORDS} records in ${wallMs} ms: ${ticks} ticks of ${TICK_MS} ms, longest gap ${longestGapMs} ms`)
      // Judged as a share of the apply's own wall time so a busy machine stretches both sides
      // alike. Before the yield the record loop was one stretch of 333 ms of a 343 ms apply; with
      // it the longest was 21 ms, one record's encode plus the shard render.
      assert.ok(
        longestGapMs < wallMs / 4,
        `the longest stretch without a tick was ${longestGapMs} ms of a ${wallMs} ms apply: the heartbeat could not fire for it`,
      )
    } finally {
      await workspace.dispose()
    }
  })
})
