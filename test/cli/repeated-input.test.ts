// SPDX-License-Identifier: Apache-2.0
// The operand guard's repeated-input gaps: a line that says one thing twice was answered
// once, in silence.
//
// `backlog --state draft --state ready` listed the ready work and printed `filter state
// ready`; nothing said `draft` had been read and dropped. `backlog --fields id,id` printed
// the id column twice. Both are the fault the operand guard closes in a larger coat: the
// line carries two things, the tool can represent one, and it picked without a word.
//
// Refusal rather than a merge, in both places. What a caller means by two states is not
// knowable from the line - and, or and typo are all live readings - so a guess would be a
// silent winner with more steps. De-duplicating `--fields` would be that too: a repeat there
// is a caller counting columns wrong, and printing four where they wrote five moves every
// field after it.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { EXIT_OF } from '../../src/cli/exit.ts'
import { COMMAND_OPTIONS, GLOBAL_OPTIONS } from '../../src/cli/parse.ts'
import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' } as const

type Run = { code: number; out: string; err: string }
type Cli = (argv: readonly string[]) => Promise<Run>

function must(run: Run, what: string): Run {
  assert.equal(run.code, 0, `${what}: ${run.err}`)
  return run
}

async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-repeated-'))
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: root, env: ENV })
  must(await cli(['init', '--name', 'repeated']), 'init')
  must(await cli(['file', 'task', 'One thing', '--id', 'one-thing', '--label', 'ux', '--label', 'qa']), 'file')
  must(await cli(['file', 'story', 'Another thing', '--id', 'other-thing']), 'file')
  return { root, cli }
}

/** Every single-valued flag of the one filtering command, which is where G1 was measured. */
const SINGLE: readonly (readonly [string, string, string])[] = [
  ['state', 'draft', 'ready'],
  ['type', 'story', 'task'],
  ['assignee', 'kim', 'sam'],
  ['priority', '1', '2'],
  ['resolution', 'done', 'duplicate'],
  ['title', 'one', 'other'],
]

describe('a single-valued flag written twice is refused rather than resolved', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  for (const [name, first, second] of SINGLE) {
    it(`refuses --${name} twice on backlog`, async () => {
      for (const command of ['backlog']) {
        const run = await cli([command, `--${name}`, first, `--${name}`, second])
        assert.equal(run.code, EXIT_OF.VALIDATION, `${command} --${name}: ${run.err}`)
        assert.match(run.err, new RegExp(`^"cause --${name} takes one value and this line writes it more than once`, 'm'), run.err)
        assert.match(run.err, new RegExp(`^fix treadle help ${command}$`, 'm'), run.err)
        assert.equal(run.out, '', 'a refusal wrote to stdout')
      }
    })
  }

  it('refuses the inline spelling and the mixed pair too, which is the same line written twice', async () => {
    const inline = await cli(['backlog', '--state=draft', '--state=ready'])
    assert.equal(inline.code, EXIT_OF.VALIDATION, inline.err)
    const mixed = await cli(['backlog', '--state', 'draft', '--state=ready'])
    assert.equal(mixed.code, EXIT_OF.VALIDATION, mixed.err)
  })

  it('reaches beyond the filters, to every single-valued flag on every command', async () => {
    // The refusal still renders as the last `--out` asked, because presentation is read
    // leniently on a line the parser refused: a caller parsing stderr as JSON gets an object.
    const rendering = await cli(['status', '--out', 'agent', '--out', 'json'])
    assert.equal(rendering.code, EXIT_OF.VALIDATION, rendering.err)
    assert.match(rendering.err, /"cause": "--out takes one value/, rendering.err)
    const limit = await cli(['backlog', '--limit', '1', '--limit', '2'])
    assert.equal(limit.code, EXIT_OF.VALIDATION, limit.err)
    const chosen = await cli(['file', 'task', 'A title', '--id', 'first-id', '--id', 'second-id'])
    assert.equal(chosen.code, EXIT_OF.VALIDATION, chosen.err)
    const named = await cli(['show', 'one-thing', '--field', 'title', '--field', 'desc'])
    assert.equal(named.code, EXIT_OF.VALIDATION, named.err)
  })

  it('refuses a line before it is run, so nothing is written by the call that is refused', async () => {
    const refused = await cli(['mark', 'one-thing', '--reason', 'first', '--reason', 'second'])
    assert.equal(refused.code, EXIT_OF.VALIDATION, refused.err)
    const unchanged = must(await cli(['history', 'one-thing']), 'history')
    assert.doesNotMatch(unchanged.out, /item\.mark/, unchanged.out)
  })

  it('keeps every repeatable flag repeating, which its own option entry is what declares', async () => {
    const both = must(await cli(['backlog', '--label', 'ux', '--label', 'qa']), 'backlog --label')
    assert.match(both.out, /^filter state open label ux label qa$/m, both.out)
    assert.match(both.out, /^one-thing /m, both.out)
    const filed = must(await cli(['file', 'task', 'Two labels', '--id', 'two-labels', '--label', 'ux', '--label', 'ui']), 'file --label')
    assert.match(filed.out, /^item two-labels$/m)
    const set = must(await cli(['file', 'task', 'Two sets', '--id', 'two-sets', '--set', 'priority=1', '--set', 'assignee=kim']), 'file --set')
    assert.match(set.out, /^item two-sets$/m)
    must(await cli(['status', '-vv']), 'status -vv')
  })

  it('holds that list against the option table, so a new repeatable flag is a deliberate one', () => {
    const repeatable: string[] = []
    for (const [command, options] of [['treadle', GLOBAL_OPTIONS] as const, ...Object.entries(COMMAND_OPTIONS)]) {
      for (const [name, config] of Object.entries(options)) {
        if ((config as { multiple?: boolean }).multiple === true) repeatable.push(`${command} --${name}`)
      }
    }
    assert.deepEqual([...new Set(repeatable.map((entry) => entry.split(' ')[1] as string))].sort(),
      ['--label', '--override', '--set', '--verbose'],
      'a flag became repeatable; it now escapes the refusal above, so say why here')
  })
})

describe('a column named twice is refused, as a flag written twice is', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  for (const command of ['backlog']) {
    it(`refuses a repeated column on ${command}, and offers the line without it`, async () => {
      const run = await cli([command, '--fields', 'id,type,id'])
      assert.equal(run.code, EXIT_OF.VALIDATION, run.err)
      assert.match(run.err, /^rule C2$/m, run.err)
      assert.match(run.err, /^"cause id is named twice and a column is printed once/m, run.err)
      assert.match(run.err, new RegExp(`^fix treadle ${command} --fields id,type$`, 'm'), run.err)
      assert.equal(run.out, '', 'a refusal wrote to stdout')
    })
  }

  it('refuses a + selector that repeats a default column, which a caller cannot see in their line', async () => {
    const run = await cli(['backlog', '--fields', '+id'])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.err)
    assert.match(run.err, /^"cause id is named twice/m, run.err)
  })

  it('names an unknown column before a repeated one, because that is the error the caller made', async () => {
    const run = await cli(['backlog', '--fields', 'nope,nope'])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.err)
    assert.match(run.err, /^"cause nope is not a column of this list/m, run.err)
  })

  it('leaves a list with no repeat alone, and the same through the + selector', async () => {
    must(await cli(['backlog', '--fields', 'id,type,title']), 'backlog --fields')
    must(await cli(['backlog', '--fields', '+labels']), 'backlog --fields +labels')
    must(await cli(['backlog', '--fields', 'id,pri,title']), 'backlog --fields id,pri,title')
  })
})
