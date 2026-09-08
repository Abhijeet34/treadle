// SPDX-License-Identifier: Apache-2.0
// A record removed and filed again under its own id, which is the only migration the tool
// offers for a field no command writes: `type` has no writer, so folding one type into
// another means `remove` then `file`.
//
// Every step is accepted, and `doctor` then reported every event of the record that left as
// `H23`, "dated before the item was filed", for ever: the log is append-only, so nothing
// could clear the findings. The events belonged to the record that left, which is exactly
// what ADR-0024 says the log keeps, and the audit was comparing them with a record filed
// afterwards. Fixed clocks here rather than a sleep, because H23 compares instants.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { initWorkspace } from '../../src/adapters/workspace.ts'
import { doctor } from '../../src/application/services/doctor.ts'
import { fileItem } from '../../src/application/services/items.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { removeItem } from '../../src/application/services/removal.ts'
import type { Actor } from '../../src/application/services/mutation.ts'
import type { Store } from '../../src/application/ports/store.ts'

const ACTOR: Actor = { id: 'abhijeet', kind: 'human' }
const FILED = '2026-09-04T22:00:54Z'
const GROOMED = '2026-09-06T18:38:57Z'
const REMOVED = '2026-09-09T09:00:00Z'
const BETWEEN = '2026-09-09T09:30:00Z'
const REFILED = '2026-09-09T10:00:00Z'

type Rows = { readonly rows: readonly Record<string, string>[] }

describe('a record removed and filed again under its own id', () => {
  let parent: string
  let store: Store
  const ids = sequentialIds()

  before(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'treadle-refile-'))
    const root = path.join(parent, 'platform', '.work')
    await initWorkspace(fixedClock(FILED), ids, { at: root, name: 'platform', actor: ACTOR })
    const opened = await openWorkspace(root)
    assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
    store = opened.value
    const apply = targetFor(store, 'apply')
    const must = (result: { ok: boolean; data: Record<string, unknown> }, what: string) => {
      assert.equal(result.ok, true, `${what}: ${String(result.data['cause'])}`)
    }

    must(await fileItem(apply, fixedClock(FILED), ids, {
      type: 'spike', title: 'A bundled dist entry', id: 'packaging', fields: { question: 'which bundler' }, actor: ACTOR,
    }), 'file the original')
    must(await transition(apply, fixedClock(GROOMED), ids, { id: 'packaging', target: 'ready', actor: ACTOR }), 'groom')
    must(await removeItem(apply, fixedClock(REMOVED), ids, {
      id: 'packaging', reason: 'the type it was filed under is gone, and type has no writer', confirmed: true, actor: ACTOR,
    }), 'remove')
    must(await fileItem(apply, fixedClock(REFILED), ids, {
      type: 'task', title: 'A bundled dist entry', id: 'packaging', fields: {}, actor: ACTOR,
    }), 'refile')
  })

  after(async () => {
    await store.close()
    await rm(parent, { recursive: true, force: true })
  })

  it('leaves the store clean, rather than faulting every event the record that left earned', async () => {
    const audit = await doctor(store, fixedClock(REFILED))
    const findings = (audit.data['findings'] as Rows).rows
    assert.deepEqual(findings.filter((row) => row['rule'] === 'H23'), [],
      `H23 fired over a removal: ${JSON.stringify(findings)}`)
    assert.equal(audit.code, 'OK', JSON.stringify(audit.data))
  })

  // The rule still has to catch what it is for, and the removal moves where it starts rather
  // than switching it off: the store hands the log over sorted by instant, so a line
  // backdated past the removal cannot be told from a genuine event of the record that left,
  // and the audit says nothing about either. Everything after the removal is still decided.
  it('still reports an event dated after the removal and before this record was filed', async () => {
    const apply = targetFor(store, 'apply')
    const between = await transition(apply, fixedClock(BETWEEN), ids, { id: 'packaging', target: 'ready', actor: ACTOR })
    assert.equal(between.ok, true, JSON.stringify(between.data))

    const audit = await doctor(store, fixedClock(REFILED))
    const h23 = (audit.data['findings'] as Rows).rows.filter((row) => row['rule'] === 'H23')
    assert.equal(h23.length, 1, JSON.stringify(h23))
    assert.match(h23[0]?.['detail'] as string,
      /is dated 2026-09-09T09:30:00Z, before the item was filed at 2026-09-09T10:00:00Z/)
  })
})

describe('a record no removal ever touched', () => {
  let parent: string
  let store: Store
  const ids = sequentialIds()

  before(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'treadle-refile-plain-'))
    const root = path.join(parent, 'platform', '.work')
    await initWorkspace(fixedClock(REFILED), ids, { at: root, name: 'platform', actor: ACTOR })
    const opened = await openWorkspace(root)
    assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
    store = opened.value
    const apply = targetFor(store, 'apply')
    const filed = await fileItem(apply, fixedClock(REFILED), ids, {
      type: 'task', title: 'A bundled dist entry', id: 'packaging', fields: {}, actor: ACTOR,
    })
    assert.equal(filed.ok, true, JSON.stringify(filed.data))
    const back = await transition(apply, fixedClock(FILED), ids, { id: 'packaging', target: 'ready', actor: ACTOR })
    assert.equal(back.ok, true, JSON.stringify(back.data))
  })

  after(async () => {
    await store.close()
    await rm(parent, { recursive: true, force: true })
  })

  it('still reports an event dated before it was filed, which is what H23 is for', async () => {
    const audit = await doctor(store, fixedClock(REFILED))
    const h23 = (audit.data['findings'] as Rows).rows.filter((row) => row['rule'] === 'H23')
    assert.equal(h23.length, 1, JSON.stringify(h23))
    assert.match(h23[0]?.['detail'] as string,
      /is dated 2026-09-04T22:00:54Z, before the item was filed at 2026-09-09T10:00:00Z/)
  })
})
