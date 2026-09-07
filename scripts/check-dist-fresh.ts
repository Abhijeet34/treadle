// SPDX-License-Identifier: Apache-2.0
// Refuses to pack a bundle older than the source it was built from.
//
// Found by walking into it on 2026-09-07: a checked-out tree carried a `dist/treadle.js`
// from 2026-09-05 beside a `src/` from 2026-09-07, and `treadle help` reported fourteen
// commands where the inventory has nineteen. `package.json` lists `dist/` in `files`, points
// `bin` at `dist/treadle.js` and gitignores the directory, and no `prepare`, `prepack` or
// `prepublishOnly` script existed, so `npm pack` in that tree would have shipped the
// fourteen-command tool with a nineteen-command README and nothing would have said so.
//
// THE OBVIOUS REMEDY IS A `prepack`, AND IT WOULD NOT RUN. This repository's `.npmrc` sets
// `ignore-scripts=true` for the whole lifecycle (threat-model finding F13, control one),
// `.github/workflows/release.yml` passes `--ignore-scripts` to its own `npm pack` on top of
// that, and `test/architecture/supply-chain.test.ts` already refuses a manifest that declares
// `preinstall`, `install`, `postinstall`, `prepare` or `prepack` at all, precisely because a
// declared script the lifecycle never executes is a gate that looks green and is not.
//
// So the clause lives where it fires: `scripts/release-preflight.ts` reads `staleAgainst`
// below, and the workflow runs it one step after `npm run build` and one step before it packs.
// This file is also runnable on its own, which is what a developer checking a tree runs.

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** The newest modification time under one directory, in milliseconds, or undefined if empty. */
export function newestUnder(directory: string): { readonly at: number; readonly file: string } | undefined {
  let newest: { at: number; file: string } | undefined
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      const time = statSync(full).mtimeMs
      if (newest === undefined || time > newest.at) newest = { at: time, file: full }
    }
  }
  walk(directory)
  return newest
}

/**
 * The source file newer than the bundle, relative to `root`, or undefined when the bundle is
 * at least as new as every one of them. `release-preflight.ts` reads this: it already refuses
 * an absent or oversized bundle and it is the step the release workflow runs immediately
 * before packing, which is where the clause has to be in this tree.
 */
export function staleAgainst(root: string): string | undefined {
  let built: number
  try {
    built = statSync(path.join(root, 'dist', 'treadle.js')).mtimeMs
  } catch {
    return undefined
  }
  const newest = newestUnder(path.join(root, 'src'))
  return newest === undefined || newest.at <= built ? undefined : path.relative(root, newest.file)
}

/** One line per problem; an empty array means the tarball may be built from this tree. */
export function distProblems(root: string): readonly string[] {
  try {
    statSync(path.join(root, 'dist', 'treadle.js'))
  } catch {
    return ['dist/treadle.js does not exist; run npm run build, which the release workflow runs before its preflight']
  }
  if (newestUnder(path.join(root, 'src')) === undefined) {
    return ['src/ holds no file, so there is nothing this bundle could have been built from']
  }
  const stale = staleAgainst(root)
  if (stale === undefined) return []
  return [
    `dist/treadle.js was written before ${stale} was last changed, `
      + 'so the tarball would carry a bundle that is not this source; run npm run build',
  ]
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const problems = distProblems(root)
  for (const problem of problems) process.stderr.write(`${problem}\n`)
  if (problems.length > 0) process.exit(1)
  process.stdout.write('dist: built from this source\n')
}
