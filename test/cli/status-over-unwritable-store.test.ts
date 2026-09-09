// SPDX-License-Identifier: Apache-2.0
// `status` is the call an agent makes to ask what the state of this workspace is, and over a
// store where every write is refused it printed `items 3  findings 0` and exited 0. The
// memory was lying, which is the class this project spent two days removing, and the old fix
// lines pointed at `status` precisely because it looked like the place to check.
//
// So each cause is provoked here, three of them, and each is asserted twice: the write is
// really refused with the rule and the fix line PR #83 gave it, and `status` names the same
// condition with the same remedy while still answering the question it was asked. The pairing
// is the point. A test that only read `status` would pass over a condition that had stopped
// refusing writes, and one that only ran the write would not notice `status` going quiet.
//
// What `status` does NOT do is run the audit. `findings` counts what the store held and could
// not serve on the read it already performed, and `doctor` is still the command that reads
// every record against the event log; this asks a different question, which is whether the
// workspace can be written at all.

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { runCli, type Run } from '../helpers/cli-run.ts'
import { POSIX_MODES } from '../helpers/platform.ts'

const ENV = { TREADLE_ACTOR: 'dana' }

type Data = Record<string, unknown>

function dataOf(run: Run): Data {
  const text = run.out.length > 0 ? run.out : run.err
  return (JSON.parse(text) as { data: Data }).data
}

describe('status names a store no write can pass, and still answers', () => {
  const made: string[] = []

  /** A workspace holding one record, with the store root handed back. */
  async function workspace(): Promise<{ dir: string; store: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'treadle-unwritable-'))
    made.push(dir)
    const cli = (argv: readonly string[]): Promise<Run> => runCli([...argv, '--out', 'json'], { cwd: dir, env: ENV })
    assert.equal((await cli(['init', '--name', 'held'])).code, 0)
    assert.equal((await cli(['file', 'task', 'A task', '--id', 'a-task'])).code, 0)
    return { dir, store: path.join(dir, '.work') }
  }

  afterEach(async () => {
    for (const dir of made.splice(0)) {
      await chmod(path.join(dir, '.work', 'items'), 0o700).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  const cliIn = (dir: string) => (argv: readonly string[]): Promise<Run> =>
    runCli([...argv, '--out', 'json'], { cwd: dir, env: ENV })

  it('names a .txn file it did not write, and says deleting it clears the refusal', async () => {
    const { dir, store } = await workspace()
    const cli = cliIn(dir)
    await mkdir(path.join(store, '.txn'), { recursive: true })
    await writeFile(path.join(store, '.txn', 'stray.json'), '{"garbage":true}')

    const write = await cli(['file', 'task', 'Another task'])
    assert.equal(write.code, 6, write.out)
    const refusal = dataOf(write)
    assert.equal(refusal['rule'], 'S13')

    const status = await cli(['status'])
    assert.equal(status.code, 0, 'the read succeeded, so the exit is the one a successful read earns')
    const data = dataOf(status)
    assert.equal(data['items'], 1, 'the records are there and are still counted')
    assert.match(String(data['writes']), /^\.txn\/stray\.json is not a transaction journal this store wrote/)
    assert.deepEqual(data['fix'], refusal['fix'])
    assert.deepEqual(data['fix'], [
      'delete the .txn file named in cause; read it first, because the store will not discard it on a guess',
    ])
  })

  it('names a .txn entry it cannot read, with the remedy for an errno rather than for a stray file', async () => {
    const { dir, store } = await workspace()
    const cli = cliIn(dir)
    // A directory where a journal belongs: the read fails EISDIR, which is an errno and not a
    // file to delete, and PR #83 gave the two causes different fix lines for that reason.
    await mkdir(path.join(store, '.txn', 'wedged.json'), { recursive: true })

    const write = await cli(['file', 'task', 'Another task'])
    assert.equal(write.code, 6, write.out)
    const refusal = dataOf(write)
    assert.equal(refusal['rule'], 'S13')

    const status = await cli(['status'])
    assert.equal(status.code, 0)
    const data = dataOf(status)
    assert.match(String(data['writes']), /^\.txn\/wedged\.json could not be read/)
    assert.deepEqual(data['fix'], refusal['fix'])
    assert.deepEqual(data['fix'], [
      'make the path named in cause readable and writable by this user, and check its filesystem for space',
    ])
  })

  it('names a shard directory this user cannot write', { skip: POSIX_MODES }, async () => {
    const { dir, store } = await workspace()
    const cli = cliIn(dir)
    await chmod(path.join(store, 'items'), 0o500)

    const write = await cli(['file', 'task', 'Another task'])
    assert.equal(write.code, 6, write.out)

    const status = await cli(['status'])
    assert.equal(status.code, 0)
    const data = dataOf(status)
    assert.equal(data['items'], 1)
    assert.match(String(data['writes']), /^items cannot be written by this user/)
    assert.deepEqual(data['fix'], [
      'make the path named in cause readable and writable by this user, and check its filesystem for space',
    ])
  })

  it('says nothing about writes over a store a write can pass', async () => {
    const { dir } = await workspace()
    const cli = cliIn(dir)
    const status = await cli(['status'])
    assert.equal(status.code, 0)
    const data = dataOf(status)
    assert.equal(data['writes'], undefined, 'an absent condition is an absent line')
    assert.equal(data['fix'], undefined)
    assert.equal((await cli(['file', 'task', 'Another task'])).code, 0)
  })
})
