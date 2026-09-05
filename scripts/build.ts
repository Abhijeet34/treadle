// SPDX-License-Identifier: Apache-2.0
// DR1's build: one bundled entry file, at most 500 KB, built with esbuild. The limit is not
// written here. It is read from bench/budgets.json, so the build and `npm run bench:gate`
// weigh the bundle against the same number and cannot drift apart.

import { build } from 'esbuild'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = path.join(root, 'dist', 'treadle.js')

const budgets = JSON.parse(readFileSync(path.join(root, 'bench', 'budgets.json'), 'utf8')) as {
  absolute: Record<string, { limit: number; source: string }>
}
const budget = budgets.absolute['bundleBytes']
if (budget === undefined) throw new Error('bench/budgets.json has no absolute.bundleBytes budget')

await build({
  entryPoints: [path.join(root, 'src', 'cli', 'entry.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  // The floor package.json declares. esbuild then leaves syntax this runtime already has,
  // which is why the bundle is close to the size of the source it carries.
  target: 'node24.15',
  // Not minified, and not source-mapped. A stack trace in a bug report from a machine we
  // cannot reach is worth more than the bytes either would save, and the measured size below
  // is 2.8x under the budget, so there is nothing to buy.
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'inline',
})

const bytes = statSync(outfile).size
const over = bytes > budget.limit
console.log(
  `bundle: ${bytes} bytes against ${budget.limit} (${budget.source}), ` +
    `${over ? 'OVER' : `${(budget.limit / bytes).toFixed(1)}x under`}`,
)
if (over) process.exitCode = 1
