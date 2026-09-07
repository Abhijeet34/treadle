// SPDX-License-Identifier: Apache-2.0
// An oversized input, at every entry point that takes free text, on every platform.
//
// Measured on 2026-09-07: `treadle set <id> desc=<1,000,000 y>` printed a raw `RangeError:
// Maximum call stack size exceeded` on stderr and exited 7, which tells a caller its store is
// corrupt while the store is fine. The cause is not in this codebase. The same input crashes
// `node -e 'process.stderr.write("ok\n")'` and the tool's own first line never runs: the
// kernel puts argv and the environment at the top of the main thread's stack, V8's limit sits
// `--stack-size` KiB below that top, and a block larger than the limit leaves the isolate with
// no stack to start on.
//
// THE BOUND IS THE BLOCK, NOT THE ENTRY. POSIX bounds argv and the environment together at
// ARG_MAX and Linux bounds each single string separately at 128 KiB, so a first version of
// this file, which passed one 1,000,000 character argument, could not exec on Linux at all and
// failed CI four times with `spawn E2BIG` before reaching treadle. It was measuring this
// machine's per-entry limit rather than the tool's behaviour. Eleven arguments of 90,000
// characters, every one of them far under Linux's per-entry cap, make a 990,547 byte block
// that is a RangeError and exit 7 at the 984 KiB default and a clean run at 3072; the same
// block delivered as eleven environment variables, behind an ordinary short command line, does
// the same. Both shapes are exercised below, and both are sized from this platform's own
// ARG_MAX, so neither skips itself anywhere.
//
// AND ARG_MAX IS NOT THE BOUND THE SHEBANG HAS TO CLEAR, which cost a CI round to learn.
// A second version of this file asserted that the requested stack exceeds ARG_MAX, which is
// true on macOS and false on Linux: run 34106349134 measured ARG_MAX at 4,194,304 there and
// refused the assertion against a 3 MiB stack, while in the same run the two block tests below
// passed with 4,140,820 bytes of argv and 4,142,278 bytes of environment. A block larger than
// the whole V8 stack ran clean, so Linux does not charge that block against the stack the way
// macOS does, and no relation between `--stack-size` and ARG_MAX is a property of both.
// Raising the request to clear a 4 MiB ceiling would also have put it at half the main
// thread's own 8 MiB stack, trading a typed refusal for a segfault.
//
// So the structural tests state the two relations that are true everywhere and are what the
// shebang is for: a floor, because a request at the runtime's default is what crashed macOS,
// and a ceiling, because a request near the thread's own stack faults instead of throwing.
// The load-bearing claim is behavioural and the six tests under them make it directly: for the
// largest block this platform can put in front of the process, on the argv axis and on the
// environment axis, the tool answers and never returns a trace.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before, after } from 'node:test'

import { EXIT_OF } from '../../src/cli/exit.ts'
import { V8_DEFAULT_STACK_KIB, flagsOf, shebangOf, stackKibOf } from '../../scripts/shebang.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ENTRY = path.join(ROOT, 'bin', 'treadle.js')
const FLAGS = flagsOf(shebangOf(ROOT))

/** Argv and the environment share one ceiling; this is what the platform says it is. */
function argMax(): number {
  const said = Number(execFileSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).trim())
  assert.ok(Number.isInteger(said) && said > 0, `getconf ARG_MAX said ${said}`)
  return said
}
const ARG_MAX = argMax()

/**
 * The largest single entry this file will build. Linux caps one argv or environment string at
 * MAX_ARG_STRLEN, 32 pages, which is 128 KiB on a 4 KiB-page kernel and larger on any other;
 * 90,000 is under the smallest of those and is what the 2026-09-07 measurement used.
 */
const PER_ENTRY = 90_000

/**
 * Room left under the ceiling for the two paths, the pointer arrays and the kernel's own
 * per-exec strings. Measured on macOS, where the window is narrowest: ARG_MAX is 1 MiB and the
 * default V8 limit is 984 KiB, so a margin over 24,000 leaves a block too small to have
 * reached the fault this file is about.
 */
