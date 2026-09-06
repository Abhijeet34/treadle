// SPDX-License-Identifier: Apache-2.0
// A parent edge is held to the hierarchy's three rules where it is written, and a stored
// field can be cleared by the command that wrote it.
//
// `setParent` carried the disallowed pair, the cycle and the unknown parent from the start,
// docs/DOMAIN.md said it refused all three, and no command called it: `set draft-task
// parent_id=draft-task` exited 0 and `doctor` then reported the cycle as S12, the finding for
// a hand edit, while `file --parent nope` was reported by nothing at all. The self-parent could
// not be undone either, because `parent_id=` was refused as not a slug, so a wrong parent was
// permanent through the tool. Both halves are here because the second is what makes the first
// recoverable.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runCli, type Run } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' }

type Data = Record<string, unknown>

function dataOf(run: Run): Data {
  const text = run.out.length > 0 ? run.out : run.err
  return (JSON.parse(text) as { data: Data }).data
}

describe('a parent edge is held to the hierarchy rules where it is written', () => {
  let dir: string
  const cli = (argv: readonly string[]): Promise<Run> => runCli([...argv, '--out', 'json'], { cwd: dir, env: ENV })
  const must = async (argv: readonly string[]): Promise<Run> => {
    const run = await cli(argv)
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.err}`)
    return run
  }
  const parentOf = async (id: string): Promise<unknown> => dataOf(await must(['show', id]))['parent']
  const held = async (): Promise<number> => (dataOf(await must(['status']))['items'] as number)

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'treadle-parent-'))
    await must(['init', '--name', 'parents'])
    await must(['file', 'epic', 'Epic one', '--id', 'epic-one', '--set', 'outcome=tenants sign in'])
    await must(['file', 'story', 'Child story', '--id', 'child-story', '--parent', 'epic-one'])
    await must(['file', 'task', 'Draft task', '--id', 'draft-task'])
    await must(['file', 'task', 'Spare task', '--id', 'spare-task'])
    await must(['file', 'bug', 'Bug cold', '--id', 'bug-cold', '--set', 'severity=S1', '--set', 'repro_steps=reload', '--set', 'found_in=test'])
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('refuses a self-parent as P2, writes nothing, and doctor stays clean', async () => {
    const run = await cli(['set', 'draft-task', 'parent_id=draft-task'])
    assert.equal(run.code, 3, run.err)
    const data = dataOf(run)
    assert.equal(data['rule'], 'P2')
    assert.equal(data['cause'], 'draft-task cannot be its own parent')
    assert.deepEqual(data['fix'], ['treadle backlog --type epic', 'treadle backlog --type story', 'treadle backlog --type spike'])
    assert.equal(await parentOf('draft-task'), undefined)
    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 0, doctor.err)
  })

  it('refuses an epic under its own child by the pair, before any cycle could close', async () => {
    const run = await cli(['set', 'epic-one', 'parent_id=child-story'])
    assert.equal(run.code, 3, run.err)
    const data = dataOf(run)
    assert.equal(data['rule'], 'P1')
    assert.equal(data['cause'], 'a story cannot be the parent of an epic')
    // Nothing may parent an epic, so the one line left is the item itself.
    assert.deepEqual(data['fix'], ['treadle show epic-one'])
    assert.equal(await parentOf('epic-one'), undefined)
  })

  it('refuses a task under a task, listing the types that may parent it', async () => {
    const run = await cli(['set', 'draft-task', 'parent_id=spare-task'])
    assert.equal(run.code, 3, run.err)
    const data = dataOf(run)
    assert.equal(data['rule'], 'P1')
    assert.equal(data['cause'], 'a task cannot be the parent of a task')
    assert.deepEqual(data['fix'], ['treadle backlog --type epic', 'treadle backlog --type story', 'treadle backlog --type spike'])
  })

  it('refuses a parent naming no record as NOT_FOUND, with the nearest ids beside it', async () => {
    const run = await cli(['set', 'draft-task', 'parent_id=epic-on'])
    assert.equal(run.code, 5, run.err)
    const data = dataOf(run)
    assert.equal(data['rule'], 'P4')
    assert.equal(data['cause'], 'epic-on is not an item in this workspace')
    assert.deepEqual(data['near'], ['epic-one'])
    assert.equal(await parentOf('draft-task'), undefined)
  })

  it('holds file --parent to the same rules and files nothing on a refusal', async () => {
    const before = await held()
    const dangling = await cli(['file', 'task', 'Under nothing', '--parent', 'nope'])
    assert.equal(dangling.code, 5, dangling.err)
    assert.equal(dataOf(dangling)['rule'], 'P4')
    const pair = await cli(['file', 'task', 'Under a task', '--parent', 'spare-task'])
    assert.equal(pair.code, 3, pair.err)
    assert.equal(dataOf(pair)['cause'], 'a task cannot be the parent of a task')
    assert.equal(await held(), before)
    const filed = await must(['file', 'task', 'Under the epic', '--id', 'under-epic', '--parent', 'epic-one'])
    assert.ok((dataOf(filed)['set'] as string[]).includes('parent_id - -> epic-one'))
  })

  it('refuses an edge that closes a cycle through one a hand edit left in the file', async () => {
    // No pair in the table can form a cycle on its own, so the bad edge has to come from
    // outside a write: the epic is put under a task by editing the shard, as a merge would.
    const shard = path.join(dir, '.work', 'items', '2026-09.md')
    const text = await readFile(shard, 'utf8')
    const edited = text.replace(/(# epic-one: Epic one\n\ntype: epic\nstate: draft\nfiled_at: [^\n]+\nversion: \d+\n)/, '$1parent_id: spare-task\n')
    assert.notEqual(edited, text, 'the epic section was not found where the hand edit expects it')
    await writeFile(shard, edited)
    await rm(path.join(dir, '.work', '.index'), { recursive: true, force: true })

    const run = await cli(['set', 'spare-task', 'parent_id=epic-one'])
    assert.equal(run.code, 3, run.err)
    const data = dataOf(run)
    assert.equal(data['rule'], 'P2')
    assert.equal(data['cause'], 'making epic-one the parent of spare-task closes a cycle through epic-one -> spare-task')
    assert.equal(await parentOf('spare-task'), undefined)

    await writeFile(shard, text)
    await rm(path.join(dir, '.work', '.index'), { recursive: true, force: true })
  })

  it('a dry run refuses the same edge, and a legal parent it accepts is not written', async () => {
    const refused = await cli(['set', 'draft-task', 'parent_id=draft-task', '--dry-run'])
    assert.equal(refused.code, 3, refused.err)
    assert.equal(dataOf(refused)['rule'], 'P2')
    const dry = await must(['set', 'draft-task', 'parent_id=epic-one', '--dry-run'])
    assert.equal(dataOf(dry)['dry_run'], 1)
    assert.equal(await parentOf('draft-task'), undefined)
  })
})

describe('a stored field is cleared by an empty value', () => {
  let dir: string
  const cli = (argv: readonly string[]): Promise<Run> => runCli([...argv, '--out', 'json'], { cwd: dir, env: ENV })
  const must = async (argv: readonly string[]): Promise<Run> => {
    const run = await cli(argv)
    assert.equal(run.code, 0, `${argv.join(' ')}: ${run.err}`)
    return run
  }

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'treadle-clear-'))
    await must(['init', '--name', 'clearing'])
    await must(['file', 'epic', 'Epic one', '--id', 'epic-one', '--set', 'outcome=tenants sign in'])
    await must(['file', 'task', 'Draft task', '--id', 'draft-task'])
    await must(['file', 'bug', 'Bug cold', '--id', 'bug-cold', '--set', 'severity=S1', '--set', 'repro_steps=reload', '--set', 'found_in=test'])
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('clears a wrong parent, and the other clearable fields, in one write that history records as unset', async () => {
    await must(['set', 'draft-task', 'parent_id=epic-one', 'assignee=kim', 'due=2030-01-01T00:00:00Z', 'labels=a-1,b-2', 'description=two lines\nlong'])
    const cleared = await must(['set', 'draft-task', 'parent_id=', 'assignee=', 'due=', 'labels=', 'description='])
    assert.deepEqual(dataOf(cleared)['set'], [
      'description 14 chars -> -',
      'parent_id epic-one -> -',
      'assignee kim -> -',
      'labels a-1,b-2 -> -',
      'due 2030-01-01T00:00:00Z -> -',
    ])
    const shown = dataOf(await must(['show', 'draft-task']))
    for (const field of ['parent', 'assignee', 'due', 'labels', 'desc']) {
      assert.equal(shown[field], undefined, `${field} is still set`)
    }
    const again = await must(['set', 'draft-task', 'parent_id='])
    assert.equal(dataOf(again)['already'], 'draft-task', 'clearing a field that is not set is a no-op, not a write')
    const log = dataOf(await must(['history', 'draft-task']))
    const rows = (log['events'] as { rows: { what: string }[] }).rows
    assert.equal(rows[0]?.what, 'description=(text:14)->(unset),parent_id=epic-one->(unset),assignee=kim->(unset),labels=a-1,b-2->(unset),due=2030-01-01T00:00:00Z->(unset)')
    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 0, doctor.err)
  })

  it('refuses to clear title and a field the type requires, naming the write that fills it', async () => {
    const title = await cli(['set', 'draft-task', 'title='])
    assert.equal(title.code, 2, title.err)
    assert.equal(dataOf(title)['cause'], 'title cannot be cleared; a task needs it')
    assert.deepEqual(dataOf(title)['fix'], ['treadle set draft-task title=<value>'])
    const repro = await cli(['set', 'bug-cold', 'repro_steps='])
    assert.equal(repro.code, 2, repro.err)
    assert.equal(dataOf(repro)['cause'], 'repro_steps cannot be cleared; a bug needs it')
    assert.deepEqual(dataOf(repro)['fix'], ['treadle set bug-cold repro_steps=<value>'])
    // A field another command owns is refused as that command's, whatever the value.
    const severity = await cli(['set', 'bug-cold', 'severity='])
    assert.equal(severity.code, 2, severity.err)
    assert.equal(dataOf(severity)['rule'], 'V5')
    const shown = dataOf(await must(['show', 'bug-cold']))
    assert.equal(shown['title'], 'Bug cold')
    assert.equal(shown['sev'], 'S1')
  })

  it('file reads an empty value as the field left unset', async () => {
    const filed = await must(['file', 'task', 'Nobody', '--id', 'nobody', '--set', 'assignee=', '--set', 'labels='])
    const set = dataOf(filed)['set'] as string[]
    assert.deepEqual(set.filter((line) => /^(assignee|labels) /.test(line)), [], set.join('\n'))
    const shown = dataOf(await must(['show', 'nobody']))
    assert.equal(shown['assignee'], undefined)
    const required = await cli(['file', 'bug', 'Warm', '--set', 'severity=', '--set', 'repro_steps=x', '--set', 'found_in=test'])
    assert.equal(required.code, 2, required.err)
    assert.equal(dataOf(required)['cause'], 'a bug needs severity at creation')
  })

  it('help set says how a field is cleared and which refuse', async () => {
    const help = await must(['help', 'set'])
    const examples = dataOf(help)['example'] as string[]
    assert.ok(examples.some((line) => /parent_id= .*# an empty value clears a field; title and the fields the type requires at creation refuse it$/.test(line)), examples.join('\n'))
  })
})
