// SPDX-License-Identifier: Apache-2.0
// scripts/apply-repo-settings.sh half-applied: it stopped at the first refusal, so a rejected
// tag ruleset skipped the repository settings and both Actions permission calls and still
// exited 1, leaving the repository in a state the exit code could not describe. These tests
// drive the real script with a gh-axi stub on PATH, so what is asserted is the calls it
// actually makes and what it says about the ones that failed.
//
// The stub logs every invocation and refuses the ones whose argument line contains
// GH_AXI_FAIL, which is how a single forge refusal is reproduced without a forge.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = path.join(ROOT, 'scripts/apply-repo-settings.sh')
const REPO = 'owner/repo'

const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_AXI_LOG"
if [ -n "\${GH_AXI_FAIL:-}" ]; then
  case "$*" in
    *"$GH_AXI_FAIL"*) echo "gh-axi: HTTP 422 Validation error" >&2; exit 1 ;;
  esac
fi
exit 0
`

type Result = { readonly code: number; readonly stderr: string; readonly calls: readonly string[] }

/** Runs the script against a gh-axi that refuses every call whose argument line contains
 *  `refuse`, and reports the exit code, the stderr and every call it made. */
async function apply(refuse = ''): Promise<Result> {
  const dir = await mkdtemp(path.join(tmpdir(), 'treadle-settings-'))
  const log = path.join(dir, 'calls')
  await writeFile(path.join(dir, 'gh-axi'), STUB)
  await chmod(path.join(dir, 'gh-axi'), 0o755)
  await writeFile(log, '')

  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, GH_AXI_LOG: log, GH_AXI_FAIL: refuse }
  let code = 0
  let stderr = ''
  try {
    const done = await run('sh', [SCRIPT, REPO], { env })
    stderr = done.stderr
  } catch (error) {
    const failure = error as { code?: number; stderr?: string }
    code = failure.code ?? 1
    stderr = failure.stderr ?? ''
  }
  const calls = (await readFile(log, 'utf8')).split('\n').filter((line) => line.length > 0)
  return { code, stderr, calls }
}

/** The five calls that change something, as opposed to the two that only read the ruleset
 *  list. Each is identified by the file whose contents it sends. */
const WRITES = [
  '.github/rulesets/main.json',
  '.github/rulesets/tags.json',
  '.github/settings/repository.json',
  '.github/settings/actions-workflow-permissions.json',
  '.github/settings/actions-permissions.json',
]

function sent(calls: readonly string[], file: string): boolean {
  return calls.some((call) => call.includes(`--input ${file}`) && call.includes('-X '))
}

describe('apply-repo-settings.sh', () => {
  it('applies every setting it names and exits 0 when the forge accepts them', async () => {
    const { code, calls, stderr } = await apply()
    for (const file of WRITES) assert.ok(sent(calls, file), `${file} was never sent: ${calls.join(' | ')}`)
    assert.equal(code, 0)
    assert.equal(stderr, '')
  })

  it('applies everything else when one call is refused, rather than stopping there', async () => {
    const { code, calls, stderr } = await apply('--input .github/rulesets/tags.json')
    // The three that used to be skipped, because they follow the tag ruleset in the script.
    for (const file of WRITES.slice(2)) {
      assert.ok(sent(calls, file), `${file} was skipped after an earlier failure: ${calls.join(' | ')}`)
    }
    assert.equal(code, 1)
    assert.match(stderr, /did NOT apply:/)
    assert.match(stderr, /release tags from \.github\/rulesets\/tags\.json/)
    assert.doesNotMatch(stderr, /repository\.json/)
  })

  it('names every failure, not only the first', async () => {
    const { code, stderr } = await apply('.json')
    assert.equal(code, 1)
    for (const file of WRITES) assert.ok(stderr.includes(file), `${file} is missing from: ${stderr}`)
  })
})

describe('.github/rulesets/tags.json', () => {
  // GitHub refuses tag_name_pattern on this repository with HTTP 422, in every shape and
  // operator tried, so the whole settings script failed on every run while it was in the file.
  // docs/RELEASING.md carries the isolation; this keeps it from coming back from the API docs.
  it('carries no tag_name_pattern rule', async () => {
    const ruleset = JSON.parse(await readFile(path.join(ROOT, '.github/rulesets/tags.json'), 'utf8')) as {
      rules: readonly { type: string }[]
    }
    const types = ruleset.rules.map((rule) => rule.type)
    assert.ok(!types.includes('tag_name_pattern'), `tag naming is enforced in the release workflow, not here: ${types.join(', ')}`)
    assert.deepEqual(types, ['update', 'deletion', 'required_signatures'])
  })
})
