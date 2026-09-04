// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F8, no stated ceiling on file size, event count or graph depth.
// Every mutation reads its whole shard and a rebuild parses every event line, and the design
// measured those at benign sizes without capping them. A budget is not a cap.
//
// The oversized files here are sparse: `truncate` gives a file of the stated size that costs
// no disk, which is also exactly the shape of the attack, since a hostile repository states
// a size and the tool must refuse before it reads.

import assert from 'node:assert/strict'
import { truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  MAX_EVENTS_PER_FILE,
  MAX_EVENT_FILE_BYTES,
  MAX_EVENT_LINE_BYTES,
  MAX_FIELD_VALUE_BYTES,
  MAX_FILE_BYTES,
  MAX_RECORDS_PER_FILE,
  MAX_SECTION_BYTES,
  parseEventLine,
  parseFile,
  parseRecordSource,
  renderHeader,
  scanEventFile,
} from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

describe('a file bigger than its ceiling is a named refusal, not an out-of-memory crash', () => {
  it(`refuses a record shard over ${MAX_FILE_BYTES} bytes and keeps every other shard`, async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem({ id: 'item-one', filed_at: '2026-09-01T10:00:00Z' }) }],
        events: [],
      })
      const hostile = path.join(workspace.root, 'items/2026-10.md')
      await writeFile(hostile, renderHeader(1))
      await truncate(hostile, MAX_FILE_BYTES + 1)

      const items = await workspace.store.list()
      assert.deepEqual(items.ok ? items.value.map((i) => i.id) : [], ['item-one'])
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const refusal = findings.value.find((f) => f.rule === 'S4')
      assert.ok(refusal, 'expected an S4 ceiling refusal')
      assert.equal(refusal.file, 'items/2026-10.md')
      assert.match(refusal.reason, new RegExp(`over the ${MAX_FILE_BYTES} byte ceiling`))
    } finally {
      await workspace.dispose()
    }
  })

  it(`refuses an event log over ${MAX_EVENT_FILE_BYTES} bytes`, async () => {
    const workspace = await aWorkspace()
    try {
      const hostile = path.join(workspace.root, 'events/2026-09.jsonl')
      await writeFile(hostile, '')
      await truncate(hostile, MAX_EVENT_FILE_BYTES + 1)

      const events = await workspace.store.events()
      assert.deepEqual(events.ok ? events.value : [], [])
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.equal(findings.value.find((f) => f.rule === 'S6')?.file, 'events/2026-09.jsonl')
    } finally {
      await workspace.dispose()
    }
  })

  it(`refuses a file holding more than ${MAX_RECORDS_PER_FILE} records`, () => {
    let text = renderHeader(1)
    for (let i = 0; i <= MAX_RECORDS_PER_FILE; i += 1) text += `# item-${i}: T\n\nstate: draft\n\n`
    const parsed = parseFile(text, 'items/2026-09.md')
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.error.rule, 'S4')
    assert.equal(parsed.ok ? 0 : parsed.error.details?.['observed'], MAX_RECORDS_PER_FILE + 1)
  })

  it(`refuses a field value over ${MAX_FIELD_VALUE_BYTES} bytes`, () => {
    const parsed = parseRecordSource(`# alpha-one: T\n\nnote: ${'x'.repeat(MAX_FIELD_VALUE_BYTES + 1)}\n\n`, 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.rule, 'S5')
  })

  it(`refuses a section body over ${MAX_SECTION_BYTES} bytes`, () => {
    const parsed = parseRecordSource(`# alpha-one: T\n\nstate: draft\n\n## Description\n\n${'x'.repeat(MAX_SECTION_BYTES + 1)}\n\n`, 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.rule, 'S5')
  })

  it(`refuses one event line over ${MAX_EVENT_LINE_BYTES} bytes before parsing it`, () => {
    const parsed = parseEventLine('x'.repeat(MAX_EVENT_LINE_BYTES + 1), 'events/2026-09.jsonl', 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.error.rule, 'S7')
  })

  it(`refuses an unterminated line over ${MAX_EVENT_LINE_BYTES} bytes rather than buffering it`, async () => {
    const workspace = await aWorkspace()
    try {
      const log = path.join(workspace.root, 'events/2026-09.jsonl')
      await writeFile(log, 'x'.repeat(MAX_EVENT_LINE_BYTES + 1024))
      const scan = await scanEventFile(log, 'events/2026-09.jsonl')
      assert.equal(scan.ok, false)
      assert.equal(scan.ok ? '' : scan.error.rule, 'S7')
    } finally {
      await workspace.dispose()
    }
  })

  it(`refuses a log that would pass ${MAX_EVENTS_PER_FILE} events`, async () => {
    const workspace = await aWorkspace()
    try {
      const log = path.join(workspace.root, 'events/2026-09.jsonl')
      await writeFile(log, '{}\n{}\n')
      const scan = await scanEventFile(log, 'events/2026-09.jsonl', 0, MAX_EVENTS_PER_FILE - 1)
      assert.equal(scan.ok, false)
      assert.equal(scan.ok ? '' : scan.error.rule, 'S6')
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a hierarchy a hand edit made cyclic is reported, never recursed into', () => {
  it('names the cycle and still answers every other question', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [
          { item: anItem({ id: 'item-one', parent_id: 'item-two' }) },
          { item: anItem({ id: 'item-two', parent_id: 'item-tri' }) },
          { item: anItem({ id: 'item-tri', parent_id: 'item-one' }) },
        ],
        events: [],
      })
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const cycle = findings.value.find((f) => f.rule === 'S12')
      assert.ok(cycle, 'expected an S12 finding')
      assert.match(cycle.reason, /item-one -> |item-two -> |item-tri -> /)

      const items = await workspace.store.list()
      assert.equal(items.ok && items.value.length, 3)
    } finally {
      await workspace.dispose()
    }
  })
})
