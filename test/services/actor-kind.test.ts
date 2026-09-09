// SPDX-License-Identifier: Apache-2.0
// `help` says `TREADLE_ACTOR_KIND=human|agent`, and every other value was recorded as
// `human` in silence: `robot` and `AGENT` both landed there. `actor_kind` is the field the
// purpose statement's "user-agent interactions" is read from, and a wrong value in a
// committed, append-only log is the same class of defect as an actor with a control
// character in it, which this tool has always refused.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { actorKindRefusal } from '../../src/application/services/mutation.ts'
import { runCli } from '../helpers/cli-run.ts'

describe('the actor kind a mutation records', () => {
  let root: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadle-actor-kind-'))
    const init = await runCli(['init'], { cwd: root, env: { TREADLE_ACTOR: 'kim' } })
    assert.equal(init.code, 0, init.err)
    const filed = await runCli(['file', 'task', 'A task', '--id', 'a-task'], { cwd: root, env: { TREADLE_ACTOR: 'kim' } })
    assert.equal(filed.code, 0, filed.err)
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('takes the two words help names, and nothing else', () => {
    assert.equal(actorKindRefusal(undefined), undefined)
    assert.equal(actorKindRefusal('human'), undefined)
    assert.equal(actorKindRefusal('agent'), undefined)
    assert.equal(actorKindRefusal('robot'), 'TREADLE_ACTOR_KIND is "robot", and an actor kind is human or agent')
    assert.equal(actorKindRefusal('AGENT'), 'TREADLE_ACTOR_KIND is "AGENT", and an actor kind is human or agent')
  })

  // The value comes from the environment, so it is as unbounded and as unsafe as an actor's
  // own name: a refusal that echoed it whole would print megabytes, and one that echoed a
  // newline would forge a line of the tool's own grammar (F2).
  it('names the token only where it is bounded and safe to print back', () => {
    assert.equal(actorKindRefusal('x'.repeat(5000)), 'TREADLE_ACTOR_KIND is 5000 characters, and an actor kind is human or agent')
    assert.equal(actorKindRefusal('age\nnt'), 'TREADLE_ACTOR_KIND is 6 characters, and an actor kind is human or agent')
    assert.equal(actorKindRefusal(''), 'TREADLE_ACTOR_KIND is "", and an actor kind is human or agent')
  })

  it('refuses a mutation whose kind is neither word, naming the token and the export', async () => {
    for (const kind of ['robot', 'AGENT', 'Human', '']) {
      const run = await runCli(['set', 'a-task', 'assignee=zed'], {
        cwd: root, env: { TREADLE_ACTOR: 'kim', TREADLE_ACTOR_KIND: kind },
      })
      assert.equal(run.code, 2, `${kind}: ${run.out}${run.err}`)
      assert.match(run.err, new RegExp(`^"cause TREADLE_ACTOR_KIND is "${kind}", and an actor kind is human or agent$`, 'm'))
      assert.match(run.err, /^fix export TREADLE_ACTOR_KIND=agent$/m)
    }
  })

  it('records the value a caller wrote, and nothing was silently written meanwhile', async () => {
    const agent = await runCli(['set', 'a-task', 'assignee=yves'], {
      cwd: root, env: { TREADLE_ACTOR: 'kim', TREADLE_ACTOR_KIND: 'agent' },
    })
    assert.equal(agent.code, 0, agent.err)
    const log = await runCli(['history', 'a-task', '--limit', '5'], { cwd: root, env: { TREADLE_ACTOR: 'kim' } })
    assert.match(log.out, /^\S+ agent item\.set assignee=\(unset\)->yves kim$/m)
    assert.equal(/ item\.set assignee=\(unset\)->zed /.test(log.out), false,
      'the refused kinds wrote nothing')
  })

  // A read never records the kind, so it is not held to it, which is the same scoping the
  // actor bound has carried since it was added.
  it('leaves a read alone', async () => {
    const run = await runCli(['show', 'a-task'], { cwd: root, env: { TREADLE_ACTOR: 'kim', TREADLE_ACTOR_KIND: 'robot' } })
    assert.equal(run.code, 0, run.err)
  })
})

