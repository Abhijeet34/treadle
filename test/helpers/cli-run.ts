// SPDX-License-Identifier: Apache-2.0
// Drives the CLI the way the entry point does, with the streams, the environment and the
// TTY test as arguments. No process is spawned: `run` takes all four, so a suite reads what
// a command wrote without paying for a fork per assertion.

import { run, type Environment } from '../../src/cli/main.ts'

export type Run = {
  readonly code: number
  readonly out: string
  readonly err: string
}

export type RunOptions = {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly isTTY?: boolean
  readonly nodeVersion?: string
}

export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<Run> {
  let out = ''
  let err = ''
  const environment: Environment = {
    argv,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? { TREADLE_ACTOR: 'dana' },
    isTTY: options.isTTY ?? false,
    nodeVersion: options.nodeVersion ?? process.versions.node,
    streams: { out: (text) => { out += text }, err: (text) => { err += text } },
  }
  const code = await run(environment)
  return { code, out, err }
}
