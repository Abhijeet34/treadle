// SPDX-License-Identifier: Apache-2.0
// scripts/check-tests-kept.ts is a CI gate over two git trees, so it is tested the way CI runs
// it: real commits in a throwaway repository, the script invoked with a base and a head, and
// the exit code asserted. The cases that matter are a removal failing, the same removal
// passing once a commit trailer declares it, and a trailer that declares a removal nobody made
// failing, which is what stops the declaration becoming a way to turn the check off.
//
// The last suite here points the reader at this repository instead of a fixture: the gate can
// only compare titles it can read, so a file that stops writing them where it reads them is a
// hole, and it fails here rather than passing quietly in CI.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it, after } from 'node:test'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../../scripts/check-tests-kept.ts', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** No global or system git config reaches these repositories: a commit template or a signing
 *  hook on the machine running the suite would otherwise change what is committed. */
const HERMETIC = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Base', GIT_AUTHOR_EMAIL: 'base@example.com',
  GIT_COMMITTER_NAME: 'Base', GIT_COMMITTER_EMAIL: 'base@example.com',
}

type Tree = Readonly<Record<string, string>>
type Verdict = { readonly code: number; readonly out: string }

const made: string[] = []
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true })
})

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, env: { ...process.env, ...HERMETIC } })
  return stdout
}

async function commit(dir: string, tree: Tree, message: string): Promise<void> {
  for (const [file, body] of Object.entries(tree)) {
    await mkdir(path.join(dir, path.dirname(file)), { recursive: true })
    await writeFile(path.join(dir, file), body)
  }
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '--allow-empty', '-m', message])
}

/** A repository holding `base` on one commit and `head` on the next, and what the gate says
 *  about the range between them. `head` replaces the whole tree, which is what a resolution
 *  that takes a file whole does. */
async function check(base: Tree, head: Tree, message = 'fix: the change'): Promise<Verdict> {
  const dir = await mkdtemp(path.join(tmpdir(), 'treadle-kept-'))
  made.push(dir)
  await git(dir, ['init', '-q', '-b', 'main'])
  await commit(dir, base, 'chore: base')
  const at = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  await rm(path.join(dir, 'test'), { recursive: true, force: true })
  await commit(dir, head, message)

  try {
    const { stdout } = await run('node', [SCRIPT, at, 'HEAD'], { cwd: dir, env: { ...process.env, ...HERMETIC } })
    return { code: 0, out: stdout }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failed.code ?? -1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

const TWO: Tree = {
  'test/a.test.ts': [
    "describe('the criteria a story was filed with', () => {",
    "  it('reads back as the text that was written, not as a tally', () => {})",
    '})',
    '',
  ].join('\n'),
  'test/b.test.ts': [
    "describe('the what column of history', () => {",
    "  it('writes every part as name=value', () => {})",
    '})',
    '',
  ].join('\n'),
}

const ONE: Tree = { 'test/a.test.ts': TWO['test/a.test.ts'] ?? '' }

describe('a branch that drops a test main has is refused', () => {
  it('names the title, the file that declared it and the trailer that would allow it', async () => {
    const verdict = await check(TWO, ONE)
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /FAIL {2}writes every part as name=value/)
    assert.match(verdict.out, /test\/b\.test\.ts declares it at/)
    assert.match(verdict.out, /Removes-test: writes every part as name=value/)
  })

  it('counts a describe as a declaration, so deleting a whole file is every title in it', async () => {
    const verdict = await check(TWO, ONE)
    assert.match(verdict.out, /FAIL {2}the what column of history/)
    assert.match(verdict.out, /2 removed without a Removes-test trailer/)
  })

  it('reads a rename as the removal it is, because the title main had is gone', async () => {
    const renamed: Tree = { ...TWO, 'test/b.test.ts': (TWO['test/b.test.ts'] ?? '').replace('name=value', 'name=from->to') }
    const verdict = await check(TWO, renamed)
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /FAIL {2}writes every part as name=value/)
  })

  it('counts a test the branch turned into a skip, which runs nothing and asserts nothing', async () => {
    const skipped: Tree = { ...TWO, 'test/b.test.ts': (TWO['test/b.test.ts'] ?? '').replace('  it(', '  it.skip(') }
    const verdict = await check(TWO, skipped)
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /declares it \.skip, which runs nothing and asserts nothing/)
  })

  it('compares a title built from a template by its skeleton, so an interpolated name counts', async () => {
    const templated: Tree = {
      'test/a.test.ts': ['describe(`${subject} is refused`, () => {', '})', ''].join('\n'),
    }
    const verdict = await check(templated, { 'test/a.test.ts': 'export {}\n' })
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /FAIL {2}\$\{\} is refused/)
  })
})

describe('a removal that is meant declares itself, once, by exact title', () => {
  it('passes when a commit in the range carries the trailer', async () => {
    const verdict = await check(TWO, ONE, [
      'fix: drop the history convention test',
      '',
      'Removes-test: the what column of history',
      'Removes-test: writes every part as name=value',
    ].join('\n'))
    assert.equal(verdict.code, 0, verdict.out)
    assert.match(verdict.out, /ok {4}declared {2}the what column of history/)
  })

  it('still refuses the titles the trailers did not name, so one trailer covers one test', async () => {
    const verdict = await check(TWO, ONE, 'fix: drop it\n\nRemoves-test: the what column of history\n')
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /FAIL {2}writes every part as name=value/)
    assert.match(verdict.out, /1 removed without a Removes-test trailer, 1 declared/)
  })

  it('refuses a trailer that names a removal nobody made, so it cannot be written ahead of time', async () => {
    const verdict = await check(TWO, TWO, 'fix: nothing\n\nRemoves-test: a test nobody wrote\n')
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /the declaration names nothing/)
  })
})

describe('the comparison refuses to pass on nothing', () => {
  it('accepts a base with no test files at all, which is a repository on its first commit', async () => {
    const verdict = await check({ 'README.md': 'first\n' }, TWO)
    assert.equal(verdict.code, 0, verdict.out)
  })

  it('refuses a base whose test files declare no test, which means the reader is broken', async () => {
    const verdict = await check({ 'test/a.test.ts': 'export {}\n' }, TWO)
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /1 files under test\/ and no test in any of them/)
  })

  it('names a declaration it cannot read rather than passing over it', async () => {
    const hidden: Tree = { 'test/a.test.ts': "const run = () => it('is hidden mid-line', () => {})\n" }
    const verdict = await check(TWO, { ...TWO, ...hidden })
    assert.equal(verdict.code, 1)
    assert.match(verdict.out, /a describe, it or test call here does not open its line/)
  })
})

describe('this repository keeps its side of the bargain', () => {
  it('declares every test where the gate reads it, so nothing is invisible to the comparison', async () => {
    const { stdout } = await run('node', [SCRIPT, 'HEAD', 'HEAD'], { cwd: ROOT })
    assert.doesNotMatch(stdout, /does not open its line/)
    const compared = /: (\d+) tests at/.exec(stdout)?.[1]
    assert.ok(Number(compared) > 700, `only ${String(compared)} titles are readable`)
  })
})
