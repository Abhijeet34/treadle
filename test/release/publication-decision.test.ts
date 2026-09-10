// SPDX-License-Identifier: Apache-2.0
// The `publish` job is gated on `vars.NPM_PUBLISH_ENABLED`, the repository has no Actions
// variables at all, and a job whose `if:` is false is skipped rather than reported. So the
// Release run concluded success having published nothing, `smoke` skipped behind `publish`, and
// the release page said only that three assets existed.
//
// It misled twice rather than once. A reader who set the variable to lift that block still got
// nothing, because `package.json` carried `"private": true` and the publishing preflight refused
// a step later; neither block was named anywhere on the run. That field has since been removed,
// which is why the scenarios below drive both manifests: the report has to be right about the
// tree the tag names rather than about the tree this file was written against.
//
// These tests drive the `publication` job's own shell, read out of .github/workflows/release.yml,
// so what runs here is the text CI runs rather than a copy of it that can drift. `gh` is a stub
// that answers from fixture files, applies the job's real `--jq` filters to them, and keeps the
// body the job asked it to write, so an assertion names what the release would actually say.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'
import { workflowOf } from '../helpers/workflow.ts'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const REPO = 'owner/repo'
const RUN_ID = '34288199967'
const TAG = 'v0.1.0'
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN_ID}`
const NOTES = '## 0.1.0 (2026-09-09)\n\n### Features\n\n* the release notes the artifacts job wrote\n'

const JOB = workflowOf(ROOT, 'release.yml')['publication']

// Answers `gh release view --json body`, `gh release edit --notes-file` and the environment
// read, and applies whatever `--jq` the job passed to the fixture rather than pre-computing the
// answer, so the filters in the workflow are the ones under test. A missing `environment`
// fixture is the 404 an environment that has never been created returns.
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"

fixture=""
case "$1 $2" in
  "api repos/"*) fixture="\$GH_FIXTURES/environment" ;;
  "release view") fixture="\$GH_FIXTURES/release" ;;
  "release edit")
    while [ $# -gt 0 ]; do
      if [ "$1" = "--notes-file" ]; then cp "$2" "\$GH_FIXTURES/edited"; fi
      shift
    done
    exit 0
    ;;
esac
if [ -z "\$fixture" ] || [ ! -f "\$fixture" ]; then
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi

filter=""
prev=""
for arg in "$@"; do
  if [ "\$prev" = "--jq" ]; then filter="\$arg"; fi
  prev="\$arg"
done
if [ -n "\$filter" ]; then jq -r "\$filter" "\$fixture"; else cat "\$fixture"; fi
`

type Scenario = {
  /** `needs.publish.result`: what the publish job did, or did not do. */
  readonly publishResult: string
  /** `vars.NPM_PUBLISH_ENABLED`, empty for the variable this repository does not have. */
  readonly enabled?: string
  readonly private?: boolean
  /** The release body the job reads back, defaulting to the notes `artifacts` wrote. */
  readonly body?: string
  /** The `npm-publish` environment payload, absent for an environment that does not exist. */
  readonly environment?: string
}

type Result = {
  readonly code: number
  readonly stdout: string
  readonly summary: string
  readonly body: string | undefined
  readonly calls: readonly string[]
}

