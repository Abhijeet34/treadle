// SPDX-License-Identifier: Apache-2.0
// The other half of the removal race: a `parent_id` naming a record the store does not hold.
//
// The store now refuses to write one (`S17` and the parent half of `S10`), but a state no
// write path would accept still reaches the files by the routes D1 permits: a hand edit, a
// git merge, an older build, a crash between two writes. `doctor` reported clean over one,
// which is worse than the dangling reference itself, because the tool's own health check was
// silent about a record every read then answered from as if the parent were there. `H24`
// covers a relation's target; `H30` is the same rule for a parent.
//
// The quarantine case is here for the reason round five's is: a record the store holds and
// refuses to serve still exists, so a child pointing at it is not dangling.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' } as const

type Cli = (argv: readonly string[]) => Promise<{ code: number; out: string; err: string }>

const shardOf = (root: string): string =>
  path.join(root, '.work', 'items', `${new Date().toISOString().slice(0, 7)}.md`)

async function edit(file: string, change: (text: string) => string): Promise<void> {
  await writeFile(file, change(await readFile(file, 'utf8')))
}

/** The record whose heading names `id`, dropped from the file the way a hand edit drops one. */
function withoutRecord(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`# ${id}:`))
  assert.notEqual(start, -1, `${id} is not a record in this file`)
  let end = start + 1
  while (end < lines.length && !lines[end]?.startsWith('# ')) end += 1
  lines.splice(start, end - start)
  return lines.join('\n')
}

describe('a parent_id naming a record the store does not hold', () => {
  let root: string
  let cli: Cli
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadle-parent-'))
    cli = (argv) => runCli(argv, { cwd: root, env: ENV })
    assert.equal((await cli(['init'])).code, 0)
    assert.equal((await cli(['file', 'story', 'A parent story', '--id', 'parent-story'])).code, 0)
    assert.equal((await cli(['file', 'task', 'A child task', '--id', 'child-task', '--parent', 'parent-story'])).code, 0)
    await edit(shardOf(root), (text) => withoutRecord(text, 'parent-story'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('is a finding rather than a clean report, and the detail names the line that clears it', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.match(run.out, /^H30 child-task parent_id /m, run.out)
    assert.match(run.out, /parent_id names parent-story and no record here carries that id; treadle set child-task parent_id= drops it/, run.out)
  })

  it('is the same finding on explain, which audits one item off the records it already reads', async () => {
    const run = await cli(['explain', 'child-task'])
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /^H30 /m, run.out)
  })

  // The store refuses to create this state, so no transaction can reach it and the
  // conformance suite cannot build it; a hand edit can, and every write to the record after
  // it would be refused if the rule watched the reference rather than the write that
  // introduces one - including `set <child> parent_id=`, which is the remedy H30 prints.
  // `--dry-run` asks the overlay store the same question, so both implementations answer here.
  it('does not stop the record being edited, which the remedy itself is a write to', async () => {
    const dry = await cli(['set', 'child-task', 'assignee=kim', '--dry-run'])
    assert.equal(dry.code, 0, dry.err)
    const edit = await cli(['set', 'child-task', 'assignee=kim'])
    assert.equal(edit.code, 0, edit.err)
    const still = await cli(['doctor'])
    assert.match(still.out, /^H30 child-task parent_id /m, 'the finding survives an unrelated edit')
  })

  it('is cleared by the line the detail names, and doctor is clean after it', async () => {
    assert.equal((await cli(['set', 'child-task', 'parent_id='])).code, 0)
    const run = await cli(['doctor'])
    assert.equal(run.code, 0, run.out)
    assert.doesNotMatch(run.out, /^H30 /m)
  })
})

describe('a child of a quarantined parent', () => {
  let root: string
  let cli: Cli
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadle-parent-q-'))
    cli = (argv) => runCli(argv, { cwd: root, env: ENV })
    assert.equal((await cli(['init'])).code, 0)
    assert.equal((await cli(['file', 'story', 'A parent story', '--id', 'parent-story'])).code, 0)
    assert.equal((await cli(['file', 'task', 'A child task', '--id', 'child-task', '--parent', 'parent-story'])).code, 0)
    // A value no write path produces, on the parent, so the store holds the record and
    // refuses to serve it.
    await edit(shardOf(root), (text) => text.replace(/^type: story$/m, 'type: story\npriority: -3'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('raises no H30, because a record does carry that id two rows up', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 7, run.out)
    assert.match(run.out, /^S\d+ parent-story /m, run.out)
    assert.doesNotMatch(run.out, /^H30 /m, 'the parent is held and not served, which is not the same as absent')
  })
})
