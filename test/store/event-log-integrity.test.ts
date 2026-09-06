// SPDX-License-Identifier: Apache-2.0
// The event log under the same property the record files hold: a line the store holds and
// does not serve is a finding naming the file and the line, never a silent drop.
//
// Found by attacking the log directly. A second file carrying an existing event id replaced
// the real event in every read and `doctor` said clean; a same-file repeat vanished the same
// way; `2026-13-45T25:61:61Z` passed the instant check and sorted after every real event;
// and a blank line moved every line number an append re-index reported.

import assert from 'node:assert/strict'
import { appendFile, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { IndexCache, parseEventLine } from '../../src/adapters/store/index.ts'
import { aWorkspace, anEvent, anItem } from '../helpers/store-fixtures.ts'

const LOG = 'events/2026-09.jsonl'

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

describe('a clash finding goes with the file it clashed against', () => {
  it('serves the surviving event file again once the other copy is removed', async () => {
    const workspace = await aWorkspace()
    try {
      const events = path.join(workspace.root, 'events')
      await mkdir(events, { recursive: true })
      await writeFile(path.join(events, '2026-08.jsonl'), line('dup', '2026-08-05T10:00:00Z', { actor: 'mallory' }))
      await writeFile(path.join(events, '2026-09.jsonl'), line('dup', '2026-09-01T10:00:00Z'))
      const clashed = await workspace.store.findings()
      assert.ok(clashed.ok && clashed.value.some((finding) => finding.rule === 'S14'))

      await rm(path.join(events, '2026-08.jsonl'))
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.deepEqual(findings.value.filter((finding) => finding.rule === 'S14'), [], 'the S14 outlived the file it clashed against')
      const served = await workspace.store.events()
      assert.ok(served.ok)
      assert.equal(served.value.length, 1)
      assert.equal(served.value[0]?.actor, 'a')
    } finally {
      await workspace.dispose()
    }
  })

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
      const served = await workspace.store.list()
      assert.ok(served.ok)
      assert.equal(served.value.length, 1)
    } finally {
      await workspace.dispose()
    }
  })
})

// A reader refreshing beside a writer read the file's fingerprint before the writer had
// indexed its append, scanned the same lines from the older size, and every one clashed on
// the primary key: one false S14 per line, recorded, and every command refused at exit 7
// until the index was deleted by hand. The append is a partial read, so it may add rows and
// never decide a clash; both ways it can be wrong hand the file back for a whole pass (ADR-0020).
describe('an append never decides a clash', () => {
  async function indexed(): Promise<{ workspace: Awaited<ReturnType<typeof aWorkspace>>; cache: IndexCache; size: number }> {
    const workspace = await aWorkspace()
    const log = path.join(workspace.root, LOG)
    await mkdir(path.dirname(log), { recursive: true })
    await writeFile(log, line('e1', '2026-09-01T10:00:00Z') + line('e2', '2026-09-01T11:00:00Z'))
    const served = await workspace.store.events()
    assert.ok(served.ok && served.value.length === 2)
    const cache = new IndexCache(path.join(workspace.root, '.index'))
    const size = cache.fingerprints().get(LOG)?.size
    assert.ok(size !== undefined)
    return { workspace, cache, size }
  }

  it('hands the file back untouched when another process has indexed past its base', async () => {
    const { workspace, cache, size } = await indexed()
    try {
      const grown = { size: size + 40, mtime: 1, hash: 'later', lines: 3 }
      const outcome = cache.replaceEventFile(LOG, grown, [anEvent({ id: 'e3' })], [3], [], true, size - 10)
      assert.equal(outcome.wholePass, true)
      assert.deepEqual(cache.findings(), [])
      assert.equal(cache.fingerprints().get(LOG)?.size, size, 'the fingerprint moved under a rolled-back append')
      assert.equal(cache.listEvents({}).length, 2, 'the rolled-back append wrote a row')
    } finally {
      cache.close()
      await workspace.dispose()
    }
  })

  it('hands the file back rather than recording S14 when an appended line repeats an indexed id', async () => {
    const { workspace, cache, size } = await indexed()
    try {
      const grown = { size: size + 40, mtime: 1, hash: 'later', lines: 3 }
      const outcome = cache.replaceEventFile(LOG, grown, [anEvent({ id: 'e2' })], [3], [], true, size)
      assert.equal(outcome.wholePass, true)
      assert.deepEqual(cache.findings(), [], 'a partial read recorded a finding')
      assert.equal(cache.fingerprints().get(LOG)?.size, size)
    } finally {
      cache.close()
      await workspace.dispose()
    }
  })

  it('still reports a repeat the tail really carries as S14 at its line, from the whole pass', async () => {
    const { workspace, cache, size } = await indexed()
    try {
      await appendFile(path.join(workspace.root, LOG), line('e1', '2026-09-01T12:00:00Z', { actor: 'mallory' }))
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      const clash = findings.value.find((finding) => finding.rule === 'S14')
      assert.ok(clash !== undefined, `no S14 among ${JSON.stringify(findings.value)}`)
      assert.equal(clash.line, 3)
      assert.ok((cache.fingerprints().get(LOG)?.size ?? 0) > size, 'the whole pass did not record the grown file')
      const events = await workspace.store.events()
      assert.ok(events.ok)
      assert.equal(events.value.length, 2)
      assert.equal(events.value.find((event) => event.id === 'e1')?.actor, 'a', 'the first copy is the one served')
    } finally {
      cache.close()
      await workspace.dispose()
    }
  })
})
