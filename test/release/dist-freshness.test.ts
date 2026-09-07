// SPDX-License-Identifier: Apache-2.0
// The release-integrity gate F6 asked for, exercised from both sides.
//
// `package.json` lists `dist/` in `files`, points `bin` at `dist/treadle.js` and gitignores
// the directory, and nothing built it before a pack. A tree carrying a bundle two days older
// than its source reported fourteen commands where the inventory has nineteen, and a publish
// from it would have shipped that tool with this README.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { distProblems } from '../../scripts/check-dist-fresh.ts'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHECKER = path.join(ROOT, 'scripts', 'check-dist-fresh.ts')

/** A throwaway tree with one source file and one bundle, each with the time it is given. */
async function aTree(sourceAt: Date, bundleAt: Date | undefined): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-dist-'))
  await mkdir(path.join(root, 'src', 'cli'), { recursive: true })
  const source = path.join(root, 'src', 'cli', 'main.ts')
  await writeFile(source, 'export const VERSION = "0.1.0"\n')
  await utimes(source, sourceAt, sourceAt)
  if (bundleAt !== undefined) {
    await mkdir(path.join(root, 'dist'), { recursive: true })
    const bundle = path.join(root, 'dist', 'treadle.js')
    await writeFile(bundle, '#!/usr/bin/env -S node --stack-size=2000\n')
    await utimes(bundle, bundleAt, bundleAt)
  }
  return root
}

const OLD = new Date('2026-09-05T09:00:00Z')
const NEW = new Date('2026-09-07T09:00:00Z')

describe('a bundle older than its source is not packed', () => {
  it('refuses a dist written before the newest source file, and names that file', async () => {
    const root = await aTree(NEW, OLD)
    try {
      const problems = distProblems(root)
      assert.equal(problems.length, 1, `a stale bundle was accepted: ${problems.join('; ')}`)
      assert.match(problems[0] as string, /src\/cli\/main\.ts/, 'the refusal does not name the file that is newer')
      assert.match(problems[0] as string, /npm run build/, 'the refusal does not name the remedy')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('refuses a tree with no bundle at all', async () => {
    const root = await aTree(NEW, undefined)
    try {
      assert.deepEqual(distProblems(root).length, 1)
      assert.match(distProblems(root)[0] as string, /does not exist/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('accepts a bundle written after the newest source file', async () => {
    const root = await aTree(OLD, NEW)
    try {
      assert.deepEqual(distProblems(root), [])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('exits non-zero from the command line on a stale tree, and zero on a fresh one', async () => {
    const stale = await aTree(NEW, OLD)
    const fresh = await aTree(OLD, NEW)
    try {
      await assert.rejects(
        run(process.execPath, [CHECKER, stale]),
        (error: { code?: number; stderr?: string }) => {
          assert.equal(error.code, 1, 'a stale tree exited zero')
          assert.match(error.stderr ?? '', /npm run build/)
          return true
        },
      )
      const ok = await run(process.execPath, [CHECKER, fresh])
      assert.match(ok.stdout, /built from this source/)
    } finally {
      await rm(stale, { recursive: true, force: true })
      await rm(fresh, { recursive: true, force: true })
    }
  })
})

describe('the release path runs that gate, and it is not prepack', () => {
  // A `prepack` is the obvious remedy and would never execute: .npmrc turns the lifecycle off
  // as a supply-chain control and supply-chain.test.ts refuses one in the manifest by name.
  // The clause has to sit in the step the workflow actually runs.
  it('runs the preflight after the build and before the pack', async () => {
    const workflow = await (await import('node:fs/promises'))
      .readFile(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
    const built = workflow.indexOf('npm run build')
    const preflight = workflow.indexOf('scripts/release-preflight.ts')
    const packed = workflow.indexOf('npm pack')
    assert.ok(built >= 0 && preflight >= 0 && packed >= 0, 'the release workflow no longer builds, checks or packs')
    assert.ok(built < preflight, 'the preflight runs before the build, so it would judge the previous bundle')
    assert.ok(preflight < packed, 'the tarball is built before anything checks the bundle going into it')
  })

  it('reads the freshness clause from the same module this file tests', async () => {
    const source = await (await import('node:fs/promises'))
      .readFile(path.join(ROOT, 'scripts', 'release-preflight.ts'), 'utf8')
    assert.match(source, /staleAgainst/, 'the preflight no longer carries the stale-bundle clause')
  })
})
