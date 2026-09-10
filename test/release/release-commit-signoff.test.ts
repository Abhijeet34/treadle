// SPDX-License-Identifier: Apache-2.0
// The third break in the release path, found on 2026-09-08 by approving the release pull
// request's parked checks by hand and watching them run for the first time: `checks` is a required
// context on main, and it went red because scripts/check-dco.sh refuses release-please's own
// commit. `chore(main): release 0.1.0` at 95c2511 is authored by github-actions[bot] and
// carries no Signed-off-by trailer, so the release pull request could never merge.
//
// release-please-config.json's `signoff` key is what writes that trailer. This drives the real
// check-dco.sh over a commit built from that key rather than asserting the string, because the
// string only matters if the gate accepts it: a value that no longer matched the author would
// pass a string comparison and fail the release.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The identity release-please commits under: GitHub mints it for the Actions App. */
const BOT = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

describe('the release pull request can pass the sign-off check', () => {
  it('release-please-config.json declares a signoff check-dco.sh accepts', async () => {
    const config = JSON.parse(await readFile(path.join(ROOT, 'release-please-config.json'), 'utf8')) as {
      signoff?: string
    }
    assert.ok(
      config.signoff !== undefined,
      'release-please writes no Signed-off-by without this key, and `checks` is required on main',
    )

    const repo = await mkdtemp(path.join(tmpdir(), 'treadle-signoff-'))
    const git = (...args: string[]): Promise<unknown> => run('git', ['-C', repo, ...args])
    await git('init', '-q', '-b', 'main')
    await git('config', 'user.name', 'A Reviewer')
    await git('config', 'user.email', 'reviewer@example.com')
    await git('config', 'commit.gpgsign', 'false')

    await writeFile(path.join(repo, 'base'), 'base\n')
    await git('add', 'base')
    await git('commit', '-q', '-m', 'chore: base\n\nSigned-off-by: A Reviewer <reviewer@example.com>')
    const { stdout } = await run('git', ['-C', repo, 'rev-parse', 'HEAD'])
    const base = stdout.trim()

    // The commit release-please would produce: its authored identity, its subject shape, and
    // the trailer the `signoff` key appends.
    await writeFile(path.join(repo, 'CHANGELOG.md'), '## 0.1.0\n')
    await git('add', 'CHANGELOG.md')
    await run('git', ['-C', repo, 'commit', '-q', '-m', `chore(main): release 0.1.0\n\nSigned-off-by: ${config.signoff}`], {
      env: { ...process.env, GIT_AUTHOR_NAME: BOT, GIT_AUTHOR_EMAIL: BOT_EMAIL },
    })

    // bash, not sh: check-dco.sh is `#!/usr/bin/env bash` and uses `local`, `[[ ]]` and `<<<`.
    const dco = await run('bash', [path.join(ROOT, 'scripts/check-dco.sh'), base, 'HEAD'], { cwd: repo })
    assert.match(dco.stdout, /^ok {4}[0-9a-f]{8} {2}chore\(main\): release 0\.1\.0$/m, dco.stdout)
    assert.match(dco.stdout, /check-dco: 1 commits checked, 0 without a matching sign-off/, dco.stdout)

    // A sign-off is a DCO attestation, not authorship. Nothing here may name a co-author.
    const message = await run('git', ['-C', repo, 'log', '-1', '--format=%B'])
    assert.doesNotMatch(message.stdout, /^Co-authored-by:/im, message.stdout)
  })
})
