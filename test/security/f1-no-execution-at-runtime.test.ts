// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F1: DR6 designed a hook as an executable named in a committed
// `workspace.md` and run on every mutation, and ADR-0012 refuses that contract rather than
// gating it. `f1-f7-no-execution.test.ts` holds the architecture rule that no source file
// names an executing module in an import specifier, but a specifier scan cannot see a call
// built at runtime, so it proves the rule was followed, not that nothing executes.
//
// This file proves the runtime claim instead, the same way `no-egress.test.ts` proves no
// command opens a socket: every entry point Node has for running a program or a string is
// replaced with one that records the attempt and throws, and every command in the inventory
// is then run against a real workspace with the traps live.
//
// A trap that cannot fire is the failure mode this file is most exposed to, so the first
// test in it makes each trap fire on purpose and asserts it caught the call. Without that,
// a patch that silently stopped applying would leave the rest of the file green over nothing.
//
// What this does not cover: this Node version resolves a named import of a builtin, for
// example `import { execSync } from 'node:child_process'`, to its own binding rather than a
// live read of the module's exported property, so patching the property here does not reach
// a call written that way, only one written against the module object itself, such as
// `cp.execSync(...)`. `f1-f7-no-execution.test.ts`'s specifier scan is what catches a named
// import regardless of destructuring style, which is why it stays even though this file
// exists.

import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { describe, it, before, after } from 'node:test'

import { COMMANDS } from '../../src/cli/inventory.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

type Attempt = { readonly api: string; readonly argument: string }

/**
 * Replaces every entry point Node has for running a program or a string with one that
 * records and throws, and returns the undo. Patching the module's own export object is what
 * reaches a caller that did `import cp from 'node:child_process'` three layers down.
 */
function trapExecution(attempts: Attempt[]): () => void {
  const undo: (() => void)[] = []

  // A `function`, not an arrow, because `vm.Script` and `Function` are called with `new`,
  // and a `new` on an arrow function throws "is not a constructor" before the trap's own
  // error ever fires.
  const trap = (holder: Record<string, unknown>, key: string, api: string): void => {
    const original = holder[key]
    holder[key] = function (...args: unknown[]) {
      attempts.push({ api, argument: String(args[0] ?? '') })
      throw new Error(`${api} was called, and ADR-0012 refuses execution`)
    }
    undo.push(() => { holder[key] = original })
  }

  trap(cp as unknown as Record<string, unknown>, 'exec', 'child_process.exec')
  trap(cp as unknown as Record<string, unknown>, 'execFile', 'child_process.execFile')
  trap(cp as unknown as Record<string, unknown>, 'execFileSync', 'child_process.execFileSync')
  trap(cp as unknown as Record<string, unknown>, 'execSync', 'child_process.execSync')
  trap(cp as unknown as Record<string, unknown>, 'spawn', 'child_process.spawn')
  trap(cp as unknown as Record<string, unknown>, 'spawnSync', 'child_process.spawnSync')
  trap(cp as unknown as Record<string, unknown>, 'fork', 'child_process.fork')
  trap(vm as unknown as Record<string, unknown>, 'runInThisContext', 'vm.runInThisContext')
  trap(vm as unknown as Record<string, unknown>, 'runInNewContext', 'vm.runInNewContext')
  trap(vm as unknown as Record<string, unknown>, 'runInContext', 'vm.runInContext')
  trap(vm as unknown as Record<string, unknown>, 'compileFunction', 'vm.compileFunction')
  trap(vm as unknown as Record<string, unknown>, 'Script', 'vm.Script')
  trap(globalThis as unknown as Record<string, unknown>, 'eval', 'eval')
  trap(globalThis as unknown as Record<string, unknown>, 'Function', 'Function')

  return () => { for (const restore of undo.reverse()) restore() }
}

type Invocation = { readonly argv: readonly string[]; readonly cwd: string }

