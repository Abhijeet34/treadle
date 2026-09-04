// SPDX-License-Identifier: Apache-2.0
// Defects an auditor found by driving the command surface by hand. Every one of them got
// past the example-based suites because those exercise the cases someone had already thought
// of; each assertion here names the interface rule it holds to, so a regression reads as the
// rule that broke rather than as a diff.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

/** 69 bytes, which is the length that first showed `show` cutting a title at 64 cells. */
const LONG_TITLE = 'A title that runs to sixty nine bytes in total, which is over the cut'

describe('the defects found by using the tool', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  describe('B.8: quiet suppresses the header and the footer, never an error', () => {
    it('prints the error object on stderr under -q, and keeps the exit status', async () => {
      const refusal = await cli(['show', 'no-such-item', '-q'])
      assert.equal(refusal.code, 5)
      assert.equal(refusal.out, '')
      assert.match(refusal.err, /^err NOT_FOUND /)
      assert.match(refusal.err, /"cause no-such-item is in no record here/)
      assert.match(refusal.err, /^fix treadle backlog$/m, 'the remediation is part of the error object')
    })

    it('still drops the envelope and the scalars on a success', async () => {
      const quiet = await cli(['backlog', '--state', 'ready', '-q'])
      assert.equal(quiet.code, 0)
      assert.doesNotMatch(quiet.out, /^ok backlog/)
      assert.match(quiet.out, /^~items /m, 'the primary data stays')
    })
  })

  describe('A.4: the title is never truncated, because the store bounds it at 200 characters', () => {
    it('prints a 69 byte title whole on show and on the file confirmation', async () => {
      const filed = await cli(['file', 'task', LONG_TITLE, '--id', 'long-title'])
      assert.equal(filed.code, 0, filed.err)
      assert.match(filed.out, new RegExp(`^"title ${LONG_TITLE}$`, 'm'))

      const shown = await cli(['show', 'long-title'])
      assert.match(shown.out, new RegExp(`^"title ${LONG_TITLE}$`, 'm'))
      assert.doesNotMatch(shown.out, /^\+title /m, 'a bounded field emits no truncation sentinel')
      assert.doesNotMatch(shown.out, /^page .*--field title$/m)
    })
  })

  describe('the field dictionary: a hold expiry must be in the future when the hold is set', () => {
    it('refuses an instant in the past and leaves the item where it was', async () => {
      const past = await cli([
        'transition', 'csv-export', 'on_hold', '--reason', 'waiting on legal',
        '--until', '2020-01-01T00:00:00Z',
      ])
      assert.equal(past.code, 2)
      assert.match(past.err, /^err VALIDATION /)
      assert.match(past.err, /hold_until 2020-01-01T00:00:00Z is not in the future/)

      const shown = await cli(['show', 'csv-export'])
      assert.match(shown.out, /^state ready$/m, 'a refused transition writes nothing')
    })

    it('accepts an instant in the future', async () => {
      const future = await cli([
        'transition', 'csv-export', 'on_hold', '--reason', 'waiting on legal',
        '--until', '2099-01-01T00:00:00Z',
      ])
      assert.equal(future.code, 0, future.err)
      assert.match(future.out, /^set hold_until - -> 2099-01-01T00:00:00Z$/m)
    })
  })

  describe('A.2 rule 1: no trailing whitespace on any line', () => {
    it('omits the guards line entirely when the edge evaluates none', async () => {
      const held = await cli(['transition', 'avatar-crop', 'on_hold', '--reason', 'blocked on a decision'])
      assert.equal(held.code, 0, held.err)
      assert.doesNotMatch(held.out, /^guards/m, 'an absent optional value is an absent line')
    })

    it('emits no line ending in a space or a tab, on any command in the inventory', async () => {
      const invocations: readonly (readonly string[])[] = [
        ['status'],
        ['backlog'],
        ['next'],
        ['show', 'auth-refresh'],
        ['explain', 'onboard-copy'],
        ['help'],
        ['help', 'transition'],
        ['version'],
        ['transition', 'webhook-retry', 'on_hold', '--reason', 'the vendor has not replied'],
        ['transition', 'legacy-oauth', 'draft', '--reason', 'we still have callers on OAuth 1'],
      ]
      for (const argv of invocations) {
        const ran = await cli(argv)
        for (const line of `${ran.out}${ran.err}`.split('\n')) {
          assert.equal(line, line.replace(/[ \t]+$/, ''), `${argv.join(' ')} emitted "${line}"`)
        }
      }
    })
  })

  describe('B.2: a flag note says why this command ignores the flag', () => {
    it('does not call a confirmation flag a presentation flag', async () => {
      const help = await cli(['help', 'transition'])
      const noteOf = (flag: string): string =>
        help.out.split('\n').find((line) => line.startsWith(`${flag} `)) ?? ''

      assert.match(noteOf('--color'), /^--color A .*presentation/)
      assert.match(noteOf('--width'), /^--width A .*presentation/)
      for (const flag of ['--yes', '--no-input']) {
        assert.match(noteOf(flag), new RegExp(`^${flag} A `), `${flag} is still accepted and ignored here`)
        assert.doesNotMatch(noteOf(flag), /presentation/, `${flag} has nothing to do with presentation`)
        assert.match(noteOf(flag), /confirm/, `${flag} is ignored because there is no confirmation`)
      }
    })
  })

  describe('T4: a transition that requires a reason records it', () => {
    it('stores the reason in the event and reports it in explain', async () => {
      const reason = 'the acceptance criteria are not agreed yet'
      const ungroomed = await cli(['transition', 'gdpr-export', 'draft', '--reason', reason])
      assert.equal(ungroomed.code, 0, ungroomed.err)

      const events = await demo.store.events({ entity: 'gdpr-export' })
      assert.ok(events.ok)
      const last = events.value.at(-1) as { op: string; reason?: string }
      assert.equal(last.op, 'item.transition')
      assert.equal(last.reason, reason, 'a reason T4 required is stored nowhere else')

      const explained = await cli(['explain', 'gdpr-export'])
      assert.match(explained.out, new RegExp(`^"reason ${reason}$`, 'm'))
    })

    it('records nothing on an edge that needs no reason, rather than an empty value', async () => {
      const groomed = await cli(['transition', 'metrics-p95', 'ready'])
      assert.equal(groomed.code, 0, groomed.err)
      const events = await demo.store.events({ entity: 'metrics-p95' })
      assert.ok(events.ok)
      assert.equal((events.value.at(-1) as { reason?: string }).reason, undefined)

      const explained = await cli(['explain', 'metrics-p95'])
      assert.doesNotMatch(explained.out, /^"?reason/m)
    })
  })
})

describe('S3: a duplicate id refuses the write rather than serving the first match', () => {
  let demo: Demo

  before(async () => {
    demo = await aDemoWorkspace()
    const shard = path.join(demo.root, 'items', '2026-09.md')
    const copy = [
      '',
      '# queue-drain: Drain the dead letter queue on deploy, the copy',
      '',
      'type: task',
      'state: draft',
      'filed_at: 2026-09-04T08:00:00Z',
      'version: 1',
      '',
    ].join('\n')
    await writeFile(shard, `${await readFile(shard, 'utf8')}${copy}`)
  })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('reports the finding, and refuses to write either copy', async () => {
    const shard = path.join(demo.root, 'items', '2026-09.md')
    const before = await readFile(shard, 'utf8')

    const state = await cli(['status'])
    assert.match(state.out, /^findings [1-9]/m, 'the index still quarantines the copy')

    const moved = await cli(['transition', 'queue-drain', 'ready'])
    assert.equal(moved.code, 4, `expected a conflict, got ${moved.code}: ${moved.out}${moved.err}`)
    assert.match(moved.err, /^err CONFLICT /)
    assert.match(moved.err, /^rule S3$/m)
    assert.match(moved.err, /queue-drain/)

    assert.equal(await readFile(shard, 'utf8'), before, 'a refused write leaves the shard untouched')
  })

  it('leaves every other record writable, so one bad id does not stop the workspace', async () => {
    const moved = await cli(['transition', 'i18n-dates', 'ready'])
    assert.equal(moved.code, 0, moved.err)
  })
})