/** Runs the job's step against that scenario, and reports what it said and what it wrote. */
async function drive(scenario: Scenario): Promise<Result> {
  const dir = await mkdtemp(path.join(tmpdir(), 'treadle-publication-'))
  const bin = path.join(dir, 'bin')
  const fx = path.join(dir, 'fixtures')
  const runnerTemp = path.join(dir, 'runner-temp')
  for (const made of [bin, fx, runnerTemp]) await mkdir(made)
  await writeFile(path.join(bin, 'gh'), STUB)
  await chmod(path.join(bin, 'gh'), 0o755)

  await writeFile(
    path.join(fx, 'release'),
    JSON.stringify({ body: scenario.body ?? NOTES }),
  )
  if (scenario.environment !== undefined) {
    await writeFile(path.join(fx, 'environment'), scenario.environment)
  }
  // The one field the job checks out the tagged tree for.
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'treadle', version: '0.1.0', private: scenario.private ?? true })}\n`,
  )

  const log = path.join(dir, 'calls')
  const summary = path.join(dir, 'summary.md')
  const script = path.join(dir, 'step.sh')
  await writeFile(log, '')
  await writeFile(summary, '')
  const step = JOB?.steps.find((candidate) => candidate.run !== undefined)
  assert.ok(step?.run !== undefined, 'release.yml no longer has a publication step with a run body')
  await writeFile(script, step.run)

  const env: Record<string, string> = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    GH_LOG: log,
    GH_FIXTURES: fx,
    RUNNER_TEMP: runnerTemp,
    GITHUB_REPOSITORY: REPO,
    GITHUB_STEP_SUMMARY: summary,
    GH_TOKEN: 'gh-token-stub',
    TAG,
    PUBLISH_RESULT: scenario.publishResult,
    PUBLISH_ENABLED: scenario.enabled ?? '',
    SUMMARY_URL: RUN_URL,
  }
  let code = 0
  let stdout = ''
  try {
    stdout = (await run('bash', [script], { cwd: dir, env })).stdout
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    code = failure.code ?? 1
    stdout = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }
  return {
    code,
    stdout,
    summary: await readFile(summary, 'utf8'),
    body: await readFile(path.join(fx, 'edited'), 'utf8').catch(() => undefined),
    calls: (await readFile(log, 'utf8')).split('\n').filter((line) => line.length > 0),
  }
}

/** The `## Publication` section of the body the job wrote back to the release. */
function section(result: Result): string {
  const body = result.body ?? ''
  const at = body.indexOf('## Publication')
  assert.ok(at >= 0, `the release body carries no Publication section:\n${body}`)
  return body.slice(at)
}

