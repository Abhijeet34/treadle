// SPDX-License-Identifier: Apache-2.0
// The impediment, driven through the command surface: a blocker as a record of its own,
// required to say what would clear it, holding work up through the same `blocks` edge every
// other item uses, and freeing that work by reaching `done` with nothing unlinked.
//
// `status` printed `absent_features board impediment` and DOD2 could never fail,
// because nothing could be open against an item. Both are what this file drives.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli, type Run } from '../helpers/cli-run.ts'

function lines(run: Run): readonly string[] {
  return `${run.out}${run.err}`.split('\n')
}

function line(run: Run, key: string): string | undefined {
  return lines(run).find((entry) => entry === key || entry.startsWith(`${key} `))
}

const RESOLUTION = 'the platform team renews the certificate from the vault and rotates the pin'

describe('raising an impediment', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('is refused without a proposed resolution, naming the field, and without a severity', async () => {
    const complaint = await cli(['file', 'impediment', 'Staging certificate expired', '--id', 'cert-expired', '--set', 'severity=S1'])
    assert.equal(complaint.code, 2)
    assert.equal(line(complaint, 'rule'), 'rule V4')
    assert.match(complaint.err, /^"cause an impediment needs proposed_resolution at creation$/m)
    const unweighed = await cli(['file', 'impediment', 'Staging certificate expired', '--id', 'cert-expired', '--set', `proposed_resolution=${RESOLUTION}`])
    assert.equal(unweighed.code, 2)
    assert.match(unweighed.err, /needs severity at creation/)
  })

  it('is refused with a proposed resolution made of whitespace, which names nothing', async () => {
    const blank = await cli(['file', 'impediment', 'Staging certificate expired', '--id', 'cert-expired', '--set', 'severity=S1', '--set', 'proposed_resolution=   '])
    assert.equal(blank.code, 2, blank.out)
    assert.equal(line(blank, 'rule'), 'rule V4')
    assert.match(blank.err, /^"cause proposed_resolution is only whitespace/m)
  })

  it('files with both, echoing them, and the file event carries the severity', async () => {
    const raised = await cli(['file', 'impediment', 'Staging certificate expired', '--id', 'cert-expired', '--set', 'severity=S1', '--set', `proposed_resolution=${RESOLUTION}`])
    assert.equal(raised.code, 0, raised.err)
    assert.equal(line(raised, 'type'), 'type impediment')
    assert.equal(line(raised, 'set severity'), 'set severity - -> S1')
    assert.equal(line(raised, 'set proposed_resolution'), `set proposed_resolution - -> ${RESOLUTION}`)
    assert.match((await cli(['history', 'cert-expired'])).out, /item\.file type=impediment,state=draft,filed_at=[^,]+,severity=S1/)
  })

  it('prints the proposed resolution on show, cut at 64 cells as desc is, and whole under --field', async () => {
    const shown = await cli(['show', 'cert-expired'])
    assert.equal(line(shown, '"proposed_resolution'), `"proposed_resolution ${RESOLUTION.slice(0, 64)}`)
    const whole = await cli(['show', 'cert-expired', '--field', 'proposed_resolution'])
    assert.equal(whole.code, 0, whole.err)
    assert.deepEqual(lines(whole).filter((entry) => entry.length > 0).slice(1), ['item cert-expired', `"proposed_resolution ${RESOLUTION}`])
  })

  it('is H27 on doctor and on explain while it blocks nothing, with the line that raises it against work', async () => {
    // `cert-expired` is filed and blocks nothing, and that is not a finding: `file` lands an
    // impediment in `draft`, `help file` then prescribes `relation add`, and the finding used
    // to fire between the two lines the tool itself prescribes (ADR-0022).
    assert.equal((await cli(['doctor'])).code, 0, 'a draft impediment raised against nothing is a record still being written')
    // Past `draft` it is raised, and DOR9 refuses to groom one that holds nothing up, so
    // raise-groom-unlink is the sequence that now reaches the finding.
    const filed = await cli(['file', 'impediment', 'Vault unreachable', '--id', 'vault-down', '--set', 'severity=S2', '--set', 'proposed_resolution=the platform team restores the vault'])
    assert.equal(filed.code, 0, filed.err)
    assert.equal((await cli(['relation', 'add', 'vault-down', 'blocks', 'audit-log'])).code, 0)
    assert.equal((await cli(['transition', 'vault-down', 'ready'])).code, 0)
    assert.equal((await cli(['relation', 'remove', 'vault-down', 'blocks', 'audit-log'])).code, 0)
    const audit = await cli(['doctor'])
    assert.equal(audit.code, 7)
    assert.match(audit.out, /^H27 vault-down relations the impediment is ready and blocks nothing, so it is raised against no work; treadle relation add vault-down blocks <id> names what it holds up$/m)
    assert.match((await cli(['explain', 'vault-down'])).out, /^H27 the impediment is ready and blocks nothing/m)
    assert.equal((await cli(['transition', 'vault-down', 'cancelled', '--resolution', 'rejected', '--reason', 'raised in error'])).code, 0)
  })

  it('refuses to groom one that holds nothing up, which is DOR9 on the ready gate', async () => {
    const refused = await cli(['transition', 'cert-expired', 'ready'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'guard'), 'guard G1')
    assert.match(refused.err, /the ready gate fails: DOR9/)
    assert.match(refused.err, /^fix treadle relation add cert-expired blocks <id>$/m)
  })

  it('stops being H27 once it blocks something, and a resolved one blocking nothing is not a finding', async () => {
    assert.equal((await cli(['relation', 'add', 'cert-expired', 'blocks', 'audit-log'])).code, 0)
    assert.equal((await cli(['doctor'])).code, 0)
    const drafted = await cli(['file', 'impediment', 'Withdrawn', '--id', 'withdrawn', '--set', 'severity=S4', '--set', 'proposed_resolution=nothing; it was raised in error'])
    assert.equal(drafted.code, 0, drafted.err)
    assert.equal((await cli(['doctor'])).code, 0, 'a draft impediment blocking nothing is not yet raised')
    assert.equal((await cli(['transition', 'withdrawn', 'cancelled', '--resolution', 'rejected', '--reason', 'raised in error'])).code, 0)
    assert.equal((await cli(['doctor'])).code, 0, 'a cancelled impediment is history, not a complaint')
  })

  it('revises the proposed resolution through set, which history reads as prose moving', async () => {
    const revised = await cli(['set', 'cert-expired', 'proposed_resolution=the platform team renews it'])
    assert.equal(revised.code, 0, revised.err)
    assert.match((await cli(['history', 'cert-expired', '--limit', '1'])).out, /item\.set proposed_resolution=\(text:\d+\)->\(text:\d+\)/)
  })

  it('takes severity through mark, with the reason, like a bug', async () => {
    const marked = await cli(['mark', 'cert-expired', '--severity', 'S2', '--reason', 'staging only'])
    assert.equal(marked.code, 0, marked.err)
    assert.equal(line(await cli(['show', 'cert-expired']), 'sev'), 'sev S2')
  })

  it('is listed under its type with its severity, and status no longer calls it absent', async () => {
    const listed = await cli(['backlog', '--type', 'impediment'])
    assert.match(listed.out, /^cert-expired impediment draft - S2 Staging certificate expired$/m)
    assert.equal(line(await cli(['status']), 'absent_features'), undefined, 'every feature the line named has landed')
  })
})

describe('an impediment raised against a draft story', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })
    // A story that passes every other ready rule, so DOR3 is the one thing in its way.
    assert.equal((await cli(['file', 'story', 'Ship SAML login for tenants', '--id', 'saml-login', '--set', 'points=5', '--set', 'acceptance_criteria=metadata upload works'])).code, 0)
    assert.equal((await cli(['file', 'impediment', 'Staging certificate expired', '--id', 'cert-expired', '--set', 'severity=S1', '--set', `proposed_resolution=${RESOLUTION}`])).code, 0)
    assert.equal((await cli(['relation', 'add', 'cert-expired', 'blocks', 'saml-login'])).code, 0)
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('refuses the story at ready on DOR3, and the refusal hands over the command that resolves the impediment', async () => {
    const refused = await cli(['transition', 'saml-login', 'ready'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'guard'), 'guard G1')
    assert.match(refused.err, /the ready gate fails: DOR3/)
    // The impediment is in draft, so the move that resolves it from here is `ready`, not
    // `done`: the fix line used to name `done`, which T1 refuses from draft.
    assert.equal(line(refused, 'fix'), 'fix treadle transition cert-expired ready')
    const why = await cli(['explain', 'saml-login'])
    assert.equal(line(why, 'blocked'), 'blocked yes cert-expired')
    assert.match(why.out, /^ready DOR3 fail treadle transition cert-expired ready$/m)
    assert.match(why.out, /^done DOD2 fail treadle transition cert-expired ready$/m)
    const ran = await cli(['transition', 'cert-expired', 'ready'])
    assert.equal(ran.code, 0, `the fix line was refused as printed: ${ran.err}`)
    assert.match((await cli(['explain', 'saml-login'])).out, /^ready DOR3 fail treadle transition cert-expired in_progress$/m, 'the remedy follows the impediment from state to state')
  })

  it('frees the story once the impediment is done, with nothing unlinked: the edge stays as history', async () => {
    for (const target of ['ready', 'in_progress', 'done']) {
      const moved = await cli(['transition', 'cert-expired', target])
      assert.equal(moved.code, 0, moved.err)
    }
    assert.equal(line(await cli(['explain', 'saml-login']), 'blocked'), 'blocked no')
    assert.equal((await cli(['transition', 'saml-login', 'ready'])).code, 0)
    assert.equal((await cli(['transition', 'saml-login', 'in_progress'])).code, 0)
    assert.ok(lines(await cli(['show', 'saml-login'])).includes('blocked_by cert-expired'))
    assert.ok(lines(await cli(['show', 'cert-expired'])).includes('blocks saml-login'))
  })

  it('re-blocks the story if the impediment is reopened, because the edge was never dropped', async () => {
    assert.equal((await cli(['transition', 'cert-expired', 'in_progress', '--reason', 'the renewed certificate is wrong'])).code, 0)
    assert.equal(line(await cli(['explain', 'saml-login']), 'blocked'), 'blocked yes cert-expired')
    assert.match((await cli(['explain', 'saml-login'])).out, /^done DOD2 fail treadle transition cert-expired done$/m)
  })
})

