// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F6, prototype pollution through the event log and the record field
// keys. The record key grammar is `[a-z_][a-z0-9_]*`, which `__proto__`, `constructor` and
// `prototype` all match, so a committed file or a git merge can hand the parser one as an
// ordinary-looking field name; an event's `before` and `after` are arbitrary JSON.
//
// The domain core already guards its own construction. This suite is the parse path: what
// the store builds out of bytes it read off disk.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { parseEventLine, parseRecordSource } from '../../src/adapters/store/index.ts'
import { MAX_JSON_DEPTH } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

const POLLUTED = 'polluted'

function prototypeIsClean(): boolean {
  return ({} as Record<string, unknown>)[POLLUTED] === undefined
}

describe('a record field key that names a prototype slot', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    it(`refuses ${key} on the parse path and leaves Object.prototype alone`, () => {
      assert.ok(prototypeIsClean(), 'the prototype was already polluted before the test ran')
      const parsed = parseRecordSource(`# alpha-one: Alpha\n\n${key}: ${POLLUTED}\n\n`, 1)
      assert.equal(parsed.ok, false)
      assert.equal(parsed.ok ? '' : parsed.rule, 'V2')
      assert.match(parsed.ok ? '' : parsed.reason, /prototype slot/)
      assert.ok(prototypeIsClean())
    })
  }

  it('quarantines the record in a committed file and keeps serving the others', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [
          { item: anItem({ id: 'item-one' }) },
          { item: anItem({ id: 'item-two' }) },
        ],
        events: [],
      })
      const shard = path.join(workspace.root, 'items/2026-09.md')
      const text = await readFile(shard, 'utf8')
      await writeFile(shard, text.replace('# item-two: A first task\n\n', '# item-two: A first task\n\n__proto__: polluted\n'))

      const items = await workspace.store.list()
      assert.deepEqual(items.ok ? items.value.map((i) => i.id) : [], ['item-one'])
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.equal(findings.value.find((f) => f.rule === 'V2')?.id, 'item-two')
      assert.ok(prototypeIsClean())
    } finally {
      await workspace.dispose()
    }
  })
})

describe('an event line that carries a prototype slot', () => {
  const line = (payload: string): string => JSON.stringify({
    id: 'ev-1', at: '2026-09-01T10:00:00Z', actor: 'a', actor_kind: 'person',
    entity_kind: 'work_item', entity: 'item-one', op: 'update', txn: 't1',
  }).slice(0, -1) + `,"after":${payload}}`

  it('refuses the audit\'s own payload before anything can merge it', () => {
    assert.ok(prototypeIsClean())
    const parsed = parseEventLine(line('{"__proto__":{"polluted":"yes"}}'), 'events/2026-09.jsonl', 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.error.rule, 'V2')
    assert.ok(prototypeIsClean())
  })

  it('refuses one nested three levels down, not only at the top', () => {
    const parsed = parseEventLine(line('{"a":{"b":{"constructor":{"x":1}}}}'), 'events/2026-09.jsonl', 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.error.rule, 'V2')
  })

  it('builds every object it keeps with a null prototype', () => {
    const parsed = parseEventLine(line('{"state":{"was":"draft"}}'), 'events/2026-09.jsonl', 1)
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.message)
    const after = parsed.value.after as Record<string, unknown>
    assert.equal(Object.getPrototypeOf(after), null)
    assert.equal(Object.getPrototypeOf(after['state'] as object), null)
    assert.equal(Object.getPrototypeOf(parsed.value), null)
  })

  it(`refuses JSON nested past ${MAX_JSON_DEPTH} levels rather than walking it`, () => {
    let payload = '1'
    for (let i = 0; i <= MAX_JSON_DEPTH + 2; i += 1) payload = `{"a":${payload}}`
    const parsed = parseEventLine(line(payload), 'events/2026-09.jsonl', 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.error.rule, 'S7')
  })

  it('records the refusal as a finding and keeps serving every other line', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem() }],
        events: [{
          id: 'ev-1', at: '2026-09-01T10:00:00Z', actor: 'a', actor_kind: 'person',
          entity_kind: 'work_item', entity: 'item-one', op: 'file', txn: 't1',
        }],
      })
      const log = path.join(workspace.root, 'events/2026-09.jsonl')
      await writeFile(log, `${await readFile(log, 'utf8')}${line('{"__proto__":{"polluted":"yes"}}')}\n`)

      const events = await workspace.store.events()
      assert.deepEqual(events.ok ? events.value.map((e) => e.id) : [], ['ev-1'])
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.equal(findings.value.find((f) => f.rule === 'V2')?.line, 2)
      assert.ok(prototypeIsClean())
    } finally {
      await workspace.dispose()
    }
  })
})
