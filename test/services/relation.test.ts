// SPDX-License-Identifier: Apache-2.0
// The typed link, driven through the command surface: the edge is stored once and both
// directions are served from it, every refusal fires with its rule, the guards that read
// blockers start biting, and a dangling or cyclic edge a hand edit left is a finding.
//
// `explain` printed `blocked no` and `blocks -` on every item before this command existed,
// so the first suite here is the line that was empty since the tool shipped.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli, type Run } from '../helpers/cli-run.ts'

const SHARD = ['items', '2026-09.md']

function lines(run: Run): readonly string[] {
  return `${run.out}${run.err}`.split('\n')
}

function line(run: Run, key: string): string | undefined {
  return lines(run).find((entry) => entry === key || entry.startsWith(`${key} `))
}

describe('a blocks edge is stored once and read from both ends', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('writes the blocker\'s record and no other', async () => {
    const added = await cli(['relation', 'add', 'auth-refresh', 'blocks', 'csv-export'])
    assert.equal(added.code, 0, added.err)
    assert.equal(line(added, 'item'), 'item auth-refresh')
    assert.equal(line(added, 'kind'), 'kind blocks')
    assert.equal(line(added, 'other'), 'other csv-export')
    const shard = await readFile(path.join(demo.root, 'items', '2026-08.md'), 'utf8')
    const blocker = shard.slice(shard.indexOf('# auth-refresh:'), shard.indexOf('\n# ', shard.indexOf('# auth-refresh:') + 1))
    const blocked = shard.slice(shard.indexOf('# csv-export:'), shard.indexOf('\n# ', shard.indexOf('# csv-export:') + 1))
    assert.ok(blocker.includes('## Relations\n\n- blocks csv-export'), blocker)
    assert.equal(blocked.includes('Relations'), false, 'the inverse is derived, never stored')
  })

  it('serves explain\'s blocked and blocks lines from that one stored direction', async () => {
    const blocked = await cli(['explain', 'csv-export'])
    assert.equal(line(blocked, 'blocked'), 'blocked yes auth-refresh')
    assert.equal(line(blocked, 'blocks'), 'blocks -')
    const blocker = await cli(['explain', 'auth-refresh'])
    assert.equal(line(blocker, 'blocked'), 'blocked no')
    assert.equal(line(blocker, 'blocks'), 'blocks csv-export')
  })

  it('shows the edge under its own kind on the source and under the inverse on the target', async () => {
    const source = await cli(['show', 'auth-refresh'])
    assert.ok(lines(source).includes('blocks csv-export'), source.out)
    const target = await cli(['show', 'csv-export'])
    assert.ok(lines(target).includes('blocked_by auth-refresh'), target.out)
  })

  it('is idempotent: the same edge again is an already, spelled either way for the symmetric kind', async () => {
    const again = await cli(['relation', 'add', 'auth-refresh', 'blocks', 'csv-export'])
    assert.equal(again.code, 0)
    assert.equal(line(again, 'already'), 'already auth-refresh')
    const first = await cli(['relation', 'add', 'theme-dark', 'relates-to', 'audit-log'])
    assert.equal(first.code, 0, first.err)
    assert.equal(line(first, 'item'), 'item audit-log', 'a symmetric edge lives on the lower id')
    const reversed = await cli(['relation', 'add', 'audit-log', 'relates_to', 'theme-dark'])
    assert.equal(line(reversed, 'already'), 'already audit-log')
    assert.ok(lines(await cli(['show', 'theme-dark'])).includes('relates_to audit-log'))
  })

  it('removes the edge from whichever record holds it, and a second remove is a no-op', async () => {
    const removed = await cli(['relation', 'remove', 'theme-dark', 'relates-to', 'audit-log'])
    assert.equal(removed.code, 0, removed.err)
    assert.equal(line(removed, 'item'), 'item audit-log')
    assert.equal(lines(await cli(['show', 'theme-dark'])).includes('relates_to audit-log'), false)
    const again = await cli(['relation', 'remove', 'theme-dark', 'relates-to', 'audit-log'])
    assert.equal(again.code, 0)
    assert.equal(line(again, 'already'), 'already theme-dark')
  })

  it('records one event on the record written, which history reads as relation=<kind>:<other>', async () => {
    const log = await cli(['history', 'auth-refresh', '--limit', '1'])
    assert.match(log.out, /item\.relation\.add relation=blocks:csv-export/)
  })
})

describe('the four refusals', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    assert.equal((await runCli(['relation', 'add', 'auth-refresh', 'blocks', 'csv-export'], { cwd: demo.root })).code, 0)
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('an id that is not an item, naming the id, with the near ids beside it', async () => {
    const run = await cli(['relation', 'add', 'csv-export', 'blocks', 'sso-sam'])
    assert.equal(run.code, 5)
    assert.equal(line(run, 'entity'), 'entity sso-sam')
    assert.match(run.err, /^"cause sso-sam is in no record here/m)
    assert.equal(line(run, 'near'), 'near sso-saml')
  })

  it('a blocks edge that closes a cycle, naming the path', async () => {
    assert.equal((await cli(['relation', 'add', 'csv-export', 'blocks', 'flaky-e2e'])).code, 0)
    const run = await cli(['relation', 'add', 'flaky-e2e', 'blocks', 'auth-refresh'])
    assert.equal(run.code, 3)
    assert.equal(line(run, 'rule'), 'rule R2')
    assert.match(run.err, /closes a cycle through flaky-e2e -> auth-refresh -> csv-export -> flaky-e2e/)
  })

  it('a self link', async () => {
    const run = await cli(['relation', 'add', 'csv-export', 'relates-to', 'csv-export'])
    assert.equal(run.code, 3)
    assert.equal(line(run, 'rule'), 'rule R1')
  })

  it('a second original for one duplicate, naming the first', async () => {
    assert.equal((await cli(['relation', 'add', 'stale-cache', 'duplicates', 'sess-timeout'])).code, 0)
    const run = await cli(['relation', 'add', 'stale-cache', 'duplicates', 'flaky-e2e'])
    assert.equal(run.code, 3)
    assert.equal(line(run, 'rule'), 'rule R4')
    assert.match(run.err, /stale-cache already duplicates sess-timeout/)
  })

  it('a kind the command does not write, naming the three it does', async () => {
    const run = await cli(['relation', 'add', 'csv-export', 'caused_by', 'flaky-e2e'])
    assert.equal(run.code, 2)
    assert.match(run.err, /the kinds are blocks, duplicates, relates_to/)
  })
})

