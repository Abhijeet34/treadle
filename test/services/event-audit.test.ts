// SPDX-License-Identifier: Apache-2.0
// The event log is a committed file, and a hand-written line that is well formed reaches
// `history`, `explain` and `doctor`. This file holds what each of those says about one.
//
// Found by writing lines by hand. A transition event saying `done` over a record saying
// `draft` was what `explain` named as the change that put the item where it is, with the
// forger's actor and reason, and `doctor` called the store clean; an event dated before
// the item was filed was a history row and nothing else.

import assert from 'node:assert/strict'
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

const LOG = path.join('.work', 'events', '2026-09.jsonl')
const SHARD = path.join('.work', 'items', '2026-09.md')

function line(fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    actor: 'mallory', actor_kind: 'human', entity_kind: 'item', entity: 'first-story', txn: 'tX', ...fields,
  })}\n`
}

describe('what each read says about a hand-written event line', () => {
  let root: string
  let filedAt: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadling-audit-'))
    const init = await runCli(['init'], { cwd: root, env: { TREADLING_ACTOR: 'alice' } })
    assert.equal(init.code, 0, init.err)
    const filed = await runCli(['file', 'story', 'First story', '--id', 'first-story'], { cwd: root, env: { TREADLING_ACTOR: 'alice' } })
    assert.equal(filed.code, 0, filed.err)
    filedAt = /^"set filed_at - -> (\S+)$/m.exec(filed.out)?.[1] as string
    assert.ok(filedAt !== undefined)
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: root, env: { TREADLING_ACTOR: 'alice' } })

  it('explain names the event that agrees with the stored state, and doctor reports the one that does not as H20', async () => {
    const clean = await cli(['explain', 'first-story'])
    const realEvent = /^from_event (\S+)$/m.exec(clean.out)?.[1]
    assert.ok(realEvent !== undefined)

    await appendFile(path.join(root, LOG), line({
      id: 'forge1', at: '2099-01-01T00:00:00Z', op: 'item.transition',
      before: { state: 'draft' }, after: { state: 'done' }, reason: 'fake',
    }))

    const explained = await cli(['explain', 'first-story'])
    assert.equal(explained.code, 0, explained.err)
    assert.match(explained.out, new RegExp(`^from_event ${realEvent}$`, 'm'), 'the forged line is not the entry event')
    assert.match(explained.out, /^"by alice$/m)
    assert.doesNotMatch(explained.out, /^"reason fake$/m)
    assert.match(explained.out, /^H20 state is draft in the record and the last event to record it says done/m, 'explain carries the audit')

    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 7)
    assert.match(doctor.out, /^H20 first-story state state is draft in the record and the last event to record it says done/m)

    const history = await cli(['history', 'first-story'])
    assert.equal(history.code, 0)
    assert.match(history.out, /^2099-01-01T00:00:00Z human item\.transition state=draft->done mallory$/m, 'history still lists the line, as a row a reader can weigh')
  })

  it('reports an event dated before the item was filed as H23, naming the event', async () => {
    await appendFile(path.join(root, LOG), line({ id: 'past1', at: '2020-01-01T00:00:00Z', op: 'item.set', after: { points: '3' } }))
    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 7)
    assert.match(doctor.out, new RegExp(`^H23 first-story past1 event past1 is dated 2020-01-01T00:00:00Z, before the item was filed at ${filedAt}`, 'm'))
  })

  it('does not raise H23 for an event in the same second as filed_at that carries a fractional part', async () => {
    const sameSecond = filedAt.replace('Z', '.500000000Z')
    await appendFile(path.join(root, LOG), line({ id: 'samesec1', at: sameSecond, op: 'item.set', after: { points: '5' } }))
    const doctor = await cli(['doctor'])
    assert.doesNotMatch(doctor.out, /^H23 first-story samesec1 /m)
  })

  it('refuses every read over an instant that names no real date, at exit 7 with the line', async () => {
    await appendFile(path.join(root, LOG), line({ id: 'cal1', at: '2026-13-45T25:61:61Z', op: 'item.set' }))
    const history = await cli(['history', 'first-story'])
    assert.equal(history.code, 7)
    assert.match(history.err, /^rule S1$/m)
    assert.match(history.err, /events\/2026-09\.jsonl line \d+: at must be an RFC 3339 instant in UTC that names a real date and time/)
    const log = await readFile(path.join(root, LOG), 'utf8')
    await writeFile(path.join(root, LOG), log.split('\n').filter((l) => !l.includes('"cal1"')).join('\n'))
  })

  it('doctor answers over a shard whose name carries a space, instead of exiting 1', async () => {
    const spaced = path.join(root, '.work', 'items', '2026-06 copy.md')
    await copyFile(path.join(root, SHARD), spaced)
    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 7, doctor.err)
    // The shard that sorts first is the one whose copy is served, so `2026-06 copy.md`
    // holds the record and the September shard carries the finding.
    assert.match(doctor.out, /^S3 first-story items\/2026-09\.md:\d+ first-story is already a record in this store; the copy in items\/2026-09\.md line \d+ is quarantined$/m)
    await rm(spaced)
  })
})
