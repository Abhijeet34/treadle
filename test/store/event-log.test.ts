// SPDX-License-Identifier: Apache-2.0
// The event log's own contract: a canonical line whoever writes it, a bad line that costs
// only itself, a tail read that does not re-read the file, and the journal that makes a
// multi-file transaction all-or-nothing.

import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { parseEventLine, renderEvent, scanEventFile } from '../../src/adapters/store/index.ts'
import { Gen, aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'
import type { StoreEvent } from '../../src/application/ports/store.ts'

const EVENTS = 600

describe('an event line is canonical in both directions', () => {
  it('renders the keys in the order DR3 fixes, with no whitespace', () => {
    const line = renderEvent(anEvent({ before: { state: 'draft' }, after: { state: 'ready' }, cmd: 'transition' }))
    assert.equal(
      line,
      '{"id":"ev-1","at":"2026-09-01T10:00:00Z","actor":"abhijeet","actor_kind":"person",'
      + '"entity_kind":"work_item","entity":"item-one","op":"file","before":{"state":"draft"},'
      + '"after":{"state":"ready"},"cmd":"transition","txn":"txn-1"}\n',
    )
  })

  it(`round-trips ${EVENTS} generated events byte for byte`, () => {
    for (let seed = 1; seed <= EVENTS; seed += 1) {
      const gen = new Gen(seed + 300_000)
      const event: StoreEvent = {
        id: gen.slug(), at: gen.instant(), actor: gen.safeLine(1, 20), actor_kind: gen.pick(['person', 'agent']),
        entity_kind: 'work_item', entity: gen.slug(), op: gen.pick(['file', 'transition', 'link']),
        txn: gen.slug(),
        ...(gen.chance(0.6) ? { before: { state: gen.safeLine(1, 12) } } : {}),
        ...(gen.chance(0.6) ? { after: { state: gen.safeLine(1, 12), points: gen.int(1, 13) } } : {}),
        ...(gen.chance(0.3) ? { cmd: gen.safeLine(1, 30) } : {}),
      }
      const line = renderEvent(event)
      const parsed = parseEventLine(line.trimEnd(), 'events/2026-09.jsonl', seed)
      assert.ok(parsed.ok, `seed ${seed}: ${parsed.ok ? '' : parsed.error.message}`)
      assert.equal(renderEvent(parsed.value), line, `seed ${seed} is not a fixed point`)
    }
  })

  it('refuses a line missing a required field, naming the field', () => {
    const parsed = parseEventLine('{"id":"ev-1","at":"2026-09-01T10:00:00Z"}', 'events/2026-09.jsonl', 4)
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.error.message, /line 4: actor must be a non-empty single-line string/)
  })
})

describe('one bad line costs only itself', () => {
  it('keeps every parseable line and reports the rest by line number', async () => {
    const workspace = await aWorkspace()
    try {
      const log = path.join(workspace.root, 'events/2026-09.jsonl')
      await writeFile(log, `${renderEvent(anEvent())}not json at all\n${renderEvent(anEvent({ id: 'ev-3' }))}`)
      const scan = await scanEventFile(log, 'events/2026-09.jsonl')
      assert.ok(scan.ok)
      assert.deepEqual(scan.value.events.map((e) => e.id), ['ev-1', 'ev-3'])
      assert.equal(scan.value.findings.length, 1)
      assert.equal(scan.value.findings[0]?.line, 2)
    } finally {
      await workspace.dispose()
    }
  })

  it('reads only the tail when asked for one', async () => {
    const workspace = await aWorkspace()
    try {
      const log = path.join(workspace.root, 'events/2026-09.jsonl')
      const first = renderEvent(anEvent())
      await writeFile(log, `${first}${renderEvent(anEvent({ id: 'ev-2' }))}`)
      const scan = await scanEventFile(log, 'events/2026-09.jsonl', Buffer.byteLength(first), 1)
      assert.ok(scan.ok)
      assert.deepEqual(scan.value.events.map((e) => e.id), ['ev-2'])
    } finally {
      await workspace.dispose()
    }
  })
})

describe('the transaction journal makes a multi-file write all-or-nothing', () => {
  it('re-applies a journal the previous holder left behind, exactly once', async () => {
    const workspace = await aWorkspace()
    try {
      const journalDir = path.join(workspace.root, '.index/txn')
      await mkdir(journalDir, { recursive: true })
      const event = anEvent({ id: 'ev-recovered' })
      await writeFile(path.join(journalDir, 'txn-crashed.json'), JSON.stringify({
        txn: 'txn-crashed',
        files: [{
          path: 'items/2026-09.md',
          content: 'schema: 1\n\n# item-crashed: Recovered\n\ntype: task\nstate: draft\nfiled_at: 2026-09-01T10:00:00Z\nversion: 1\n\n',
        }],
        events: [{ path: 'events/2026-09.jsonl', lines: [renderEvent(event)], ids: [event.id] }],
      }))

      // The next lock holder replays it before doing its own work.
      await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem({ id: 'item-later', filed_at: '2026-10-01T10:00:00Z' }) }],
        events: [],
      })

      const recovered = await workspace.store.get('item-crashed')
      assert.equal(recovered.ok && recovered.value?.title, 'Recovered')
      const events = await workspace.store.events()
      assert.deepEqual(events.ok ? events.value.map((e) => e.id) : [], ['ev-recovered'])

      // A second transaction must not replay it again, and the log must not grow.
      await workspace.store.apply({
        txn: 't2',
        writes: [{ item: anItem({ id: 'item-third', filed_at: '2026-11-01T10:00:00Z' }) }],
        events: [],
      })
      const log = await readFile(path.join(workspace.root, 'events/2026-09.jsonl'), 'utf8')
      assert.equal(log.split('\n').filter((l) => l.length > 0).length, 1)
    } finally {
      await workspace.dispose()
    }
  })

  it('leaves no journal behind after a transaction that completed', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [anEvent()] })
      await assert.rejects(() => readFile(path.join(workspace.root, '.index/txn/t1.json'), 'utf8'))
    } finally {
      await workspace.dispose()
    }
  })
})
