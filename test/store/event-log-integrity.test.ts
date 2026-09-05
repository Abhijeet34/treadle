// SPDX-License-Identifier: Apache-2.0
// The event log under the same property the record files hold: a line the store holds and
// does not serve is a finding naming the file and the line, never a silent drop.
//
// Found by attacking the log directly. A second file carrying an existing event id replaced
// the real event in every read and `doctor` said clean; a same-file repeat vanished the same
// way; `2026-13-45T25:61:61Z` passed the instant check and sorted after every real event;
// and a blank line moved every line number an append re-index reported.

import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { parseEventLine } from '../../src/adapters/store/index.ts'
import { aWorkspace } from '../helpers/store-fixtures.ts'

function line(id: string, at: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id, at, actor: 'a', actor_kind: 'human', entity_kind: 'item', entity: 'item-one', op: 'update', txn: `t-${id}`, ...extra,
  })}\n`
}

describe('an event instant names a real date and time', () => {
  it('refuses a month, day, hour, minute or second that does not exist', () => {
    for (const at of ['2026-13-45T25:61:61Z', '2026-02-30T00:00:00Z', '2026-09-31T00:00:00Z', '2026-09-05T24:00:00Z']) {
      const parsed = parseEventLine(line('e1', at).trim(), 'events/2026-09.jsonl', 1)
      assert.ok(!parsed.ok, `${at} was accepted`)
      assert.equal(parsed.error.rule, 'S1')
      assert.match(parsed.error.message, /real date and time/)
    }
  })

  it('accepts a real instant, with or without fractional seconds', () => {
    for (const at of ['2026-09-05T18:04:31Z', '2026-09-05T18:04:31.123456789Z', '2024-02-29T23:59:59Z']) {
      assert.ok(parseEventLine(line('e1', at).trim(), 'events/2026-09.jsonl', 1).ok, `${at} was refused`)
    }
  })
})

describe('an event id appears once in the store', () => {
  it('reports a same-file repeat as S14 at its line, and serves one copy', async () => {
    const workspace = await aWorkspace()
    try {
      const log = path.join(workspace.root, 'events', '2026-09.jsonl')
      await mkdir(path.dirname(log), { recursive: true })
      await writeFile(log, line('dup', '2026-09-01T10:00:00Z') + line('dup', '2026-09-01T11:00:00Z', { actor: 'mallory' }))

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const clash = findings.value.find((finding) => finding.rule === 'S14')
      assert.ok(clash !== undefined, `no S14 among ${JSON.stringify(findings.value)}`)
      assert.equal(clash.file, 'events/2026-09.jsonl')
      assert.equal(clash.line, 2)
      assert.match(clash.reason, /event dup at events\/2026-09\.jsonl line 2 repeats an id events\/2026-09\.jsonl already carries/)

      const events = await workspace.store.events()
      assert.ok(events.ok)
      assert.equal(events.value.length, 1)
      assert.equal(events.value[0]?.actor, 'a', 'the first copy is the one served')
    } finally {
      await workspace.dispose()
    }
  })

  it('reports a repeat across two month files, naming the file that already carries the id', async () => {
    const workspace = await aWorkspace()
    try {
      const events = path.join(workspace.root, 'events')
      await mkdir(events, { recursive: true })
      await writeFile(path.join(events, '2026-08.jsonl'), line('dup', '2026-08-05T10:00:00Z', { actor: 'mallory' }))
      await writeFile(path.join(events, '2026-09.jsonl'), line('dup', '2026-09-01T10:00:00Z'))

      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const clash = findings.value.find((finding) => finding.rule === 'S14')
      assert.ok(clash !== undefined, `no S14 among ${JSON.stringify(findings.value)}`)
      assert.equal(clash.file, 'events/2026-09.jsonl')
      assert.equal(clash.line, 1)
      assert.match(clash.reason, /repeats an id events\/2026-08\.jsonl already carries/)
    } finally {
      await workspace.dispose()
    }
  })
})

describe('a finding on an appended line names the line the file has', () => {
  it('counts blank lines in the prefix, so the appended line is line 4 and not line 3', async () => {
    const workspace = await aWorkspace()
    try {
      const log = path.join(workspace.root, 'events', '2026-09.jsonl')
      await mkdir(path.dirname(log), { recursive: true })
      await writeFile(log, `${line('e1', '2026-09-01T10:00:00Z')}\n${line('e2', '2026-09-01T11:00:00Z')}`)
      const first = await workspace.store.events()
      assert.ok(first.ok && first.value.length === 2)

      // The append keeps the prefix bytes, so the store re-indexes the tail from its
      // recorded line count rather than the whole file.
      await appendFile(log, 'not json\n')
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const bad = findings.value.find((finding) => finding.rule === 'S1')
      assert.ok(bad !== undefined, `no S1 among ${JSON.stringify(findings.value)}`)
      assert.equal(bad.line, 4)
    } finally {
      await workspace.dispose()
    }
  })
})
