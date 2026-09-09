// SPDX-License-Identifier: Apache-2.0
// An epic groups work and is never the work. It keeps the record it earns and loses the
// ceremony it does not.
//
// What this pins, and why each half is here. An epic marched `ready`, `in_progress`,
// `in_review` and was refused at `done` for lacking a reviewer and evidence: three writes
// and a refusal that recorded nothing about work its children had already finished, because
// a container has no reviewer and no artefact to accept. And `next` ranked the container
// first while the story beneath it was the thing to pick up, because `next` had no notion of
// type at all, so the dispatch read pointed an agent at the wrong record.
//
// What stays is the record: `G8` still refuses an epic reaching `done` while a child is open
// and `DOR8` still refuses grooming one with no child story. Closing an effort is a recorded
// statement the tool holds to the parts being finished, which is a fact about the work and
// not a computation over it.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { defaultConfig } from '../../src/domain/index.ts'
import { runCli, type Run } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' }

type Data = Record<string, unknown>
type Block = { readonly rows: readonly Record<string, unknown>[] }

function dataOf(run: Run): Data {
  const text = run.out.length > 0 ? run.out : run.err
  return (JSON.parse(text) as { data: Data }).data
}

function ids(block: unknown): readonly string[] {
  return (block as Block).rows.map((row) => String(row['id']))
}

describe('an epic keeps its record and loses its ceremony', () => {
  let dir: string
  const cli = (argv: readonly string[]): Promise<Run> => runCli([...argv, '--out', 'json'], { cwd: dir, env: ENV })
  const must = async (argv: readonly string[]): Promise<Run> => {
    const run = await cli(argv)
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.err}`)
    return run
  }

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'treadle-epic-'))
    await must(['init', '--name', 'efforts'])
    await must(['file', 'epic', 'Ship the record', '--id', 'ship-it', '--set', 'outcome=the record ships'])
    await must(['file', 'story', 'Write the shard', '--id', 'write-shard', '--parent', 'ship-it',
      '--set', 'acceptance_criteria=[ ] it parses'])
    await must(['file', 'task', 'Wire the codec', '--id', 'wire-codec', '--parent', 'ship-it'])
    for (const id of ['ship-it', 'write-shard', 'wire-codec']) await must(['transition', id, 'ready'])
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('leaves epic out of the compiled-in review step, so no workspace has to configure it away', () => {
    assert.deepEqual([...defaultConfig().review_step], ['story', 'bug'])
  })

  it('ranks the children and never the container that holds them', async () => {
    const next = dataOf(await must(['next']))
    assert.deepEqual(ids(next['next']), ['wire-codec', 'write-shard'])
  })

  it('says the type, not the rank, when asked why the epic is absent from next', async () => {
    const next = dataOf(await must(['next', '--explain-absence', 'ship-it']))
    assert.equal(next['absent'], 'ship-it')
    assert.equal(next['clause'], 'type epic; a container is never the thing to pick up, its children are')
  })

  it('leaves the epic out of the next block status prints from the same ranking', async () => {
    const status = dataOf(await must(['status']))
    assert.deepEqual(ids(status['next']), ['wire-codec', 'write-shard'])
  })

  it('refuses the epic the review step and names the exit it does have', async () => {
    await must(['transition', 'ship-it', 'in_progress'])
    const refused = await cli(['transition', 'ship-it', 'in_review'])
    assert.equal(refused.code, 3, refused.out)
    const data = dataOf(refused)
    assert.equal(data['guard'], 'G5')
    assert.equal(data['cause'], 'an epic has no review step, so in_progress exits through done')
    assert.deepEqual(data['fix'], ['treadle transition ship-it done', 'treadle explain ship-it'])
  })

  it('still refuses the epic done while a child is open, which is G8 and stays', async () => {
    const refused = await cli(['transition', 'ship-it', 'done'])
    assert.equal(refused.code, 3, refused.out)
    const cause = String(dataOf(refused)['cause'])
    assert.match(cause, /the epic still has open children: wire-codec, write-shard/)
  })

  it('closes the epic once the parts are done, with no reviewer and no evidence of its own', async () => {
    for (const id of ['write-shard', 'wire-codec']) {
      await must(['transition', id, 'in_progress'])
      if (id === 'write-shard') {
        await must(['set', id, 'acceptance_criteria=[x] it parses', 'reviewer=kim'])
        await must(['evidence', 'add', id, 'commit', 'abc1234'])
        await must(['transition', id, 'in_review'])
        await must(['transition', id, 'done', '--actor', 'kim'])
      } else {
        await must(['transition', id, 'done'])
      }
    }
    const done = await must(['transition', 'ship-it', 'done'])
    assert.equal(dataOf(done)['state'], 'in_progress -> done')
    const shown = dataOf(await must(['show', 'ship-it']))
    assert.equal(shown['reviewer'], undefined)
  })

  it('lets an epic a past workspace left in in_review finish, so no stored record is stranded', async () => {
    // The migration case, driven rather than hand-written so the log agrees with the record:
    // the workspace configures the review step epics used to have, an epic reaches in_review
    // under it, and the setting then moves to what this build compiles in. `accept` is an
    // edge out of in_review for every type, so the record still has its exit.
    await must(['config', 'set', 'review_step', 'story, bug, epic'])
    await must(['file', 'epic', 'Older effort', '--id', 'older-effort', '--set', 'outcome=it lands'])
    await must(['file', 'story', 'Its story', '--id', 'its-story', '--parent', 'older-effort',
      '--set', 'acceptance_criteria=[x] done'])
    await must(['transition', 'older-effort', 'ready'])
    await must(['transition', 'older-effort', 'in_progress'])
    await must(['transition', 'older-effort', 'in_review'])
    await must(['config', 'set', 'review_step', 'story, bug'])

    const shown = dataOf(await must(['show', 'older-effort']))
    assert.equal(shown['state'], 'in_review')
    // G8 and DOD1 still hold over the stranded record, so the one child is closed first.
    await must(['transition', 'its-story', 'cancelled', '--resolution', 'wont_do', '--reason', 'not needed'])
    const accepted = await must(['transition', 'older-effort', 'done'])
    assert.equal(dataOf(accepted)['state'], 'in_review -> done')
  })

  it('still refuses to groom an epic with no child story, which is DOR8 and stays', async () => {
    await must(['file', 'epic', 'Empty effort', '--id', 'empty-effort', '--set', 'outcome=nothing yet'])
    const refused = await cli(['transition', 'empty-effort', 'ready'])
    assert.equal(refused.code, 3, refused.out)
    assert.match(String(dataOf(refused)['cause']), /DOR8/)
  })
})
