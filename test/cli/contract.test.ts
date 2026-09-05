// SPDX-License-Identifier: Apache-2.0
// The output contract, driven through the real entry point: which stream carries what, which
// rendering is chosen, and what the exit status is. Every one of these is a function of the
// result object rather than of the command that produced it, which is what R2 and R3 buy.

import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { RESULT_CODES, errorResult, type ResultCode } from '../../src/application/result.ts'
import { EXIT_OF, exitFor } from '../../src/cli/exit.ts'
import { checkRuntime, isBelow, DECLARED_FLOOR, HARD_FLOOR } from '../../src/cli/runtime.ts'
import { parse } from '../../src/cli/parse.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

describe('exit status is a function of the result object', () => {
  it('maps every code in the closed set, and nothing else', () => {
    assert.deepEqual(Object.keys(EXIT_OF).sort(), [...RESULT_CODES].sort())
  })

  it('maps success to 0 and every refusal to its own non-zero status', () => {
    assert.equal(EXIT_OF.OK, 0)
    const refusals = RESULT_CODES.filter((code) => code !== 'OK')
    for (const code of refusals) assert.notEqual(EXIT_OF[code], 0, `${code} exits 0`)
    assert.deepEqual([...new Set(refusals.map((code) => EXIT_OF[code]))].sort(), [1, 2, 3, 4, 5, 6, 7])
  })

  it('reads the code and nothing else, so two commands with one code exit alike', () => {
    for (const code of RESULT_CODES.filter((c) => c !== 'OK') as readonly Exclude<ResultCode, 'OK'>[]) {
      const a = errorResult({ code, command: 'show', workspace: 'w', effect: 'read', cause: 'x' })
      const b = errorResult({ code, command: 'transition', workspace: 'w', effect: 'mutate', cause: 'x' })
      assert.equal(exitFor(a), exitFor(b))
    }
  })
})

describe('the runtime check has a floor the suite can exercise from both sides', () => {
  it('refuses below the hard floor and allows at or above it', () => {
    assert.equal(checkRuntime('23.11.0').ok, false)
    assert.equal(checkRuntime('24.0.0').ok, true)
    assert.equal(checkRuntime('24.11.1').ok, true)
    assert.equal(checkRuntime('25.0.0').ok, true)
  })

  it('says nothing between the hard floor and the declared one, so stderr stays for errors', () => {
    assert.equal(isBelow('24.11.1', DECLARED_FLOOR), true, 'this machine is below the declared floor')
    assert.equal(isBelow('24.11.1', HARD_FLOOR), false)
    assert.equal(checkRuntime('24.11.1').ok, true)
  })

  it('names both floors when it refuses', () => {
    const refusal = checkRuntime('22.0.0')
    assert.equal(refusal.ok, false)
    assert.match(refusal.ok ? '' : refusal.cause, /24\.0\.0/)
    assert.match(refusal.ok ? '' : refusal.cause, /24\.15\.0/)
  })
})

describe('the parser', () => {
  it('finds the command word past a global flag that takes a value', () => {
    const parsed = parse(['--workspace', '/tmp/x', 'backlog', '--state', 'ready'])
    assert.equal(parsed.ok && parsed.value.command, 'backlog')
    assert.equal(parsed.ok && parsed.value.flags['workspace'], '/tmp/x')
  })

  it('keeps the filter clauses in the order they were written', () => {
    const written = parse(['backlog', '--assignee', 'kim', '--state', 'ready'])
    assert.deepEqual(written.ok ? written.value.filterOrder : [], ['assignee', 'state'])
    const other = parse(['backlog', '--state', 'ready', '--assignee', 'kim'])
    assert.deepEqual(other.ok ? other.value.filterOrder : [], ['state', 'assignee'])
  })

  it('refuses --dry-run with --preview rather than picking one silently', () => {
    const parsed = parse(['transition', 'a', 'ready', '--dry-run', '--preview'])
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.cause, /different questions/)
  })

  it('refuses a flag this command answers X or N to, and names the correct form', () => {
    assert.equal(parse(['show', 'a', '--limit', '2']).ok, false)
    assert.equal(parse(['backlog', '--version']).ok, false)
    assert.equal(parse(['backlog', '--limit', '2']).ok, true)
  })

  it('refuses an unknown command and an unknown flag', () => {
    assert.equal(parse(['ceremony']).ok, false)
    assert.equal(parse(['backlog', '--nonsense']).ok, false)
  })
})

