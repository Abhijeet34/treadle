// SPDX-License-Identifier: Apache-2.0
// The event log under the same property the record files hold: a line the store holds and
// does not serve is a finding naming the file and the line, never a silent drop.
//
// Found by attacking the log directly. `2026-13-45T25:61:61Z` passed the instant check and
// sorted after every real event, and a blank line moved every line number the log reported.
//
// The repeated-event-id rule that used to live here went with the index that owned it: an
// id was a primary key across the whole log because the log was a table, and reading the
// files serves every line the file carries. ADR-0030 records what that costs.

import assert from 'node:assert/strict'
import { appendFile, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { parseEventLine } from '../../src/adapters/store/index.ts'
import { allItems, aWorkspace, anItem } from '../helpers/store-fixtures.ts'

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

describe('a finding on a line of the log names the line the file has', () => {
  it('counts blank lines, so the appended line is line 4 and not line 3', async () => {
    const workspace = await aWorkspace()
    try {
      const log = path.join(workspace.root, 'events', '2026-09.jsonl')
      await mkdir(path.dirname(log), { recursive: true })
      await writeFile(log, `${line('e1', '2026-09-01T10:00:00Z')}\n${line('e2', '2026-09-01T11:00:00Z')}`)
      const first = await workspace.store.events()
      assert.ok(first.ok && first.value.length === 2)

      await appendFile(log, 'not json\n')
      // The log's findings are what reading it said, so the read comes first; a command
      // that never reads the log never pays for the scan that would produce them.
      const again = await workspace.store.events()
      assert.ok(again.ok && again.value.length === 2, 'the unreadable line was served')
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

describe('a clash finding goes with the file it clashed against', () => {
  it('serves the surviving shard again once a duplicate shard is removed, which the S3 did not before', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't0', writes: [{ item: anItem() }], events: [] })
      const items = path.join(workspace.root, 'items')
      const [shard] = (await readdir(items)).filter((name) => name.endsWith('.md'))
      await copyFile(path.join(items, shard as string), path.join(items, '2026-01.md'))
      const clashed = await workspace.store.findings()
      assert.ok(clashed.ok && clashed.value.some((finding) => finding.rule === 'S3'))

      await rm(path.join(items, '2026-01.md'))
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.deepEqual(findings.value.filter((finding) => finding.rule === 'S3'), [], 'the S3 outlived the duplicate shard')
      const served = await allItems(workspace.store)
      assert.ok(served.ok)
      assert.equal(served.value.length, 1)
    } finally {
      await workspace.dispose()
    }
  })
})
