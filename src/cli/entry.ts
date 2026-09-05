// SPDX-License-Identifier: Apache-2.0
// The process boundary, and the esbuild entry point (DR1). It owns argv, the streams, the
// TTY test and the exit status; everything a test needs to drive is `run`, which takes all
// four as arguments, so the suite never spawns a process to check what a command printed.
//
// `bin/treadle.js` imports this file to run from source in development. The release build
// bundles it into `dist/treadle.js`, which is the executable the published package installs.

import module from 'node:module'
import process from 'node:process'

import { run } from './main.ts'
import { EXIT_INTERRUPTED } from './exit.ts'

// DR1's -4.4 ms. The default directory is the runtime's own (NODE_COMPILE_CACHE, else one
// under the OS temp directory) rather than a path under the workspace: resolving a workspace
// first would put filesystem I/O above the dispatcher, which is the one thing DR1's cold-start
// rules forbid there, and a cache keyed to the executable belongs to the user rather than to
// any one workspace. It is an optimisation, so a runtime that declines it is not an error.
module.enableCompileCache?.()

// The runtime's own notices are filtered by name so one can never precede the envelope
// (DR5). node:sqlite is Stability 1.2 and prints one experimental warning per process below
// the supported floor; everything else the runtime says still reaches stderr.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return
  process.stderr.write(`${warning.name}: ${warning.message}\n`)
})

// SIGINT sets the status and lets the in-flight call finish, so a transaction either
// commits or is abandoned whole rather than being killed half applied (DR5).
process.on('SIGINT', () => {
  process.exitCode = 130
})

// A closed stdout, as under `head`, ends the process with exit 0 and no trace. The listener's
// parameter is `Error`, which carries no `code`; the errno cast is the same one the store's
// filesystem callers use, and it was missing here only because older `@types/node` typed this
// listener as `any` and checked nothing.
process.stdout.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0)
})

const code = await run({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  isTTY: process.stdout.isTTY === true,
  nodeVersion: process.versions.node,
  streams: {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
})

// An interrupt that arrived while the command ran keeps its status.
if (process.exitCode !== EXIT_INTERRUPTED) process.exitCode = code
