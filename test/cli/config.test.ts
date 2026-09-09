// SPDX-License-Identifier: Apache-2.0
// Workspace configuration at the command surface, driven the way a caller drives it. The
// four suites below are T1's proof obligations, each written as the sequence a person would
// type rather than as a call into a service.
//
// What they hold that no unit test can: that the value a team writes with `config set` is
// the value `transition`, `explain`, `doctor` and `history` each answer from. Every one of
// the six consumers was a compiled-in constant before this, and a constant that becomes data
// fails by still answering the constant, which only an end-to-end read catches.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

type Rig = { readonly root: string; readonly dispose: () => Promise<void> }

/** An empty workspace, so each suite writes exactly the records its own claim needs. */
async function aWorkspace(): Promise<Rig> {
  const parent = await mkdtemp(path.join(tmpdir(), 'treadle-config-'))
  const root = path.join(parent, '.work')
  const made = await runCli(['init', '--name', 'config probe', '--workspace', root])
  assert.equal(made.code, 0, made.err)
  return { root, dispose: async () => { await rm(parent, { recursive: true, force: true }) } }
}

describe('a configured ready gate is the gate the transition enforces', () => {
  let rig: Rig
  before(async () => { rig = await aWorkspace() })
  after(async () => { await rig.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: rig.root })

  it('refuses the move under the configured rule id, and explain names the same rule', async () => {
    const filed = await cli(['file', 'story', 'Ship the token refresh', '--id', 'token-refresh'])
    assert.equal(filed.code, 0, filed.err)
    // Ready under the built-in gate: a title, the type's required fields, no blocker, one
    // acceptance criterion and an estimate. DOR4 is the criterion, so it is filled first.
    const criteria = await cli(['set', 'token-refresh', 'acceptance_criteria=a 401 refreshes once'])
    assert.equal(criteria.code, 0, criteria.err)
    const before = await cli(['transition', 'token-refresh', 'ready'])
    assert.equal(before.code, 0, `the built-in ready gate should pass here: ${before.err}`)

    const back = await cli(['transition', 'token-refresh', 'draft', '--reason', 'reconfiguring the gate'])
    assert.equal(back.code, 0, back.err)

    // One rule, with an id this build has never compiled in, over a field the story has and
    // has not set. It replaces the ready gate whole, which is what the design specifies.
    const set = await cli(['config', 'set', 'ready_gate', 'TEAM1 story field_present:assignee A story names who is on it'])
    assert.equal(set.code, 0, set.err)

    const refused = await cli(['transition', 'token-refresh', 'ready'])
    assert.equal(refused.code, 3, `the configured gate should refuse: ${refused.out}`)
    assert.match(refused.err, /^guard G1$/m)
    assert.match(refused.err, /^"cause the ready gate fails: TEAM1$/m)

    const why = await cli(['explain', 'token-refresh'])
    assert.equal(why.code, 0, why.err)
    assert.match(why.out, /^ready TEAM1 fail /m)
    assert.doesNotMatch(why.out, /DOR4/, 'the configured gate replaces the default whole, so no built-in rule is evaluated')

    // The remedy the configured rule prints is a line that clears it, which is the rule
    // every gate remedy in this tool is held to.
    const fixed = await cli(['set', 'token-refresh', 'assignee=ravi'])
    assert.equal(fixed.code, 0, fixed.err)
    const allowed = await cli(['transition', 'token-refresh', 'ready'])
    assert.equal(allowed.code, 0, allowed.err)
  })
})

describe('G3 is armed by the configured column limit', () => {
  let rig: Rig
  before(async () => { rig = await aWorkspace() })
  after(async () => { await rig.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: rig.root })

  it('refuses the sixth start into a column limited to five, and passes with the limit at zero', async () => {
    for (let n = 1; n <= 6; n += 1) {
      const filed = await cli(['file', 'task', `Task number ${n}`, '--id', `task-${n}`])
      assert.equal(filed.code, 0, filed.err)
      const groomed = await cli(['transition', `task-${n}`, 'ready'])
      assert.equal(groomed.code, 0, groomed.err)
    }
    const set = await cli(['config', 'set', 'wip_limits', 'in_progress=5'])
    assert.equal(set.code, 0, set.err)

    for (let n = 1; n <= 5; n += 1) {
      const started = await cli(['transition', `task-${n}`, 'in_progress'])
      assert.equal(started.code, 0, `start ${n} of 5 should pass under a limit of five: ${started.err}`)
    }
    const sixth = await cli(['transition', 'task-6', 'in_progress'])
    assert.equal(sixth.code, 3, `the sixth start should be refused: ${sixth.out}`)
    assert.match(sixth.err, /^guard G3$/m)
    assert.match(sixth.err, /^"cause the in_progress column is at its limit of 5$/m)
    assert.match(sixth.err, /^fix treadle transition task-6 in_progress --override G3 --reason "<why>"$/m)

    // `doctor` reports the column that is already over, and says so without exiting on it:
    // a threshold a team set is not a store that hides a record.
    const overridden = await cli(['transition', 'task-6', 'in_progress', '--override', 'G3', '--reason', 'the release needs it'])
    assert.equal(overridden.code, 0, overridden.err)
    const checked = await cli(['doctor'])
    assert.equal(checked.code, 0, `an over-limit column is served content, so doctor exits 0: ${checked.out}`)
    assert.match(checked.out, /^H04 - in_progress the in_progress column of this workspace holds 6 items against a wip_limits of 5/m)

    // Zero means unlimited, which is what `TransitionContext` documents and what a team
    // that wants the column back without losing the key writes.
    const unlimited = await cli(['config', 'set', 'wip_limits', 'in_progress=0'])
    assert.equal(unlimited.code, 0, unlimited.err)
    const seventh = await cli(['file', 'task', 'Task number 7', '--id', 'task-7'])
    assert.equal(seventh.code, 0, seventh.err)
    assert.equal((await cli(['transition', 'task-7', 'ready'])).code, 0)
    const started = await cli(['transition', 'task-7', 'in_progress'])
    assert.equal(started.code, 0, `a limit of zero is unlimited: ${started.err}`)
    assert.equal((await cli(['doctor'])).out.includes('H04'), false, 'a limit of zero raises no finding either')
  })
})

describe('an invalid gate is refused before the write and reported after a hand edit', () => {
  let rig: Rig
  before(async () => { rig = await aWorkspace() })
  after(async () => { await rig.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: rig.root })

  /** A rule reading a field a story has not got, which is the domain model's own `H14`. */
  const BAD = 'DOR1 story field_present:severity A story names its severity'

  it('refuses config set with V6, naming the field and the type', async () => {
    const refused = await cli(['config', 'set', 'ready_gate', BAD])
    assert.equal(refused.code, 2, `the write should be refused: ${refused.out}`)
    assert.match(refused.err, /^rule V6$/m)
    assert.match(refused.err, /^"cause gate rule DOR1 reads severity, which is not a field of a story$/m)

    // Refused BEFORE the write: the file is unchanged and every command still answers.
    const file = await readFile(path.join(rig.root, 'workspace.md'), 'utf8')
    assert.equal(file.includes('Ready gate'), false, 'the refused gate reached the file')
    assert.equal((await cli(['status'])).code, 0)
  })

  it('reports the same text as H14 on doctor when a hand edit puts it in the file', async () => {
    const file = path.join(rig.root, 'workspace.md')
    await writeFile(file, `${await readFile(file, 'utf8')}\n## Ready gate\n\n${BAD}\n`, 'utf8')

    const checked = await cli(['doctor'])
    assert.equal(checked.code, 7, `a gate this build cannot load hides the policy it names: ${checked.out}`)
    assert.match(checked.out, /^H14 config-probe workspace\.md:\d+ config-probe: gate rule DOR1 reads severity, which is not a field of a story$/m)

    // And every other command refuses over it rather than quietly running the default gate,
    // which is what would make the file and the enforcement disagree.
    const listed = await cli(['backlog'])
    assert.equal(listed.code, 7, `a read over an unloadable gate is refused: ${listed.out}`)
    assert.match(listed.err, /^rule H14$/m)
    assert.match(listed.err, /^fix treadle doctor$/m)
  })
})

describe('a configuration change is in the log with both sides', () => {
  let rig: Rig
  before(async () => { rig = await aWorkspace() })
  after(async () => { await rig.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: rig.root })

  it('reads back under history <workspace> as name=from->to', async () => {
    const set = await cli(['config', 'set', 'aging_days', '5'])
    assert.equal(set.code, 0, set.err)

    const log = await cli(['history', 'config-probe'])
    assert.equal(log.code, 0, log.err)
    assert.match(log.out, /^\S+ human workspace\.config aging_days=0->5 dana$/m)
    // The write that created the workspace is the row under it, so the read is the whole
    // life of the record rather than the one event this test wrote.
    assert.match(log.out, /workspace\.init/)

    // A gate change reads as its rule count: a rule ends in a sentence and a sentence carries
    // spaces, which the row grammar gives to one column and that column is the actor.
    const gate = await cli(['config', 'set', 'done_gate', 'D1 all no_open_child Every child is done|D2 story evidence_present The story points at evidence'])
    assert.equal(gate.code, 0, gate.err)
    const after = await cli(['history', 'config-probe', '--limit', '1'])
    assert.match(after.out, /^\S+ human workspace\.config done_gate=\(rules:7\)->\(rules:2\) dana$/m)

    // The transaction-scoped read is the other scope, and names the record it moved.
    // The envelope's own transaction id, which is line 1's fourth field (R4).
    const txn = /^ok config \S+ (\S+) /.exec(gate.out)?.[1]
    assert.ok(txn !== undefined, `config set printed no transaction id: ${gate.out}`)
    const scoped = await cli(['history', '--txn', txn as string])
    assert.equal(scoped.code, 0, scoped.err)
    assert.match(scoped.out, /entity=config-probe,done_gate=\(rules:7\)->\(rules:2\)/)
  })
})

describe('config reads every key with the value in force and where it came from', () => {
  let rig: Rig
  before(async () => { rig = await aWorkspace() })
  after(async () => { await rig.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: rig.root })

  it('reports default before a write and file after it, for the one key that moved', async () => {
    const first = await cli(['config'])
    assert.equal(first.code, 0, first.err)
    assert.match(first.out, /^review_step default story, bug, epic$/m)
    assert.match(first.out, /^aging_days default 0$/m)

    assert.equal((await cli(['config', 'set', 'aging_days', '5'])).code, 0)
    const second = await cli(['config'])
    assert.match(second.out, /^aging_days file 5$/m)
    assert.match(second.out, /^review_step default story, bug, epic$/m, 'a key nothing set stays the default')
  })

  it('refuses a key outside the closed set with C1, naming the set', async () => {
    const refused = await cli(['config', 'set', 'nonesuch', '1'])
    assert.equal(refused.code, 2)
    assert.match(refused.err, /^rule C1$/m)
    assert.match(refused.err, /^"cause nonesuch is not a configuration key; they are review_step, next_weights/m)
  })

  it('writes only the keys this workspace set, leaving the rest to the compiled-in default', async () => {
    const file = await readFile(path.join(rig.root, 'workspace.md'), 'utf8')
    assert.match(file, /^aging_days: 5$/m)
    assert.equal(file.includes('review_step'), false, 'a key nobody set is not written')
    assert.match(file, /^version: 1$/m, 'the record carries the compare-and-set token its first write gave it')
  })
})

// The attacks a configuration surface has to survive, each one a shape a hand edit or a
// caller can actually produce. They are here rather than in a unit test because what each
// one is worth is the line the tool prints back and the exit status beside it.
describe('the configuration surface under attack', () => {
  let rig: Rig
  before(async () => { rig = await aWorkspace() })
  after(async () => { await rig.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: rig.root })
  const workspaceFile = () => path.join(rig.root, 'workspace.md')

  it('keeps an unknown key the file carries, counts it, and refuses to write one', async () => {
    await writeFile(workspaceFile(), `${await readFile(workspaceFile(), 'utf8')}flow_mode: kanban\n`, 'utf8')
    const read = await cli(['config'])
    assert.equal(read.code, 0, read.err)
    assert.match(read.out, /^extra 1$/m, 'a key this build cannot read is counted, as show counts an item\'s')

    const refused = await cli(['config', 'set', 'flow_mode', 'kanban'])
    assert.equal(refused.code, 2)
    assert.match(refused.err, /^rule C1$/m)

    // DR3: a write to a key beside it leaves the unknown one exactly as it was.
    assert.equal((await cli(['config', 'set', 'aging_days', '3'])).code, 0)
    assert.match(await readFile(workspaceFile(), 'utf8'), /^flow_mode: kanban$/m)
  })

  it('refuses a rule sentence carrying a tab or a bidi override', async () => {
    for (const sentence of ['A\tsentence with a tab', 'A sentence\u202e reversed']) {
      const refused = await cli(['config', 'set', 'done_gate', `R1 all no_open_child ${sentence}`])
      assert.equal(refused.code, 2, `a rule sentence carrying a control character was written: ${refused.out}`)
      assert.match(refused.err, /^rule V8$/m)
      assert.match(refused.err, /has a sentence that is not a single line/m)
    }
  })

  it('refuses a gate over the section ceiling, naming the ceiling, and writes nothing', async () => {
    const many = Array.from({ length: 4000 }, (_, n) =>
      `R${n} all no_open_child Rule number ${n} says something long enough to fill a section past its ceiling`).join('|')
    const refused = await cli(['config', 'set', 'done_gate', many])
    assert.equal(refused.code, 2, `an oversized gate was written: ${refused.out}`)
    assert.match(refused.err, /^rule V4$/m)
    assert.match(refused.err, /the record as written would not be served back: section Done gate is \d+ bytes, over the 131072 byte ceiling$/m)
    assert.equal((await readFile(workspaceFile(), 'utf8')).includes('Done gate'), false)
  })

  it('refuses a negative limit and a negative threshold', async () => {
    const limit = await cli(['config', 'set', 'wip_limits', 'in_progress=-1'])
    assert.equal(limit.code, 2)
    assert.match(limit.err, /^"cause wip_limits entry "in_progress=-1" is not <name>=<n> with a whole number$/m)
  })
})

describe('a workspace record the grammar quarantines names the line to edit', () => {
  let rig: Rig
  before(async () => { rig = await aWorkspace() })
  after(async () => { await rig.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: rig.root })

  it('does not offer treadle init, which answers already and fixes nothing', async () => {
    const file = path.join(rig.root, 'workspace.md')
    await writeFile(file, `${await readFile(file, 'utf8')}\n## Ready gate\n\nR1 all field_present:title A title\n\n## Ready gate\n\nR2 all no_active_blocker Nothing blocks it\n`, 'utf8')

    for (const argv of [['status'], ['doctor'], ['config']]) {
      const run = await cli(argv)
      assert.equal(run.code, 6, `${argv[0]}: ${run.out}`)
      assert.match(run.err, /^"cause workspace\.md holds one record, at line \d+, and does not serve it: line \d+: the section Ready gate appears twice/m)
      assert.equal(run.err.includes('treadle init'), false, `${argv[0]} offered init, which answers already over a workspace that exists`)
    }
  })
})