const MARGIN = 24_000

const SMALL_ENV: Readonly<Record<string, string>> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  TREADLE_ACTOR: 'dana',
}

function bytesOf(entries: readonly string[]): number {
  return entries.reduce((total, entry) => total + Buffer.byteLength(entry) + 1, 0)
}

function envBytes(env: Readonly<Record<string, string>>): number {
  return bytesOf(Object.entries(env).map(([name, value]) => `${name}=${value}`))
}

/** As many entries of `PER_ENTRY` characters as fit under the ceiling, given what is fixed. */
function fill(fixedBytes: number): readonly string[] {
  const budget = ARG_MAX - fixedBytes - MARGIN
  const count = Math.floor(budget / (PER_ENTRY + 1))
  assert.ok(count >= 2, `this platform's ARG_MAX of ${ARG_MAX} leaves room for ${count} entries`)
  return Array.from({ length: count }, () => 'y'.repeat(PER_ENTRY))
}

type Ran = { readonly code: number; readonly out: string; readonly err: string }

/** Runs the entry point under the flags its own shebang names. */
async function runEntry(
  argv: readonly string[], cwd: string, env: Readonly<Record<string, string>> = SMALL_ENV,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...FLAGS, ENTRY, ...argv], { cwd, env })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

/** The invariant: whatever the size, the tool answers rather than the runtime dying. */
function assertNoCrash(ran: Ran, what: string): void {
  assert.equal(
    ran.err.includes('Maximum call stack size exceeded'), false,
    `${what}: the runtime's own crash reached stderr:\n${ran.err.slice(0, 400)}`,
  )
  assert.equal(/^\s+at /m.test(ran.err), false, `${what}: a stack frame reached stderr:\n${ran.err.slice(0, 400)}`)
}

function assertTypedRefusal(ran: Ran, what: string): void {
  assertNoCrash(ran, what)
  assert.match(ran.err, /^err VALIDATION /, `${what}: stderr does not open with a refusal envelope:\n${ran.err.slice(0, 400)}`)
  assert.equal(ran.code, EXIT_OF.VALIDATION, `${what}: exited ${ran.code} rather than ${EXIT_OF.VALIDATION}`)
}

/** KiB of stack the main thread actually has, or undefined where the shell reports no limit. */
function stackRlimitKib(): number | undefined {
  const said = execFileSync('sh', ['-c', 'ulimit -s'], { encoding: 'utf8' }).trim()
  const kib = Number(said)
  return Number.isInteger(kib) && kib > 0 ? kib : undefined
}

describe('the shipped executable asks for a stack between the two bounds that are real', () => {
  it('asks for more than the runtime\'s own default, which is what the default crashed under', (t) => {
    const kib = stackKibOf(FLAGS)
    assert.ok(
      kib > V8_DEFAULT_STACK_KIB,
      `the shebang asks for ${kib} KiB, and ${V8_DEFAULT_STACK_KIB} KiB is the default a 990,547 byte block exhausted`,
    )
    t.diagnostic(`${kib} KiB requested, ${V8_DEFAULT_STACK_KIB} KiB default, ARG_MAX ${ARG_MAX} bytes here`)
  })

  // The cost of asking for too much, which is why this bound exists as well: a V8 stack near
  // the thread's own means a deep call faults rather than throwing, and a segfault is worse
  // than the RangeError this shebang exists to prevent.
  it('stays under half the main thread\'s own stack, so a deep call still throws', (t) => {
    const rlimit = stackRlimitKib()
    if (rlimit === undefined) return t.skip('this shell reports no stack limit to compare against')
    const kib = stackKibOf(FLAGS)
    assert.ok(
      kib * 2 <= rlimit,
      `the shebang asks for ${kib} KiB of V8 stack and the main thread has ${rlimit} KiB`,
    )
    t.diagnostic(`${kib} KiB requested against a ${rlimit} KiB thread stack`)
  })

  it('gives the bundle the entry point\'s own line, through the function the build calls', () => {
    const dev = (readFileSync(ENTRY, 'utf8').split('\n')[0]) as string
    assert.equal(
      shebangOf(ROOT), dev,
      'the build reads a shebang that is not the development entry point\'s own first line',
    )
    assert.ok(dev.startsWith('#!'), `bin/treadle.js does not open with a shebang: ${dev}`)
  })
})

