// SPDX-License-Identifier: Apache-2.0
// The release-integrity gate F6 asked for, exercised from both sides.
//
// `package.json` lists `dist/` in `files`, points `bin` at `dist/treadle.js` and gitignores
// the directory, and nothing built it before a pack. A tree carrying a bundle two days older
// than its source reported fourteen commands where the inventory has nineteen, and a publish
// from it would have shipped that tool with this README.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { distProblems, staleAgainst } from '../../scripts/check-dist-fresh.ts'
import { preflight } from '../../scripts/release-preflight.ts'
import { workflowOf } from '../helpers/workflow.ts'
import { POSIX_MODES } from '../helpers/platform.ts'

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
    await chmod(bundle, 0o755)
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

  // Found by rebuilding and then running ./dist/treadle.js: esbuild writes 0644, so the
  // shebang that chooses the runtime's stack size was never read from a checkout.
  it('refuses a bundle the kernel would not read the shebang of', { skip: POSIX_MODES }, async () => {
    const root = await aTree(OLD, NEW)
    try {
      await chmod(path.join(root, 'dist', 'treadle.js'), 0o644)
      assert.match(distProblems(root)[0] as string, /not executable/)
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
  // The clause has to sit in the step the workflow actually runs, so this asserts about the
  // job's own ordered steps rather than about where three substrings fall in the file.
  it('runs the preflight after the build and before the pack', () => {
    const job = workflowOf(ROOT, 'release.yml')['artifacts']
    assert.ok(job !== undefined, 'release.yml no longer has an artifacts job')
    const at = (want: string): number =>
      job.steps.findIndex((step) => (step.run ?? '').includes(want))
    const built = at('npm run build')
    const preflight = at('scripts/release-preflight.ts')
    const packed = at('npm pack')
    assert.ok(built >= 0, 'the artifacts job no longer builds the bundle')
    assert.ok(preflight >= 0, 'the artifacts job no longer runs the release preflight')
    assert.ok(packed >= 0, 'the artifacts job no longer packs a tarball')
    assert.ok(built < preflight, `build is step ${built} and the preflight step ${preflight}, so it judges the previous bundle`)
    assert.ok(preflight < packed, `the preflight is step ${preflight} and the pack step ${packed}, so the tarball is built before anything checks it`)
  })

  // The preflight and the freshness check are two modules, and what matters is that the one
  // the workflow runs actually asks the other. This runs both: a real stale tree through
  // `staleAgainst`, and its answer through the real `preflight`.
  it('carries a stale bundle from the checker into a preflight problem', async () => {
    const root = await aTree(NEW, OLD)
    try {
      const stale = staleAgainst(root)
      // Repository-relative with `/` on every platform, so the sentence the preflight prints
      // reads the same everywhere: it already names `dist/treadle.js` that way.
      assert.equal(stale, 'src/cli/main.ts', 'the checker did not find the newer source file')
      const problems = preflight({
        tag: 'v0.1.0',
        facts: { commit: 'abc', onReleaseBranch: true },
        releasedCommit: 'abc',
        manifest: { version: '0.1.0', license: 'Apache-2.0', files: ['dist/'], bin: { treadle: 'dist/treadle.js' }, repository: 'https://github.com/Abhijeet34/treadle' },
        bundleBytes: 362429,
        bundleLimit: 512000,
        staleAgainst: stale,
        publishing: false,
      })
      assert.equal(problems.length, 1, `the preflight did not refuse a stale bundle: ${problems.join('; ')}`)
      assert.match(problems[0] as string, /src\/cli\/main\.ts/)
      assert.match(problems[0] as string, /npm run build/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
