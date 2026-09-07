// SPDX-License-Identifier: Apache-2.0
// An oversized input, at every entry point that takes free text, on the platforms that can
// deliver one.
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
// that is a RangeError at the 984 KiB default stack and a clean run at 3072.
//
// WHICH IS WHY THE CEILING RUN IS LINUX'S ALONE. The shebang asked for that 3 MiB stack for
// one day and stopped the tool starting under BusyBox `env`, so `bin/treadle.js` is back to
// `#!/usr/bin/env node` and macOS keeps the platform limit rather than the flag
// (`docs/STABILITY.md`, "The macOS argument-block limit"). Linux does not charge the block
// against the stack - run 34106349134 answered, typed, behind 4,140,820 bytes of argv under
// the default - so Linux is where a block at the ceiling is a statement about this tool and
// not about a kernel. On macOS a block at the ceiling is the documented platform limit, and
// Windows caps a command line at 32,767 characters and ships no `getconf`.
//
// What every POSIX platform still holds, below that limit, is the load-bearing half: the
// largest single entry the field dictionary will ever meet is a typed refusal with no trace,
// which is what `MAX_CAUSE`, `MAX_LINE` and the field bounds are for and what no shebang
// affects. And every platform holds the shebang's own portability, because losing it is the
// regression that shipped.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before, after } from 'node:test'

import { EXIT_OF } from '../../src/cli/exit.ts'
import { flagsOf, portabilityProblem, shebangOf } from '../../scripts/shebang.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ENTRY = path.join(ROOT, 'bin', 'treadle.js')
const FLAGS = flagsOf(shebangOf(ROOT))

/** Windows has no `getconf`, no ARG_MAX and no fork of this shape; the block tests are POSIX's. */
const POSIX = process.platform !== 'win32'

/** Argv and the environment share one ceiling; this is what the platform says it is. */
function argMax(): number {
  const said = Number(execFileSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).trim())
  assert.ok(Number.isInteger(said) && said > 0, `getconf ARG_MAX said ${said}`)
  return said
}
const ARG_MAX = POSIX ? argMax() : 0

/**
 * Why a describe below does not run here, or false when it does. A block filled to ARG_MAX is
 * a statement about this tool on Linux and a statement about the kernel anywhere else, so it
 * runs on Linux; a single 90,000 character entry is under every POSIX ceiling and over every
 * bound the field dictionary states, so it runs wherever a POSIX exec does.
 */
const LINUX_ONLY = process.platform === 'linux'
  ? false
  : `a block at ARG_MAX is ${process.platform}'s own limit, not this tool's; docs/STABILITY.md carries it`
const POSIX_ONLY = POSIX ? false : 'a Windows command line is capped at 32,767 characters'


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

describe('the shipped executable starts on every userland this package says it runs on', () => {
  it('names no env option and no node flag, because BusyBox env has neither', () => {
    const shebang = shebangOf(ROOT)
    assert.equal(
      portabilityProblem(shebang), undefined,
      `bin/treadle.js opens with ${shebang}, and the tool has to start under BusyBox env too`,
    )
  })

  // The regression itself, spelled as its own case so the sentence in the failure names it.
  it('is not the -S line that stopped treadle starting on node:24-alpine', () => {
    const shebang = shebangOf(ROOT)
    assert.equal(
      shebang.includes('-S'), false,
      `${shebang} needs env -S, which BusyBox 1.37.0 does not have: measured 2026-09-07, `
        + '`treadle version` printed "env: unrecognized option: S" and exited 1 on node:24-alpine',
    )
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

describe('a block at this platform\'s ceiling is an answer, not a crash', { skip: LINUX_ONLY }, () => {
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

describe('the largest single entry this platform carries is a typed refusal', { skip: POSIX_ONLY }, () => {
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
