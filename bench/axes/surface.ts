// SPDX-License-Identifier: Apache-2.0
// The command surface, driven. Six axes score what a caller gets back from a command rather
// than what a function returns, so they all need the same three things: a workspace built by
// running commands, one call that captures stdout, stderr and the exit status, and a count
// of how many calls were made.
//
// The driver is `src/cli/main.ts`'s own `run`, which is the function `bin/treadle.js` shims,
// with argv, cwd, environment and both streams passed in. That is the entry point rather
// than a re-implementation of it, and `crossCheck` below spawns the shipped shim on the same
// input and compares the bytes, so the in-process claim is checked rather than asserted.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCli } from '../../test/helpers/cli-run.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BIN = path.join(ROOT, 'bin', 'treadle.js')

export const ACTOR = 'dana'

export type Invocation = {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly code: number
  readonly out: string
  readonly err: string
}

export type RunOptions = {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export type Surface = {
  /** The directory the workspace lives under; `.work` is inside it. */
  readonly root: string
  /** The temporary directory holding `root`, and nothing above it is a workspace. */
  readonly parent: string
  readonly run: (argv: readonly string[], options?: RunOptions) => Promise<Invocation>
  /** Commands driven through the surface so far. An axis reporting zero is the tell. */
  readonly calls: () => number
  readonly dispose: () => Promise<void>
}

/** A fresh workspace, created by running `init` rather than by writing the layout. */
export async function openSurface(prefix: string): Promise<Surface> {
  const parent = await mkdtemp(path.join(tmpdir(), `treadle-${prefix}-`))
  const root = path.join(parent, 'workspace')
  await mkdir(root, { recursive: true })
  let calls = 0

  const run = async (argv: readonly string[], options: RunOptions = {}): Promise<Invocation> => {
    calls += 1
    const cwd = options.cwd ?? root
    const result = await runCli(argv, {
      cwd,
      env: options.env ?? { TREADLE_ACTOR: ACTOR },
    })
    return { argv, cwd, code: result.code, out: result.out, err: result.err }
  }

  const created = await run(['init', '--name', prefix], { cwd: root })
  if (created.code !== 0) throw new Error(`init in ${root} failed: ${created.err}`)

  return {
    root,
    parent,
    run,
    calls: () => calls,
    dispose: async () => { await rm(parent, { recursive: true, force: true }) },
  }
}

/** The result object a command wrote, parsed. Errors render to stderr, successes to stdout. */
export function resultOf(call: Invocation): Record<string, unknown> | undefined {
  const text = call.code === 0 ? call.out : call.err
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function dataOf(call: Invocation): Record<string, unknown> {
  const result = resultOf(call)
  const data = result?.['data']
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}

export type Spawned = {
  readonly argv: readonly string[]
  readonly code: number
  readonly out: string
  readonly err: string
}

/** The shipped shim, on the same input, so `matches` below is measured and not assumed. */
export function spawn(argv: readonly string[], cwd: string): Promise<Spawned> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...argv],
      { cwd, env: { ...process.env, TREADLE_ACTOR: ACTOR } },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
        resolve({ argv, code, out: stdout, err: stderr })
      },
    )
  })
}

export type CrossCheck = {
  readonly argv: readonly string[]
  readonly matches: boolean
  readonly detail: string
}

/**
 * Runs one invocation through the shipped shim and compares it with what the in-process
 * driver returned. A read is the only safe candidate, because a mutation run twice is two
 * different states; each axis picks one of its own reads.
 */
export async function crossCheck(call: Invocation): Promise<CrossCheck> {
  const child = await spawn(call.argv, call.cwd)
  const matches = child.code === call.code && child.out === call.out && child.err === call.err
  return {
    argv: call.argv,
    matches,
    detail: matches
      ? `exit ${child.code}, ${child.out.length + child.err.length} bytes identical`
      : `in-process exit ${call.code} ${call.out.length}/${call.err.length} bytes, spawned exit ${child.code} ${child.out.length}/${child.err.length} bytes`,
  }
}
