// SPDX-License-Identifier: Apache-2.0
// The three defects an auditor found by driving the tool, held closed here, and the
// evidence rule that ships with them.
//
// 1. A bug's severity reached no read surface: show, explain, backlog, status and next
//    printed it zero times, and next weighted priority only, so an S1 and an S4 tied.
// 2. No event carried severity or priority, so a hand edit taking S1 to S4 left no trace.
// 3. A 90,000-character description and a 10,000-character reason were both accepted.
//
// Each assertion drives the published command surface rather than a service, because the
// defects were all found that way and three of them are invisible one layer down.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after, beforeEach } from 'node:test'

import { MAX_DESCRIPTION, MAX_EVIDENCE_ENTRIES, MAX_REASON } from '../../src/domain/index.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

/** The shard every seeded item lands in, which is the file a hand edit reaches for. */
async function shard(demo: Demo): Promise<string> {
  const file = path.join(demo.root, 'items', '2026-09.md')
  return readFile(file, 'utf8')
}

async function editShard(demo: Demo, edit: (text: string) => string): Promise<void> {
  const file = path.join(demo.root, 'items', '2026-09.md')
  await writeFile(file, edit(await readFile(file, 'utf8')), 'utf8')
}

describe('severity reaches every read surface a caller would look at', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('prints it on show, and answers --field sev, which used to be a C2 refusal', async () => {
    const shown = await cli(['show', 'sess-timeout'])
    assert.equal(shown.code, 0)
    assert.match(shown.out, /^sev S1$/m)
    const one = await cli(['show', 'sess-timeout', '--field', 'sev'])
    assert.equal(one.code, 0)
    assert.match(one.out, /^sev S1$/m)
  })

  it('carries a sev column in the default backlog, and one dash for an item with none', async () => {
    const list = await cli(['backlog', '--type', 'bug'])
    assert.match(list.out, /^#id type state pts sev "title$/m)
    assert.match(list.out, /^sess-timeout bug draft 3 S1 /m)
    const mixed = await cli(['backlog', '--type', 'chore'])
    assert.match(mixed.out, /^dep-bump chore ready 1 - /m)
  })

  it('counts the open defects on status, by severity, and only the open ones', async () => {
    const overview = await cli(['status'])
    assert.match(overview.out, /^defects S1 1 S2 1 S3 1$/m)
  })

  it('prints it on explain', async () => {
    const why = await cli(['explain', 'sess-timeout'])
    assert.match(why.out, /^sev S1$/m)
  })
})

describe('next weights severity, so an S1 and an S4 no longer rank identically', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })
    // Two bugs and a chore, every one of them at priority 1, so severity is the only term
    // that can separate them and the score arithmetic is readable in the failure message.
    for (const [id, severity, title] of [
      ['sev-one', 'S1', 'Checkout drops the session'],
      ['sev-four', 'S4', 'Tooltip is one pixel off'],
    ] as const) {
      await cli(['file', 'bug', title, '--id', id, '--priority', '1',
        '--set', `severity=${severity}`, '--set', 'found_in=production',
        '--set', 'repro_steps=pay twice', '--set', 'expected=one charge', '--set', 'actual=two'])
      await cli(['transition', id, 'ready'])
    }
    await cli(['file', 'chore', 'Tidy the changelog', '--id', 'sev-none', '--priority', '1'])
    await cli(['transition', 'sev-none', 'ready'])
  })
  after(async () => { await demo.dispose() })

  it('ranks the S1 above the S4 above the chore, and prints the component that did it', async () => {
    const ranked = await runCli(['next', '--limit', '40'], { cwd: demo.root })
    const rows = ranked.out.split('\n').filter((line) => /^sev-(one|four|none) /.test(line))
    assert.deepEqual(rows.map((row) => row.split(' ')[0]), ['sev-one', 'sev-four', 'sev-none'])
    assert.match(rows[0] as string, /\/v4 /)
    assert.match(rows[1] as string, /\/v1 /)
    assert.match(rows[2] as string, /\/v0 /)
  })

  it('prints the severity weight beside the others, so the order is checkable (R11)', async () => {
    const ranked = await runCli(['next'], { cwd: demo.root })
    assert.match(ranked.out, /^weights pri 10 age 1 dep 5 spr 8 asg 0 sev 6$/m)
  })

  it('lets severity lift a defect at most 2.4 priority levels, never more', async () => {
    // The bound the weight was chosen for: an S1 is 4 x 6 = 24 and a priority level is 10.
    const ranked = await runCli(['next', '--limit', '40'], { cwd: demo.root })
    const scoreOf = (id: string): number => Number(
      (ranked.out.split('\n').find((line) => line.startsWith(`${id} `)) as string).split(' ')[2])
    assert.equal(scoreOf('sev-one') - scoreOf('sev-none'), 24)
  })
})