describe('streams and renderings, end to end', () => {
  let demo: Demo
  let cwd: string

  before(async () => {
    demo = await aDemoWorkspace()
    cwd = path.dirname(demo.root)
    await demo.store.close()
  })

  after(async () => {
    await demo.dispose()
  })

  it('puts a result on stdout and nothing on stderr', async () => {
    const run = await runCli(['backlog'], { cwd })
    assert.equal(run.code, 0)
    assert.match(run.out, /^ok backlog acme-platform\n/)
    assert.equal(run.err, '')
  })

  it('puts a refusal on stderr and nothing on stdout, on every rendering', async () => {
    for (const rendering of ['agent', 'json', 'human']) {
      const run = await runCli(['show', 'no-such-item', '--out', rendering], { cwd })
      assert.equal(run.code, 5, `${rendering} exit`)
      assert.equal(run.out, '', `${rendering} wrote a refusal to stdout`)
      assert.ok(run.err.length > 0, `${rendering} wrote no refusal`)
    }
  })

  it('chooses human on a terminal and agent off one, and nothing else changes it', async () => {
    const piped = await runCli(['show', 'auth-refresh'], { cwd, isTTY: false })
    assert.match(piped.out, /^ok show /)
    const terminal = await runCli(['show', 'auth-refresh'], { cwd, isTTY: true })
    assert.match(terminal.out, /^show {2}acme-platform/)
    const withEnv = await runCli(['show', 'auth-refresh'], {
      cwd, isTTY: false, env: { TREADLE_OUT: 'human', WMX_OUT: 'human', NO_COLOR: '1' },
    })
    assert.equal(withEnv.out, piped.out, 'an environment variable moved the rendering')
  })

  it('is the same content in every rendering, not different facts', async () => {
    const agent = await runCli(['show', 'auth-refresh', '--out', 'agent'], { cwd })
    const json = await runCli(['show', 'auth-refresh', '--out', 'json'], { cwd })
    const parsed = JSON.parse(json.out) as { data: Record<string, unknown> }
    assert.equal(parsed.data['state'], 'in_progress')
    assert.match(agent.out, /^state in_progress$/m)
  })

  it('runs status for the bare invocation inside a workspace, and help outside one', async () => {
    const inside = await runCli([], { cwd })
    assert.match(inside.out, /^ok status acme-platform\n/)
    const outside = await runCli([], { cwd: path.dirname(path.dirname(cwd)) })
    assert.match(outside.out, /^ok help /)
  })

  it('refuses a command outside a workspace with the store code and a runnable fix', async () => {
    const run = await runCli(['backlog'], { cwd: path.dirname(path.dirname(cwd)) })
    assert.equal(run.code, 6)
    assert.match(run.err, /^err STORE_UNAVAILABLE -\n/)
    assert.match(run.err, /^fix treadle init$/m)
  })

  it('under --quiet keeps the records and drops everything around them', async () => {
    const loud = await runCli(['backlog', '--limit', '3'], { cwd })
    const quiet = await runCli(['backlog', '--limit', '3', '--quiet'], { cwd })
    assert.equal(quiet.code, loud.code)
    assert.equal(quiet.out.startsWith('~items 3 24\n#id'), true, quiet.out)
    assert.equal(quiet.out.includes('sort priority'), false, 'a header line survived --quiet')
    assert.equal(quiet.out.split('\n').length < loud.out.split('\n').length, true)
  })

  it('under --quiet a mutation says nothing and the exit status is the signal', async () => {
    const run = await runCli(['transition', 'auth-refresh', 'in_review', '--quiet'], { cwd })
    assert.equal(run.code, 0)
    assert.equal(run.out, '')
    assert.equal(run.err, '')
  })

  it('pages a ranked list with --cursor, which is what makes --limit honest there', async () => {
    const first = await runCli(['next', '--limit', '2'], { cwd })
    assert.match(first.out, /^page treadle next --cursor (\S+)$/m)
    const cursor = /^page treadle next --cursor (\S+)$/m.exec(first.out)?.[1] as string
    const second = await runCli(['next', '--limit', '2', '--cursor', cursor], { cwd })
    assert.match(second.out, new RegExp(`^${cursor} `, 'm'))
    // The first row is the line after the column header, found rather than counted: the
    // scalars above the block are the page cursor's own, and how many there are is the
    // projection's business.
    const lines = first.out.split('\n')
    const firstRow = lines[lines.findIndex((line) => line.startsWith('#')) + 1] as string
    assert.equal(second.out.includes(firstRow), false, `the second page repeats the first row: ${firstRow}`)
  })

  it('refuses below the hard runtime floor before it reads anything', async () => {
    const run = await runCli(['backlog'], { cwd, nodeVersion: '22.14.0' })
    assert.equal(run.code, 6)
    assert.equal(run.out, '')
    assert.match(run.err, /err STORE_UNAVAILABLE/)
  })
})