describe('the guards and the ranking that read blockers', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    // Both ready, so the blocked one was in `next` and could start until this line.
    assert.equal((await runCli(['relation', 'add', 'webhook-retry', 'blocks', 'avatar-crop'], { cwd: demo.root })).code, 0)
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('G2 refuses a start while a blocker is active, and yields to an override with a reason', async () => {
    const refused = await cli(['transition', 'avatar-crop', 'in_progress'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'guard'), 'guard G2')
    assert.match(refused.err, /avatar-crop is blocked by webhook-retry/)
    assert.equal(line(refused, 'fix'), 'fix treadle transition avatar-crop in_progress --override G2 --reason "<why>"')
    const dry = await cli(['transition', 'avatar-crop', 'in_progress', '--override', 'G2', '--reason', 'the blocker is cosmetic', '--dry-run'])
    assert.equal(dry.code, 0, dry.err)
    assert.match(dry.out, /G2 pass\/overridden/)
  })

  it('leaves a blocked item out of next and names the blockers when asked why', async () => {
    const ranked = await cli(['next', '--limit', '20'])
    assert.equal(ranked.out.includes('\navatar-crop '), false, ranked.out)
    assert.match(ranked.out, /\nwebhook-retry \d+ \d+ p\d+\/a\d+\/d1\//, 'd counts the one active item it blocks')
    const why = await cli(['next', '--explain-absence', 'avatar-crop'])
    assert.equal(line(why, 'clause'), 'clause blocked by webhook-retry')
  })

  it('G7 refuses cancelling a blocker while something waits on it, and a cancelled blocker frees the item', async () => {
    const refused = await cli(['transition', 'webhook-retry', 'cancelled', '--resolution', 'wont_do', '--reason', 'dropped'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'guard'), 'guard G7')
    const cancelled = await cli(['transition', 'webhook-retry', 'cancelled', '--resolution', 'wont_do', '--reason', 'dropped', '--override', 'G7'])
    assert.equal(cancelled.code, 0, cancelled.err)
    assert.equal(line(await cli(['explain', 'avatar-crop']), 'blocked'), 'blocked no')
    // The edge stays on the record: it is the fact that was decided, and show still lists it.
    assert.ok(lines(await cli(['show', 'avatar-crop'])).includes('blocked_by webhook-retry'))
    assert.equal((await cli(['transition', 'avatar-crop', 'in_progress'])).code, 0)
  })
})

describe('what a hand edit can leave, which no write path records', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    assert.equal((await runCli(['relation', 'add', 'queue-drain', 'blocks', 'theme-dark'], { cwd: demo.root })).code, 0)
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })
  const shard = () => path.join(demo.root, ...SHARD)

  it('an edge to an item the store does not hold is H24 on doctor and on explain, and blocks nothing', async () => {
    const before = await readFile(shard(), 'utf8')
    await writeFile(shard(), before.replace('- blocks theme-dark', '- blocks theme-dark\n- blocks ghost-item'), 'utf8')
    const audit = await cli(['doctor'])
    assert.equal(audit.code, 7)
    assert.match(audit.out, /^H24 queue-drain relations blocks ghost-item names an item the store does not hold/m)
    assert.match(audit.out, /treadle relation remove queue-drain blocks ghost-item/)
    assert.match((await cli(['explain', 'queue-drain'])).out, /^H24 /m)
    assert.equal(line(await cli(['explain', 'queue-drain']), 'blocks'), 'blocks theme-dark')
    const dropped = await cli(['relation', 'remove', 'queue-drain', 'blocks', 'ghost-item'])
    assert.equal(dropped.code, 0, dropped.err)
    assert.equal((await cli(['doctor'])).code, 0, 'the remedy the finding named clears it')
  })

  it('a blocks cycle the files carry is H25, naming the path', async () => {
    const before = await readFile(shard(), 'utf8')
    const at = before.indexOf('# theme-dark:')
    const end = before.indexOf('\n# ', at + 1)
    const record = end < 0 ? before.slice(at) : before.slice(at, end)
    await writeFile(shard(), before.replace(record, `${record.trimEnd()}\n\n## Relations\n\n- blocks queue-drain\n\n`), 'utf8')
    const audit = await cli(['doctor'])
    assert.equal(audit.code, 7)
    assert.match(audit.out, /^H25 [a-z-]+ relations blocks closes a cycle through /m)
    assert.equal(line(await cli(['explain', 'theme-dark']), 'blocked'), 'blocked yes queue-drain')
    assert.equal(line(await cli(['explain', 'queue-drain']), 'blocked'), 'blocked yes theme-dark')
  })
})