describe('a change to severity or priority is an event with a before and an after', () => {
  let demo: Demo
  beforeEach(async () => { demo = await aDemoWorkspace() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  const events = async (): Promise<readonly Record<string, unknown>[]> => {
    const text = await readFile(path.join(demo.root, 'events', '2026-09.jsonl'), 'utf8')
    return text.split('\n').filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('records what a bug was filed with, which the file event used to drop', async () => {
    await cli(['file', 'bug', 'Payment retried twice', '--id', 'pay-twice', '--priority', '1',
      '--set', 'severity=S1', '--set', 'found_in=production', '--set', 'repro_steps=pay'])
    const filed = (await events()).find((event) => event['entity'] === 'pay-twice')
    const after = filed?.['after'] as Record<string, string>
    assert.equal(after['severity'], 'S1')
    assert.equal(after['priority'], '1')
    // The prose the confirmation prints stays out of the log: the record already holds it.
    assert.equal(after['repro_steps'], undefined)
    await demo.dispose()
  })

  it('records a mark with both values and the reason, and names the actor', async () => {
    const marked = await cli(['mark', 'sess-timeout', '--severity', 'S3', '--priority', '4',
      '--reason', 'the workaround holds until the next release', '--actor', 'kim'])
    assert.equal(marked.code, 0)
    assert.match(marked.out, /^set severity S1 -> S3$/m)
    assert.match(marked.out, /^set priority 1 -> 4$/m)

    const event = (await events()).find((entry) => entry['op'] === 'item.mark')
    assert.deepEqual(event?.['before'], { severity: 'S1', priority: '1' })
    assert.deepEqual(event?.['after'], { severity: 'S3', priority: '4' })
    assert.equal(event?.['actor'], 'kim')
    assert.equal(event?.['reason'], 'the workaround holds until the next release')
    await demo.dispose()
  })

  it('refuses a change with no reason, and names the fields that would have moved', async () => {
    const bare = await cli(['mark', 'sess-timeout', '--severity', 'S4'])
    assert.equal(bare.code, 2)
    assert.match(bare.err, /^rule C1$/m)
    assert.match(bare.err, /a change to severity records a reason, and none was given/)
    await demo.dispose()
  })

  it('is an idempotent no-op when the value is already what was asked for', async () => {
    const same = await cli(['mark', 'sess-timeout', '--severity', 'S1'])
    assert.equal(same.code, 0)
    assert.match(same.out, /^already sess-timeout$/m)
    assert.equal((await events()).some((entry) => entry['op'] === 'item.mark'), false)
    await demo.dispose()
  })

  it('refuses a reason past the bound rather than writing it to the log', async () => {
    const long = await cli(['mark', 'sess-timeout', '--severity', 'S2', '--reason', 'r'.repeat(MAX_REASON + 1)])
    assert.equal(long.code, 2)
    assert.match(long.err, /^rule T6$/m)
    assert.match(long.err, new RegExp(`a reason is ${MAX_REASON + 1} characters and the limit is ${MAX_REASON}`))
    await demo.dispose()
  })

  it('refuses a non-integer priority rather than silently truncating it', async () => {
    const fractional = await cli(['mark', 'sess-timeout', '--priority', '3.9', '--reason', 'not a whole number'])
    assert.equal(fractional.code, 2)
    assert.match(fractional.err, /priority must be a whole number from 1 to 5/)
    assert.equal((await events()).some((entry) => entry['op'] === 'item.mark'), false)

    const trailing = await cli(['mark', 'sess-timeout', '--priority', '5xyz', '--reason', 'not a whole number'])
    assert.equal(trailing.code, 2)
    assert.match(trailing.err, /priority must be a whole number from 1 to 5/)
    assert.equal((await events()).some((entry) => entry['op'] === 'item.mark'), false)
    await demo.dispose()
  })
})

describe('mark and evidence answer the two anti-ambiguity modes the flag matrix advertises', () => {
  let demo: Demo
  beforeEach(async () => { demo = await aDemoWorkspace() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  const shardOf = async (): Promise<string> => shard(demo)

  it('reports the diff a mark would write, and writes nothing, under --dry-run', async () => {
    const before = await shardOf()
    const run = await cli(['mark', 'sess-timeout', '--severity', 'S3', '--reason', 'it has a workaround', '--dry-run'])
    assert.equal(run.code, 0)
    assert.match(run.out, /^dry_run 1$/m)
    assert.match(run.out, /^set severity S1 -> S3$/m)
    assert.equal(await shardOf(), before, 'a dry run leaves the shard alone')
    await demo.dispose()
  })

  it('names the store and evaluates nothing under --preview, and says so', async () => {
    const run = await cli(['mark', 'sess-timeout', '--severity', 'S3', '--reason', 'it has a workaround', '--preview'])
    assert.equal(run.code, 0)
    assert.match(run.out, /^preview 1$/m)
    assert.match(run.out, /^note nothing evaluated; use --dry-run for the outcome$/m)
    await demo.dispose()
  })

  it('does the same for an evidence add', async () => {
    const before = await shardOf()
    const dry = await cli(['evidence', 'add', 'sess-timeout', 'run', '8813', '--dry-run'])
    assert.equal(dry.code, 0)
    assert.match(dry.out, /^dry_run 1$/m)
    assert.equal(await shardOf(), before)
    const preview = await cli(['evidence', 'add', 'sess-timeout', 'run', '8813', '--preview'])
    assert.match(preview.out, /^preview 1$/m)
    await demo.dispose()
  })

  it('refuses an id no record names, and an evidence subcommand that is not add', async () => {
    const missing = await cli(['mark', 'no-such-item', '--severity', 'S1', '--reason', 'x'])
    assert.equal(missing.code, 5)
    assert.match(missing.err, /is in no record here/)

    const bare = await cli(['mark', 'sess-timeout'])
    assert.equal(bare.code, 2)
    assert.match(bare.err, /mark sets a severity or a priority, and neither was given/)

    const invented = await cli(['mark', 'sess-timeout', '--severity', 'S9', '--reason', 'x'])
    assert.equal(invented.code, 2)
    assert.match(invented.err, /S9 is not a severity; the severities are S1, S2, S3, S4/)

    const verb = await cli(['evidence', 'drop', 'sess-timeout', 'run', '8813'])
    assert.equal(verb.code, 2)
    assert.match(verb.err, /evidence takes one subcommand, add, not drop/)

    const short = await cli(['evidence', 'add', 'sess-timeout'])
    assert.equal(short.code, 2)
    assert.match(short.err, /evidence add needs an id, a kind and a ref/)
    await demo.dispose()
  })

  it('refuses a severity on a type that does not own the field, which is rule V5', async () => {
    const chore = await cli(['mark', 'dep-bump', '--severity', 'S1', '--reason', 'it is not a defect'])
    assert.equal(chore.code, 2)
    assert.match(chore.err, /severity is not a field of a chore/)
    await demo.dispose()
  })
})

describe('a hand edit of severity or priority is a finding', () => {
  let demo: Demo
  beforeEach(async () => { demo = await aDemoWorkspace() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('reports H20 on doctor with the stored value and the last one the log recorded', async () => {
    assert.match((await cli(['doctor'])).out, /^clean /m)
    await editShard(demo, (text) => text.replace(/^severity: S1$/m, 'severity: S4'))

    const found = await cli(['doctor'])
    assert.equal(found.code, 0)
    assert.match(found.out, /^H20 sess-timeout severity severity is S4 in the record and the last event to record it says S1;/m)
    await demo.dispose()
  })

  it('reports the same finding on explain, which reads that set of events anyway', async () => {
    await editShard(demo, (text) => text.replace(/^severity: S1$/m, 'severity: S4'))
    const why = await cli(['explain', 'sess-timeout'])
    assert.match(why.out, /^~findings 1 1$/m)
    assert.match(why.out, /^H20 severity is S4 in the record/m)
    await demo.dispose()
  })

  it('raises nothing for a workspace whose log never carried the field', async () => {
    // A file written before the file event carried its fields: silence in the log is not
    // evidence of an edit, so the check yields rather than accusing every older record.
    const events = path.join(demo.root, 'events', '2026-09.jsonl')
    const stripped = (await readFile(events, 'utf8')).split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const event = JSON.parse(line) as Record<string, unknown>
        if (typeof event['after'] === 'object' && event['after'] !== null) {
          const after = event['after'] as Record<string, unknown>
          delete after['severity']
          delete after['priority']
        }
        return JSON.stringify(event)
      })
    await writeFile(events, `${stripped.join('\n')}\n`, 'utf8')
    await editShard(demo, (text) => text.replace(/^severity: S1$/m, 'severity: S4'))
    assert.match((await cli(['doctor'])).out, /^clean /m)
    await demo.dispose()
  })

  it('reports H19 when the actor who marked the item is its own assignee', async () => {
    await cli(['mark', 'sess-timeout', '--priority', '5', '--reason', 'deprioritised', '--actor', 'ravi'])
    await cli(['file', 'bug', 'Owned by ravi', '--id', 'ravi-bug', '--set', 'severity=S2',
      '--set', 'found_in=dev', '--set', 'repro_steps=x', '--set', 'assignee=ravi'])
    await cli(['mark', 'ravi-bug', '--severity', 'S4', '--reason', 'cosmetic after all', '--actor', 'ravi'])
    const found = await cli(['doctor'])
    assert.match(found.out, /^H19 ravi-bug \S+ ravi changed severity on an item they are assigned;/m)
    await demo.dispose()
  })
})

describe('both prose doors are bounded, and neither bound truncates', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('refuses a description past the bound, naming both numbers', async () => {
    const before = (await shard(demo)).length
    const bomb = await cli(['file', 'task', 'Prose bomb', '--id', 'prose-bomb',
      '--set', `description=${'p'.repeat(90_000)}`])
    assert.equal(bomb.code, 2)
    assert.match(bomb.err, new RegExp(`description is 90000 characters and the limit is ${MAX_DESCRIPTION}, which is 80000 over`))
    assert.equal((await shard(demo)).length, before, 'a refused write leaves the shard alone')
  })

  it('accepts a description exactly at the bound', async () => {
    const fits = await cli(['file', 'task', 'A described task', '--id', 'described',
      '--set', `description=${'p'.repeat(MAX_DESCRIPTION)}`])
    assert.equal(fits.code, 0)
  })

  it('refuses a reason past the bound rather than storing it in the event', async () => {
    const long = await cli(['transition', 'csv-export', 'in_progress', '--reason', 'r'.repeat(10_000)])
    assert.equal(long.code, 2)
    assert.match(long.err, /^rule T6$/m)
    assert.match(long.err, new RegExp(`a reason is 10000 characters and the limit is ${MAX_REASON}`))
  })
})

describe('a description already over the bound still reads, and is a finding', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('serves the record rather than quarantining it, which is what the format promises', async () => {
    // Narrowing a bound after files exist would make those files unreadable, and
    // docs/STABILITY.md says reading always works. The store's S5 ceiling is the load bound.
    await cli(['file', 'task', 'A described task', '--id', 'described', '--set', 'description=short'])
    await editShard(demo, (text) => text.replace(/^short$/m, 'p'.repeat(42_000)))

    const shown = await cli(['show', 'described'])
    assert.equal(shown.code, 0, shown.err)
    const found = await cli(['doctor'])
    assert.match(found.out, new RegExp(`^H18 described description the stored description is 42000 characters and the bound is ${MAX_DESCRIPTION};`, 'm'))
  })
})

describe('evidence is a bounded pointer list, and done requires one', () => {
  let demo: Demo
  beforeEach(async () => { demo = await aDemoWorkspace() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  /** A bug, because its type has a review step and every other done rule is satisfiable here. */
  const aReviewedBug = async (id: string): Promise<void> => {
    await cli(['file', 'bug', 'Retry loses the idempotency key', '--id', id, '--priority', '2',
      '--set', 'severity=S2', '--set', 'found_in=production', '--set', 'repro_steps=retry',
      '--set', 'expected=one charge', '--set', 'actual=two charges',
      '--set', 'assignee=dana', '--set', 'reviewer=kim', '--set', 'fix_confirmed=true'])
    for (const state of ['ready', 'in_progress', 'in_review']) await cli(['transition', id, state])
  }

  it('refuses done with DOD7 and nothing else, and the remedy is the command that fixes it', async () => {
    await aReviewedBug('retry-key')
    const refused = await cli(['transition', 'retry-key', 'done'])
    assert.equal(refused.code, 3)
    assert.match(refused.err, /the done gate fails: DOD7$/m)
    const why = await cli(['explain', 'retry-key'])
    assert.match(why.out, /^done DOD7 fail treadle evidence add retry-key <kind> <ref> \[label\]$/m)
    await demo.dispose()
  })

  it('accepts done once the record points at something a third party can open', async () => {
    await aReviewedBug('retry-key')
    const added = await cli(['evidence', 'add', 'retry-key', 'run', '8813', '722 pass, 0 fail'])
    assert.equal(added.code, 0)
    assert.match(added.out, /^entries 1\/20$/m)
    assert.equal((await cli(['transition', 'retry-key', 'done'])).code, 0)
    await demo.dispose()
  })

  it('shows the pointers as a block and writes them as one Evidence section', async () => {
    await aReviewedBug('retry-key')
    await cli(['evidence', 'add', 'retry-key', 'run', '8813', '722 pass, 0 fail'])
    await cli(['evidence', 'add', 'retry-key', 'pr', 'https://example.test/pr/42'])
    const shown = await cli(['show', 'retry-key'])
    assert.match(shown.out, /^~evidence 2 2$/m)
    assert.match(shown.out, /^#kind ref "label$/m)
    assert.match(shown.out, /^run 8813 722 pass, 0 fail$/m)
    assert.match(shown.out, /^pr https:\/\/example\.test\/pr\/42 -$/m)
    assert.match(await shard(demo), /^## Evidence\n\n- run 8813 722 pass, 0 fail\n- pr https:\/\/example\.test\/pr\/42$/m)
    await demo.dispose()
  })

  it('refuses a kind outside the closed set, a duplicate, and a ref that is a sentence', async () => {
    await aReviewedBug('retry-key')
    await cli(['evidence', 'add', 'retry-key', 'run', '8813'])

    const invented = await cli(['evidence', 'add', 'retry-key', 'attestation', 'reviewed'])
    assert.equal(invented.code, 2)
    assert.match(invented.err, /attestation is not an evidence kind; the kinds are commit, pr, run, test, file, url, report/)

    const again = await cli(['evidence', 'add', 'retry-key', 'run', '8813'])
    assert.equal(again.code, 2)
    assert.match(again.err, /retry-key already points at run 8813/)

    // The whole point is a pointer, so a ref that reads as prose is refused rather than
    // becoming the second place an essay can live.
    const essay = await cli(['evidence', 'add', 'retry-key', 'report', 'the full write up follows'])
    assert.equal(essay.code, 2)
    assert.match(essay.err, /carries a space; a ref is a hash, a path, a run id or a URL/)
    await demo.dispose()
  })

  it('refuses the entry past the list bound, naming the count and the limit', async () => {
    await aReviewedBug('retry-key')
    for (let n = 0; n < MAX_EVIDENCE_ENTRIES; n += 1) {
      const added = await cli(['evidence', 'add', 'retry-key', 'run', `run-${n}`])
      assert.equal(added.code, 0, added.err)
    }
    const over = await cli(['evidence', 'add', 'retry-key', 'run', 'one-too-many'])
    assert.equal(over.code, 2)
    assert.match(over.err, new RegExp(`already carries ${MAX_EVIDENCE_ENTRIES} evidence entries and the limit is ${MAX_EVIDENCE_ENTRIES}`))
    await demo.dispose()
  })

  it('reports H21 when a hand edit takes the evidence off a done item', async () => {
    await aReviewedBug('retry-key')
    await cli(['evidence', 'add', 'retry-key', 'run', '8813'])
    await cli(['transition', 'retry-key', 'done'])
    assert.doesNotMatch((await cli(['doctor'])).out, /H21/)

    await editShard(demo, (text) => text.replace(/^## Evidence\n\n- run 8813\n\n/m, ''))
    assert.match((await cli(['doctor'])).out, /^H21 retry-key evidence the item is done and points at no evidence/m)
    await demo.dispose()
  })

  it('leaves a type with no review step alone, exactly as DOD3 does', async () => {
    await cli(['file', 'chore', 'Move the toolchain', '--id', 'toolchain', '--set', 'points=1'])
    for (const state of ['ready', 'in_progress']) await cli(['transition', 'toolchain', state])
    assert.equal((await cli(['transition', 'toolchain', 'done'])).code, 0)
    assert.doesNotMatch((await cli(['doctor'])).out, /H21/)
    await demo.dispose()
  })
})
