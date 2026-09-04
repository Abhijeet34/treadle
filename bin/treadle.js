#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The published entry point. It owns the process and nothing else: argv, the streams, the
// TTY test and the exit status. Everything a test needs to drive is `run`, which takes all
// four as arguments, so the suite never spawns a process to check what a command printed.

import process from 'node:process'

import { run } from '../src/cli/main.ts'

// The runtime's own notices are filtered by name so one can never precede the envelope
// (DR5). node:sqlite is Stability 1.2 and prints one experimental warning per process below
// the supported floor; everything else the runtime says still reaches stderr.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return
  process.stderr.write(`${warning.name}: ${warning.message}\n`)
})

// A closed stdout, as under `head`, ends the process with exit 0 and no trace.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0)
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

process.exitCode = code