describe('an impediment raised against ready work', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })
    // Two impediments of different severity, each blocking one ready item, both ready.
    for (const [id, severity, blocks] of [['vendor-hold', 'S3', 'avatar-crop'], ['cert-expired', 'S1', 'webhook-retry']] as const) {
      assert.equal((await cli(['file', 'impediment', `Raised against ${blocks}`, '--id', id, '--set', `severity=${severity}`, '--set', 'proposed_resolution=someone clears it'])).code, 0)
      assert.equal((await cli(['relation', 'add', id, 'blocks', blocks])).code, 0)
      assert.equal((await cli(['transition', id, 'ready'])).code, 0)
    }
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('G2 refuses the start, and the fix names the proposed resolution before the override', async () => {
    const refused = await cli(['transition', 'avatar-crop', 'in_progress'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'guard'), 'guard G2')
    assert.match(refused.err, /avatar-crop is blocked by vendor-hold/)
    // The same blocked item is remedied the same way at `ready` and at `in_progress`: the
    // blocker's next move, and on this edge the override as the second answer.
    assert.deepEqual(lines(refused).filter((entry) => entry.startsWith('fix ')), [
      'fix treadle show vendor-hold --field proposed_resolution',
      'fix treadle transition vendor-hold in_progress',
      'fix treadle transition avatar-crop in_progress --override G2 --reason "<why>"',
      'fix treadle explain avatar-crop',
    ])
  })

  it('ranks the impediment where the blocked item would have been, with its severity as v and what it frees as d', async () => {
    const ranked = await cli(['next', '--limit', '20'])
    assert.equal(ranked.out.includes('\navatar-crop '), false, 'the blocked item is not ranked')
    assert.match(ranked.out, /\ncert-expired - 29 p0\/a0\/d1\/s0\/m0\/u0\/v4 /, 'an S1 blocking one item: d1 x 5 plus v4 x 6')
    assert.match(ranked.out, /\nvendor-hold - 17 p0\/a0\/d1\/s0\/m0\/u0\/v2 /, 'an S3 blocking one item: d1 x 5 plus v2 x 6')
    assert.ok(ranked.out.indexOf('\ncert-expired ') < ranked.out.indexOf('\nvendor-hold '), 'the S1 outranks the S3')
    assert.equal(line(await cli(['next', '--explain-absence', 'avatar-crop']), 'clause'), 'clause blocked by vendor-hold')
  })

  it('G7 refuses cancelling an impediment while work waits on it, as for any blocker', async () => {
    const refused = await cli(['transition', 'vendor-hold', 'cancelled', '--resolution', 'wont_do', '--reason', 'dropped'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'guard'), 'guard G7')
  })
})