/** Every command the inventory names, with arguments that reach its real work. */
function invocations(inside: string, elsewhere: string): ReadonlyMap<string, Invocation> {
  const argv = new Map<string, readonly string[]>([
    ['init', ['init', '--name', 'no-exec']],
    ['file', ['file', 'task', 'A task filed with execution trapped']],
    ['show', ['show', 'auth-refresh']],
    ['backlog', ['backlog', '--state', 'ready']],
    ['transition', ['transition', 'sso-saml', 'in_review']],
    ['set', ['set', 'flaky-e2e', 'expected=five passes', 'fix_confirmed=true']],
    ['mark', ['mark', 'flaky-e2e', '--severity', 'S1', '--reason', 'it fails the release suite']],
    ['evidence', ['evidence', 'add', 'flaky-e2e', 'run', '8813', 'five of five green']],
    ['relation', ['relation', 'add', 'auth-refresh', 'blocks', 'csv-export']],
    ['sprint', ['sprint', 'open', 'Sprint one', '--start', '2026-09-07', '--end', '2026-09-18']],
    ['sprints', ['sprints']],
    ['doctor', ['doctor']],
    ['next', ['next', '--limit', '3']],
    ['explain', ['explain', 'auth-refresh']],
    ['history', ['history', 'auth-refresh']],
    ['status', ['status']],
    ['help', ['help']],
    ['version', ['version']],
  ])
  assert.deepEqual(
    [...argv.keys()].sort(), COMMANDS.map((command) => command.name).sort(),
    'a command in the inventory is not exercised by the no-execution-at-runtime test',
  )
  return new Map([...argv].map(([name, args]) => [
    name, { argv: args, cwd: name === 'init' ? elsewhere : inside },
  ]))
}

describe('the execution trap fires when something does run a program or a string', () => {
  it('records the call and throws, so a green run below means something', () => {
    const attempts: Attempt[] = []
    const release = trapExecution(attempts)
    try {
      assert.throws(() => cp.exec('echo hi', () => undefined), /refuses execution/)
      assert.throws(() => cp.spawn('echo', ['hi']), /refuses execution/)
      assert.throws(() => cp.execSync('echo hi'), /refuses execution/)
      assert.throws(() => vm.runInThisContext('1 + 1'), /refuses execution/)
      assert.throws(() => new vm.Script('1 + 1'), /refuses execution/)
      assert.throws(() => eval('1 + 1'), /refuses execution/)
      assert.throws(() => new Function('return 1'), /refuses execution/)
    } finally {
      release()
    }
    assert.deepEqual(
      attempts.map((a) => a.api),
      ['child_process.exec', 'child_process.spawn', 'child_process.execSync', 'vm.runInThisContext', 'vm.Script', 'eval', 'Function'],
    )
    assert.equal(typeof globalThis.eval, 'function', 'the trap did not put eval back')
    assert.equal(typeof globalThis.Function, 'function', 'the trap did not put Function back')
  })
})

describe('no command runs a program or evaluates a string', () => {
  let demo: Demo
  let cwd: string
  let elsewhere: string

  before(async () => {
    demo = await aDemoWorkspace()
    cwd = path.dirname(demo.root)
    await demo.store.close()
    elsewhere = await mkdtemp(path.join(tmpdir(), 'treadle-no-exec-'))
  })

  after(async () => {
    await demo.dispose()
    await rm(elsewhere, { recursive: true, force: true })
  })

  it('holds for every command the inventory names', async (t) => {
    const attempts: Attempt[] = []
    const release = trapExecution(attempts)
    let ran = 0
    try {
      for (const [name, invocation] of invocations(cwd, elsewhere)) {
        const run = await runCli(invocation.argv, { cwd: invocation.cwd })
        ran += 1
        assert.ok(run.code < 7, `${name} exited ${run.code}`)
        assert.equal(
          /refuses execution/.test(run.out + run.err), false,
          `${name} tried to run a program or evaluate a string: ${run.err}`,
        )
      }
    } finally {
      release()
    }
    assert.deepEqual(attempts, [], `a command executed something: ${JSON.stringify(attempts)}`)
    assert.equal(ran, COMMANDS.length)
    t.diagnostic(`${ran} commands run with every execution entry point trapped: ${attempts.length} attempts`)
  })
})