describe('a block at this platform\'s ceiling is an answer, not a crash', () => {
  let work: string

  before(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'treadle-oversized-'))
    const init = await runEntry(['init', '--name', 'oversized'], work)
    assert.equal(init.code, 0, `init failed: ${init.err}`)
    const filed = await runEntry(['file', 'task', 'wire the retry'], work)
    assert.equal(filed.code, 0, `file failed: ${filed.err}`)
  })

  after(async () => { await rm(work, { recursive: true, force: true }) })

  it('refuses an argv block filled to the ceiling by many entries', async (t) => {
    const fixed = bytesOf([process.execPath, ...FLAGS, ENTRY, 'set', 'wire-the-retry']) + envBytes(SMALL_ENV)
    const chunks = fill(fixed)
    const ran = await runEntry(['set', 'wire-the-retry', ...chunks], work)
    t.diagnostic(`${chunks.length} entries of ${PER_ENTRY}, ${bytesOf(chunks) + fixed} bytes of block`)
    assertTypedRefusal(ran, 'an argv block at the ceiling')
  })

  it('answers behind an environment filled to the ceiling by many entries', async (t) => {
    const fixed = bytesOf([process.execPath, ...FLAGS, ENTRY, 'version']) + envBytes(SMALL_ENV)
    const chunks = fill(fixed)
    const env: Record<string, string> = { ...SMALL_ENV }
    for (const [at, chunk] of chunks.entries()) env[`TREADLE_FILLER_${String(at).padStart(2, '0')}`] = chunk
    const ran = await runEntry(['version'], work, env)
    t.diagnostic(`${chunks.length} variables of ${PER_ENTRY}, ${envBytes(env) + fixed} bytes of block`)
    assertNoCrash(ran, 'an environment at the ceiling')
    assert.equal(ran.code, 0, `version exited ${ran.code} behind a full environment:\n${ran.err.slice(0, 400)}`)
    assert.match(ran.out, /^ok version /, `version did not answer:\n${ran.out.slice(0, 200)}`)
  })
})

describe('the largest single entry this platform carries is a typed refusal', () => {
  let work: string
  // On macOS this is a megabyte; on Linux it is one entry under MAX_ARG_STRLEN. Both are far
  // past every bound the field dictionary states, which is what the refusal has to say.
  const huge = 'y'.repeat(Math.min(1_000_000, PER_ENTRY))

  before(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'treadle-oversized-one-'))
    const init = await runEntry(['init', '--name', 'oversized'], work)
    assert.equal(init.code, 0, `init failed: ${init.err}`)
    const filed = await runEntry(['file', 'task', 'wire the retry'], work)
    assert.equal(filed.code, 0, `file failed: ${filed.err}`)
  })

  after(async () => { await rm(work, { recursive: true, force: true }) })

  const cases: readonly (readonly [string, (value: string) => readonly string[]])[] = [
    ['set over a field', (v) => ['set', 'wire-the-retry', `desc=${v}`]],
    ['file over a title', (v) => ['file', 'task', v]],
    ['evidence over a ref', (v) => ['evidence', 'add', 'wire-the-retry', 'url', `https://e.com/${v}`]],
  ]

  for (const [what, argv] of cases) {
    it(`${what} exits ${EXIT_OF.VALIDATION} with no trace`, async () => {
      assertTypedRefusal(await runEntry(argv(huge), work), what)
    })
  }

  it('does not echo the whole entry back in the refusal it prints', async () => {
    const ran = await runEntry(['help', huge], work)
    assertNoCrash(ran, 'help over an oversized topic')
    assert.ok(
      ran.err.length < 4096,
      `the refusal for a ${huge.length} character argument is ${ran.err.length} bytes; a cause is a sentence, not the argument`,
    )
  })
})
