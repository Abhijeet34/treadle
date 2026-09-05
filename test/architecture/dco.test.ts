// SPDX-License-Identifier: Apache-2.0
// scripts/check-dco.sh is a CI gate over commits, so it is tested the way CI runs it: real
// commits in a throwaway repository, the script invoked with a base and a head, and the
// process exit code asserted. The two that matter are a Dependabot-shaped commit passing and
// a commit whose trailer names a different person still failing; the rest fence the widening
// so it cannot be reached by choosing an author name.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../../scripts/check-dco.sh', import.meta.url))

/** No global or system git config reaches these repositories: a signing hook or a commit
 *  template on the machine running the suite would otherwise change what is committed. */
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

type Commit = {
  readonly subject: string
  readonly author: string
  readonly email: string
  readonly signoff?: string
}

type Verdict = { readonly code: number; readonly output: string }

async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, env: { ...process.env, ...HERMETIC, ...env } })
  return stdout
}

/** Builds a repository holding one base commit and then `commits`, and reports what
 *  check-dco.sh says about the range between them. */
async function check(commits: readonly Commit[]): Promise<Verdict> {
  const dir = await mkdtemp(path.join(tmpdir(), 'treadle-dco-'))
  try {
    await git(dir, ['init', '-q', '-b', 'main'])
    await writeFile(path.join(dir, 'base'), 'base\n')
    await git(dir, ['add', 'base'])
    await git(dir, ['commit', '-q', '-m', 'chore: base'], {
      GIT_AUTHOR_NAME: 'Base', GIT_AUTHOR_EMAIL: 'base@example.com',
      GIT_COMMITTER_NAME: 'Base', GIT_COMMITTER_EMAIL: 'base@example.com',
    })
    const base = (await git(dir, ['rev-parse', 'HEAD'])).trim()

    for (const [n, commit] of commits.entries()) {
      const message = commit.signoff === undefined
        ? commit.subject
        : `${commit.subject}\n\nSigned-off-by: ${commit.signoff}\n`
      await writeFile(path.join(dir, `file-${n}`), `${n}\n`)
      await git(dir, ['add', `file-${n}`])
      await git(dir, ['commit', '-q', '-m', message], {
        GIT_AUTHOR_NAME: commit.author, GIT_AUTHOR_EMAIL: commit.email,
        // GitHub commits every App's push itself, so the committer is never the author here.
        GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com',
      })
    }

    try {
      const { stdout } = await run('bash', [SCRIPT, base, 'HEAD'], { cwd: dir, env: { ...process.env, ...HERMETIC } })
      return { code: 0, output: stdout }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string }
      return { code: failure.code ?? -1, output: failure.stdout ?? '' }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const DEPENDABOT: Commit = {
  subject: 'ci(deps): bump the actions group with 3 updates',
  author: 'dependabot[bot]',
  email: '49699333+dependabot[bot]@users.noreply.github.com',
  signoff: 'dependabot[bot] <support@github.com>',
}

describe('the developer certificate check', () => {
  it('passes a commit whose trailer matches its author exactly', async () => {
    const verdict = await check([{
      subject: 'fix: a real change',
      author: 'Dana Okafor',
      email: 'dana@example.com',
      signoff: 'Dana Okafor <dana@example.com>',
    }])
    assert.equal(verdict.code, 0, verdict.output)
  })

  it('passes a Dependabot commit, which signs off from a different address than it authors from', async () => {
    const verdict = await check([DEPENDABOT])
    assert.equal(verdict.code, 0, verdict.output)
  })

  it('refuses a commit whose trailer names a different person', async () => {
    const verdict = await check([{
      subject: 'fix: a real change',
      author: 'Dana Okafor',
      email: 'dana@example.com',
      signoff: 'Kim Alvarez <kim@example.com>',
    }])
    assert.equal(verdict.code, 1)
    assert.match(verdict.output, /no matching Signed-off-by trailer/)
  })

  it('refuses a commit whose trailer names its author under a different address', async () => {
    const verdict = await check([{
      subject: 'fix: a real change',
      author: 'Dana Okafor',
      email: 'dana@example.com',
      signoff: 'Dana Okafor <dana@personal.example>',
    }])
    assert.equal(verdict.code, 1)
  })

  it('refuses a commit that merely calls itself a bot', async () => {
    const verdict = await check([{
      subject: 'ci(deps): bump something',
      author: 'dependabot[bot]',
      email: 'dana@example.com',
      signoff: 'dependabot[bot] <support@github.com>',
    }])
    assert.equal(verdict.code, 1)
  })

  it('refuses a commit whose App address names an App other than its author', async () => {
    const verdict = await check([{
      subject: 'ci(deps): bump something',
      author: 'dependabot[bot]',
      email: '1234+renovate[bot]@users.noreply.github.com',
      signoff: 'dependabot[bot] <support@github.com>',
    }])
    assert.equal(verdict.code, 1)
  })

  it('refuses an App commit whose trailer names a different signer', async () => {
    const verdict = await check([{ ...DEPENDABOT, signoff: 'Kim Alvarez <kim@example.com>' }])
    assert.equal(verdict.code, 1)
  })

  it('refuses a commit carrying no trailer at all', async () => {
    const verdict = await check([{ subject: 'fix: a real change', author: 'Dana Okafor', email: 'dana@example.com' }])
    assert.equal(verdict.code, 1)
  })
})
