// SPDX-License-Identifier: Apache-2.0
// A megabyte-long argument, at every entry point that takes free text.
//
// Measured on 2026-09-07: `treadle set <id> desc=<1,000,000 y>` printed a raw
// `RangeError: Maximum call stack size exceeded` on stderr and exited 7, which tells a
// caller its store is corrupt while the store is fine. The cause is not in this codebase.
// The same argument crashes `node -e 'process.stderr.write("ok\n")'`, and the tool's own
// first line never runs: the kernel puts argv and the environment at the top of the main
// thread's stack, V8's limit is `--stack-size` KiB below that top, and a block of argv
// larger than the limit leaves the isolate with no stack to start on. Two measurements fix
// the mechanism: the threshold moves with the size of the environment (a 950,000 character
// argument crashes under this shell's environment and runs under `env -i`), and
// `--stack-size=1200` clears what the 984 KiB default cannot.
//
// So the fix is at the one place that chooses how the runtime starts, the shebang, and the
// gate below is in two halves. The first holds the shipped executable's shebang to a stack
// larger than any argv block execve can deliver; the second runs the tool under exactly the
// flags that shebang names and holds the three entry points to a typed refusal.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before, after } from 'node:test'

import { EXIT_OF } from '../../src/cli/exit.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ENTRY = path.join(ROOT, 'bin', 'treadle.js')

/**
 * POSIX bounds argv and the environment together at `ARG_MAX`, one mebibyte on macOS, so a
 * V8 stack at least that large cannot be exhausted by anything execve will carry.
 */
const ARG_MAX = 1024 * 1024

/** How the runtime is started, from the one file that writes the line. */
async function shebang(): Promise<string> {
  return (await readFile(ENTRY, 'utf8')).split('\n')[0] as string
}

/** The node flags a shebang asks for: everything after the interpreter name. */
function flagsOf(shebang: string): readonly string[] {
  const words = shebang.replace(/^#!/, '').trim().split(/\s+/)
  const node = words.findIndex((word) => word === 'node' || word.endsWith('/node'))
  return node < 0 ? [] : words.slice(node + 1)
}

/** KiB of V8 stack a flag list asks for, or the runtime's own default when it names none. */
const V8_DEFAULT_STACK_KIB = 984
function stackKibOf(flags: readonly string[]): number {
  const found = flags.map((flag) => /^--stack-size=(\d+)$/.exec(flag)).find((match) => match !== null)
  return found === null || found === undefined ? V8_DEFAULT_STACK_KIB : Number(found[1])
}

type Ran = { readonly code: number; readonly out: string; readonly err: string; readonly tooLong: boolean }

/** Runs the entry point under the flags its shebang names, from a small, fixed environment. */
async function runEntry(flags: readonly string[], argv: readonly string[], cwd: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...flags, ENTRY, ...argv], {
      cwd,
      // Small and fixed: argv and the environment share one ceiling, so an inherited CI
      // environment would decide how much room the argument under test has.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', TREADLE_ACTOR: 'dana' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'E2BIG') resolve({ code: -1, out: '', err: '', tooLong: true })
      else reject(error)
    })
    child.on('close', (code) => resolve({ code: code ?? -1, out, err, tooLong: false }))
  })
}

function assertTypedRefusal(ran: Ran, what: string): void {
  assert.equal(/^\s+at /m.test(ran.err), false, `${what}: a stack frame reached stderr:\n${ran.err.slice(0, 400)}`)
  assert.equal(
    ran.err.includes('Maximum call stack size exceeded'), false,
    `${what}: the runtime's own crash reached stderr:\n${ran.err.slice(0, 400)}`,
  )
  assert.match(ran.err, /^err VALIDATION /, `${what}: stderr does not open with a refusal envelope:\n${ran.err.slice(0, 400)}`)
  assert.equal(ran.code, EXIT_OF.VALIDATION, `${what}: exited ${ran.code} rather than ${EXIT_OF.VALIDATION}`)
}

describe('the shipped executable asks for a stack no argument can exhaust', () => {
  it('writes that line once, so the bundle cannot start the runtime differently', async () => {
    const build = await readFile(path.join(ROOT, 'scripts', 'build.ts'), 'utf8')
    assert.equal(
      build.includes('#!'), false,
      'scripts/build.ts spells a shebang of its own; it reads bin/treadle.js so the two cannot drift',
    )
    assert.match(build, /banner: \{ js: shebang \}/, 'the bundle banner is no longer the entry point\'s own line')
  })

  it('asks for at least ARG_MAX of V8 stack, which is what bounds an argv block', async () => {
    const kib = stackKibOf(flagsOf(await shebang()))
    assert.ok(
      kib * 1024 >= ARG_MAX,
      `the shebang asks for ${kib} KiB of V8 stack and execve can deliver ${ARG_MAX / 1024} KiB of argv`,
    )
  })
})

describe('a megabyte-long argument is a refusal, not a runtime crash', () => {
  let work: string
  let flags: readonly string[]
  const huge = 'y'.repeat(1_000_000)

  before(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'treadle-oversized-'))
    flags = flagsOf(await shebang())
    const init = await runEntry(flags, ['init', '--name', 'oversized'], work)
    assert.equal(init.code, 0, `init failed: ${init.err}`)
    const filed = await runEntry(flags, ['file', 'task', 'wire the retry'], work)
    assert.equal(filed.code, 0, `file failed: ${filed.err}`)
  })

  after(async () => { await rm(work, { recursive: true, force: true }) })

  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['set over a field', ['set', 'wire-the-retry', `desc=${'y'.repeat(1_000_000)}`]],
    ['file over a title', ['file', 'task', 'y'.repeat(1_000_000)]],
    ['evidence over a ref', ['evidence', 'add', 'wire-the-retry', 'url', `https://e.com/${'y'.repeat(1_000_000)}`]],
  ]

  for (const [what, argv] of cases) {
    it(`${what} exits ${EXIT_OF.VALIDATION} with no trace`, async (t) => {
      const ran = await runEntry(flags, argv, work)
      // Linux caps one argument at 128 KiB, so there the crash is unreachable by construction
      // and the two assertions above are the whole gate.
      if (ran.tooLong) return t.skip('this kernel refuses an argument this long before the tool runs')
      assertTypedRefusal(ran, what)
    })
  }

  it('does not echo the whole argument back in the refusal it prints', async () => {
    const ran = await runEntry(flags, ['help', huge], work)
    if (ran.tooLong) return
    assert.ok(
      ran.err.length < 4096,
      `the refusal for a 1,000,000 character argument is ${ran.err.length} bytes; a cause is a sentence, not the argument`,
    )
  })
})
