// SPDX-License-Identifier: Apache-2.0
// ADR-0003 rule 7 at the command surface: a record the store holds and does not serve never
// silently changes which records a command sees. The store keeps that promise by quarantining
// the record and reporting a finding; `readWorkspace` keeps it for every command by refusing
// the view, so the property is held once rather than per command.
//
// The first fix held it on the single-item path alone: `show` looked an absent id up in the
// findings and refused by name, while `backlog`, `status` and `next` counted what `list`
// served and printed the count as the truth, with exit 0. The reproduction is the ordinary
// one for a store committed to git: two branches file an item in the same month and the
// merge leaves its markers in the shard.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

const SHARD = path.join('items', '2026-09.md')

/** What `git merge` leaves in the shard when both sides filed an item this month. */
const CONFLICT = [
  '', '<<<<<<< HEAD', '# gamma: Gamma', 'type: task', '=======',
  '# delta: Delta', 'type: task', '>>>>>>> branch', '',
].join('\n')

async function append(demo: Demo, text: string): Promise<void> {
  const file = path.join(demo.root, SHARD)
  await writeFile(file, `${await readFile(file, 'utf8')}${text}`)
}

describe('a store holding a record it cannot serve refuses every answer over it', () => {
  let demo: Demo
  let held: number

  before(async () => {
    demo = await aDemoWorkspace()
    const clean = await runCli(['status'], { cwd: demo.root })
    held = Number(/^items (\d+)$/m.exec(clean.out)?.[1])
    assert.ok(held > 0, `the fixture reports no items: ${clean.out}`)
    await append(demo, CONFLICT)
  })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  // The markers land inside the last record's segment, so that record is quarantined with
  // the two half-records behind them: three findings, and the store serves held - 1 items.
  for (const argv of [['backlog'], ['status'], ['next'], ['show', 'theme-dark'], ['explain', 'auth-refresh'], ['history', 'auth-refresh']]) {
    it(`${argv.join(' ')} refuses with the file, the line and what the parser expected`, async () => {
      const run = await cli(argv)
      assert.equal(run.code, 7, `${argv.join(' ')} exited ${run.code}: ${run.out}${run.err}`)
      assert.equal(run.out, '', 'a refusal prints nothing to stdout')
      assert.match(run.err, /^err INTEGRITY /)
      assert.match(run.err, /^rule S1$/m)
      assert.match(run.err, /^entity theme-dark$/m, 'the first hidden record is named')
      assert.match(run.err, /"cause items\/2026-09\.md line \d+: line \d+: expected "<key>: <value>", a "## <section>" heading or a blank line; 3 findings hide records this workspace holds, so no answer over it is whole$/m)
      assert.match(run.err, /^fix treadle doctor$/m)
    })
  }

  it('refuses a write too, because a guard reads the same set and a new id is chosen against it', async () => {
    const filed = await cli(['file', 'task', 'Epsilon'])
    assert.equal(filed.code, 7, filed.out)
    assert.match(filed.err, /^err INTEGRITY /)
    const moved = await cli(['transition', 'csv-export', 'in_progress'])
    assert.equal(moved.code, 7, moved.out)
  })

  it('doctor is the one command that answers, with every finding, and exits 7 for them', async () => {
    const run = await cli(['doctor'])
    assert.equal(run.code, 7)
    assert.match(run.out, /^ok doctor /, 'the table is the answer and stays on stdout')
    assert.equal(run.err, '')
    assert.match(run.out, /^~findings 3 3$/m)
    assert.match(run.out, /^S1 theme-dark items\/2026-09\.md:\d+ /m)
    assert.match(run.out, /^S1 gamma items\/2026-09\.md:\d+ /m)
    assert.match(run.out, /^S1 delta items\/2026-09\.md:\d+ /m)
    assert.doesNotMatch(run.out, /^clean /m)
  })

  it('names both exit statuses in its help', async () => {
    const help = await cli(['help', 'doctor'])
    assert.match(help.out, /^exit 0 clean: /m)
    assert.match(help.out, /^exit 7 the findings table is not empty; /m)
  })

  it('serves everything again once the markers are resolved, and doctor exits 0 saying so', async () => {
    const file = path.join(demo.root, SHARD)
    const text = await readFile(file, 'utf8')
    assert.ok(text.endsWith(CONFLICT))
    await writeFile(file, text.slice(0, -CONFLICT.length))

    const state = await cli(['status'])
    assert.equal(state.code, 0, state.err)
    assert.match(state.out, new RegExp(`^items ${held}$`, 'm'))
    const clean = await cli(['doctor'])
    assert.equal(clean.code, 0, clean.out)
    assert.match(clean.out, new RegExp(`^clean checked ${held} items and \\d+ events$`, 'm'))
  })
})

describe('a finding with no id hides records too', () => {
  let demo: Demo

  before(async () => {
    demo = await aDemoWorkspace()
    const file = path.join(demo.root, SHARD)
    // A shard whose first line is not its schema line is not served at all, and the finding
    // names the file rather than any record. A lookup by id could never have seen it.
    await writeFile(file, `# comment a merge tool added\n${await readFile(file, 'utf8')}`)
  })
  after(async () => { await demo.dispose() })

  it('refuses the read naming the file and line 1, with no entity', async () => {
    const run = await runCli(['backlog'], { cwd: demo.root })
    assert.equal(run.code, 7, run.out)
    assert.match(run.err, /"cause items\/2026-09\.md line 1: items\/2026-09\.md line 1 is not "schema: <n>", so it is not a record file this tool wrote; that finding hides a record this workspace holds, so no answer over it is whole$/m)
    assert.doesNotMatch(run.err, /^entity /m)
  })
})

describe('a count of one is singular', () => {
  it('on the not-found refusal and on the clean doctor line', async () => {
    const demo = await aDemoWorkspace()
    try {
      const file = path.join(demo.root, SHARD)
      // Keep one record in the month shard and drop the other month entirely.
      const text = await readFile(file, 'utf8')
      const first = text.indexOf('\n# ', text.indexOf('\n# ') + 1)
      await writeFile(file, text.slice(0, first + 1))
      await writeFile(path.join(demo.root, 'items', '2026-08.md'), 'schema: 1\n\n')

      const missing = await runCli(['show', 'nothing-here'], { cwd: demo.root })
      assert.match(missing.err, /this workspace holds 1 item$/m)
      const clean = await runCli(['doctor'], { cwd: demo.root })
      assert.equal(clean.code, 0, clean.out)
      assert.match(clean.out, /^clean checked 1 item and \d+ events$/m)
    } finally {
      await demo.dispose()
    }
  })
})
