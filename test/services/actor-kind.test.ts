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
    assert.equal(actorKindRefusal('robot'), 'TREADLE_ACTOR_KIND is robot, and an actor kind is human or agent')
    assert.equal(actorKindRefusal('AGENT'), 'TREADLE_ACTOR_KIND is AGENT, and an actor kind is human or agent')
  })

  it('refuses a mutation whose kind is neither word, naming the token and the export', async () => {
    for (const kind of ['robot', 'AGENT', 'Human', '']) {
      const run = await runCli(['set', 'a-task', 'assignee=zed'], {
        cwd: root, env: { TREADLE_ACTOR: 'kim', TREADLE_ACTOR_KIND: kind },
      })
      assert.equal(run.code, 2, `${kind}: ${run.out}${run.err}`)
      assert.match(run.err, new RegExp(`^"cause TREADLE_ACTOR_KIND is ${kind}, and an actor kind is human or agent$`, 'm'))
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