// The other half of the same rule, and the one that had no refusal at all: a mutation with
// neither variable nor flag recorded the literal `unknown`, which `history` then printed as
// `by unknown` for ever. On a tool whose product is who-did-what that is worse than recording
// nothing, because it looks like a fact and is an absence, and no read can tell it from an
// actor really called that. The refusal names both lines that supply an actor, so it is
// answered without asking anyone.
describe('a mutation that names nobody', () => {
  let root: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadle-actor-named-'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  const bare = (argv: readonly string[], env: Readonly<Record<string, string>> = {}) =>
    runCli(argv, { cwd: root, env })

  it('refuses the first write of all, so no workspace is created under nobody', async () => {
    const init = await bare(['init'])
    assert.equal(init.code, 2, init.out)
    assert.match(init.err, /^"cause init records who made the change, and neither TREADLE_ACTOR nor --actor names anyone/m, init.err)
    assert.match(init.err, /^fix export TREADLE_ACTOR=<your-name>$/m, init.err)
    assert.match(init.err, /^fix treadle --actor <name>$/m, init.err)
  })

  it('takes either line that supplies one, and records the name it was given', async () => {
    assert.equal((await bare(['init'], { TREADLE_ACTOR: 'kim' })).code, 0)
    const filed = await bare(['file', 'task', 'A task', '--id', 'named-task'], { TREADLE_ACTOR: 'kim' })
    assert.equal(filed.code, 0, filed.err)
    const flagged = await bare(['file', 'task', 'Another', '--id', 'flagged-task', '--actor', 'ravi'])
    assert.equal(flagged.code, 0, flagged.err)
    const log = await bare(['history', 'flagged-task'], { TREADLE_ACTOR: 'kim' })
    assert.match(log.out, /ravi$/m, log.out)
  })

  // A variable set to nothing names nobody exactly as an unset one does, and it is what a CI
  // job produces from an unpopulated secret. Left as a value it earned the whitespace
  // sentence, whose fix line named the flag and never the variable that was empty.
  for (const [what, value] of [['empty', ''], ['blank', '   ']] as const) {
    it(`treats an ${what} TREADLE_ACTOR as naming nobody, not as a malformed name`, async () => {
      const run = await bare(['file', 'task', 'X', '--id', `x-${what}`], { TREADLE_ACTOR: value })
      assert.equal(run.code, 2, run.out)
      assert.match(run.err, /^fix export TREADLE_ACTOR=<your-name>$/m, run.err)
    })
  }

  it('lets the flag win over an empty variable, which is the line a caller reaches for', async () => {
    const run = await bare(['file', 'task', 'Y', '--id', 'y-flagged', '--actor', 'dana'], { TREADLE_ACTOR: '' })
    assert.equal(run.code, 0, run.err)
  })

  // `--dry-run` reports the exit status the real run would return, so a line that could not
  // record is refused there too rather than reporting a write that would not have landed.
  it('refuses a dry run, which reports what the real line would do', async () => {
    const run = await bare(['transition', 'named-task', 'ready', '--dry-run'])
    assert.equal(run.code, 2, run.out)
    assert.match(run.err, /^"cause transition records who made the change/m, run.err)
  })

  // `config` is one word over a read and a write (ADR-0026). The bare read records nothing, so
  // demanding an identity for it would refuse a read over a field it would never store.
  it('leaves the read half of config alone and refuses the write half', async () => {
    const read = await bare(['config'])
    assert.equal(read.code, 0, read.err)
    const write = await bare(['config', 'set', 'review_step', 'story'])
    assert.equal(write.code, 2, write.out)
    assert.match(write.err, /^"cause config records who made the change/m, write.err)
  })

  it('leaves every read alone, which is what the inventory already verdicts --actor as', async () => {
    for (const argv of [['backlog'], ['next'], ['status'], ['doctor'], ['show', 'named-task'], ['explain', 'named-task']]) {
      const run = await bare(argv)
      assert.notEqual(run.code, 2, `${argv[0] as string} demanded an actor for a read: ${run.err}`)
    }
  })
})