describe('an impediment raised against work in progress', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })
    // `log-redact` is a task in progress with no review step, so `done` is one finish away.
    assert.equal((await cli(['file', 'impediment', 'Security review pending', '--id', 'sec-review', '--set', 'severity=S2', '--set', 'proposed_resolution=appsec signs off the redaction list'])).code, 0)
    assert.equal((await cli(['relation', 'add', 'sec-review', 'blocks', 'log-redact'])).code, 0)
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('DOD2 holds the work from done until the impediment is resolved, and the refusal names it', async () => {
    const refused = await cli(['transition', 'log-redact', 'done'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'guard'), 'guard G6')
    assert.match(refused.err, /the done gate fails: DOD2/)
    assert.equal(line(refused, 'fix'), 'fix treadle transition sec-review ready')
    assert.match((await cli(['explain', 'log-redact'])).out, /^done DOD2 fail treadle transition sec-review ready$/m)
    for (const target of ['ready', 'in_progress', 'done']) {
      assert.equal((await cli(['transition', 'sec-review', target])).code, 0)
    }
    const finished = await cli(['transition', 'log-redact', 'done'])
    assert.equal(finished.code, 0, finished.err)
  })
})

describe('nesting and the graph an impediment joins', () => {
  let demo: Demo
  before(async () => {
    demo = await aDemoWorkspace()
    const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })
    for (const [id, severity] of [['vendor-hold', 'S3'], ['sec-review', 'S2']] as const) {
      assert.equal((await cli(['file', 'impediment', `Impediment ${id}`, '--id', id, '--set', `severity=${severity}`, '--set', 'proposed_resolution=someone clears it'])).code, 0)
    }
    assert.equal((await cli(['relation', 'add', 'vendor-hold', 'blocks', 'avatar-crop'])).code, 0)
  })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('lets an impediment block an impediment, and the chain frees one link at a time', async () => {
    assert.equal((await cli(['relation', 'add', 'sec-review', 'blocks', 'vendor-hold'])).code, 0)
    const inner = await cli(['explain', 'vendor-hold'])
    assert.equal(line(inner, 'blocked'), 'blocked yes sec-review')
    assert.equal(line(inner, 'blocks'), 'blocks avatar-crop')
    // The story sees its direct blocker only; the chain above it is the impediment's own.
    assert.equal(line(await cli(['explain', 'avatar-crop']), 'blocked'), 'blocked yes vendor-hold')
  })

  it('refuses a cycle between two impediments, naming the path', async () => {
    const refused = await cli(['relation', 'add', 'vendor-hold', 'blocks', 'sec-review'])
    assert.equal(refused.code, 3)
    assert.equal(line(refused, 'rule'), 'rule R2')
    assert.match(refused.err, /vendor-hold -> sec-review -> vendor-hold/)
  })

  it('may carry a sprint, because resolving one is work someone commits to', async () => {
    // sec-review blocks vendor-hold above, so it, and not vendor-hold, still passes its own
    // ready gate here; the point proven is that an impediment may be committed at all. It is
    // groomed first because a sprint takes work that has been groomed (I4).
    assert.equal((await cli(['sprint', 'open', 'Sprint 31', '--id', 'sprint-31', '--end', '2026-09-18'])).code, 0)
    assert.equal((await cli(['transition', 'sec-review', 'ready'])).code, 0)
    const committed = await cli(['sprint', 'commit', 'sprint-31', 'sec-review'])
    assert.equal(committed.code, 0, committed.err)
    assert.equal(line(await cli(['show', 'sec-review']), 'sprint'), 'sprint sprint-31')
  })
})