describe('a release that published nothing says so, and names every block', () => {
  // The state the report was built for: zero Actions variables and a private manifest. Both
  // blocks apply, and reporting only the first is the defect.
  it('names both blocks when the variable is absent and the package is private', async () => {
    const result = await drive({ publishResult: 'skipped', private: true })

    assert.equal(result.code, 0, `the job failed:\n${result.stdout}`)
    const said = section(result)
    assert.match(said, /`v0\.1\.0` was not published to npm/)
    assert.match(said, /`NPM_PUBLISH_ENABLED` is unset, not `true`/)
    assert.match(said, /carries `"private": true`/)
    assert.match(said, /rather than the first one to stop it/)
  })

  // The half that made it misleading twice. Setting the variable lifts one block and leaves the
  // other standing, so the report has to keep naming the one the reader did not lift.
  it('still names the private interlock once the variable has been set', async () => {
    const result = await drive({ publishResult: 'failure', enabled: 'true' })

    assert.equal(result.code, 0, `the job failed:\n${result.stdout}`)
    const said = section(result)
    assert.doesNotMatch(said, /NPM_PUBLISH_ENABLED/)
    assert.match(said, /carries `"private": true`/)
    assert.match(said, /ended `failure`/)
    assert.match(said, /Setting the variable above does not lift this one/)
  })

  // The repository state from 2026-09-10 on: no Actions variables, and a manifest that no longer
  // carries `private`. One block stands, and naming a lifted one would be as wrong as hiding one.
  it('names the variable alone once the manifest no longer carries private', async () => {
    const result = await drive({ publishResult: 'skipped', private: false })

    assert.equal(result.code, 0, `the job failed:\n${result.stdout}`)
    const said = section(result)
    assert.match(said, /`v0\.1\.0` was not published to npm/)
    assert.match(said, /`NPM_PUBLISH_ENABLED` is unset, not `true`/)
    assert.doesNotMatch(said, /"private": true/)
  })

  it('reports a variable set to something that is not true, rather than calling it unset', async () => {
    const result = await drive({ publishResult: 'skipped', enabled: 'false' })

    assert.match(section(result), /`NPM_PUBLISH_ENABLED` is `false`, not `true`/)
  })

  it('says it published, and claims nothing about installing it', async () => {
    const result = await drive({ publishResult: 'success', enabled: 'true', private: false })

    assert.equal(result.code, 0, `the job failed:\n${result.stdout}`)
    const said = section(result)
    assert.match(said, /was published to npm by the `publish` job/)
    assert.match(said, /The `smoke` job is what checks that it installs/)
    assert.doesNotMatch(said, /standing in front of publication/)
    assert.match(result.stdout, /^::notice::v0\.1\.0 was published to npm$/m)
  })

  it('warns on the run when nothing was published, and does not redden the release', async () => {
    const nothing = await drive({ publishResult: 'skipped' })
    assert.equal(nothing.code, 0)
    assert.match(nothing.stdout, /^::warning::v0\.1\.0 published nothing to npm; 2 condition\(s\)/m)
    assert.match(nothing.summary, /## Publication/)

    const published = await drive({ publishResult: 'success', enabled: 'true', private: false })
    assert.doesNotMatch(published.stdout, /::warning::/)
  })

  it('treats a publish result it cannot read as unpublished', async () => {
    const result = await drive({ publishResult: 'neutral', enabled: 'true', private: false })

    assert.match(section(result), /Treat `v0\.1\.0` as unpublished until someone checks the registry/)
  })

  // The release notes are the reason anyone opens the release. Appending must not eat them.
  it('keeps the release notes the artifacts job wrote', async () => {
    const result = await drive({ publishResult: 'skipped' })

    assert.ok(result.body?.startsWith('## 0.1.0 (2026-09-09)'), `body starts:\n${result.body}`)
    assert.match(result.body ?? '', /the release notes the artifacts job wrote/)
  })

  // A re-run of the job is an ordinary thing, and two Publication sections on one release would
  // be worse than none: a reader cannot tell which one is current.
  it('replaces its own section rather than stacking a second one', async () => {
    const first = await drive({ publishResult: 'skipped' })
    const second = await drive({ publishResult: 'success', enabled: 'true', private: false, body: first.body })

    const body = second.body ?? ''
    assert.equal(body.split('## Publication').length - 1, 1, `two sections:\n${body}`)
    assert.match(body, /was published to npm by the `publish` job/)
    assert.doesNotMatch(body, /was not published to npm/)
    // The gap before the section stays one blank line however many times this runs.
    assert.doesNotMatch(body, /\n\n\n/)
  })

  // "Could not read" and "requires a reviewer" are opposite answers about the third interlock
  // docs/RELEASING.md names, and an environment that does not exist is created on first use with
  // no protection rules at all. Printing them as the same sentence would assert a gate that is
  // not there, which is the defect this job exists to remove.
  it('reports the reviewer interlock it read, and claims none it could not', async () => {
    const missing = await drive({ publishResult: 'skipped' })
    assert.match(section(missing), /could not be read here/)
    assert.match(section(missing), /created on first use carrying no protection rules/)

    const empty = await drive({ publishResult: 'skipped', environment: JSON.stringify({ protection_rules: [] }) })
    assert.match(section(empty), /carries no required-reviewer rule, so it would stop nothing/)

    const guarded = await drive({
      publishResult: 'skipped',
      environment: JSON.stringify({ protection_rules: [{ type: 'required_reviewers' }, { type: 'wait_timer' }] }),
    })
    assert.match(section(guarded), /carries 1 required-reviewer rule\(s\)/)
  })

  it('publishes nothing and holds no credential of its own', () => {
    assert.deepEqual(JOB?.permissions, { contents: 'write' })
    assert.equal(JOB?.environment, undefined)
    const calls = JOB?.steps.flatMap((step) => (step.run === undefined ? [] : [step.run])).join('\n') ?? ''
    assert.doesNotMatch(calls, /npm publish|NODE_AUTH_TOKEN|registry\.npmjs\.org/)
  })

  // Without `always()` this job is skipped by the same skipped `publish` it exists to report on,
  // which is the whole defect wearing a different hat. The `artifacts` guard is there because a
  // failed `artifacts` leaves no release to write onto.
  it('runs even when the job it reports on was skipped', () => {
    assert.deepEqual(JOB?.needs, ['artifacts', 'publish'])
    assert.match(JOB?.ifExpr ?? '', /always\(\)/)
    assert.match(JOB?.ifExpr ?? '', /needs\.artifacts\.result == 'success'/)
    assert.match(JOB?.ifExpr ?? '', /startsWith\(github\.ref, 'refs\/tags\/v'\)/)
  })
})
