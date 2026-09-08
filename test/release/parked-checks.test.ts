// SPDX-License-Identifier: Apache-2.0
// The `parked-checks` job shipped without a test and failed every Release run on main from
// the push that introduced it: 34277320540, 34281238907 and 34288199967, each on this job,
// each correct about a state ADR-0009 makes permanent. What was wrong was where it said so.
//
// These tests drive the job's own shell, read out of .github/workflows/release.yml, so what
// runs here is the text CI runs rather than a copy of it that can drift. `gh` is a stub that
// answers from fixture files and logs every call, so an assertion names the request the job
// actually sent.

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
const HEAD = 'aaaa1111'
const CONTEXT_NAME = 'release checks approved'

const JOB = workflowOf(ROOT, 'release.yml')['parked-checks']

// `count-<sha>` is what the forge reports for that head sha over time, one line per read, the
// last line standing once the timeline runs out. Both reads consult it and neither is
// privileged: while it reads 0 the head has no runs at all, so the parked-run read is empty
// too. That is the shape of the real gap, where GitHub has not yet created the runs for
// release-please's push. `runs-<sha>` is the parked list once they exist.
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
sha=\$(printf '%s' "$*" | sed -n 's/.*head_sha=\\([0-9a-z]*\\).*/\\1/p')
counts="\$GH_FIXTURES/count-\$sha"
total=0
if [ -s "\$counts" ]; then
  total=\$(head -n 1 "\$counts")
  if [ "\$(wc -l < "\$counts")" -gt 1 ]; then
    tail -n +2 "\$counts" > "\$counts.rest"
    mv "\$counts.rest" "\$counts"
  fi
fi
case "$*" in
  *"/pulls?"*) cat "\$GH_FIXTURES/pulls" 2>/dev/null ;;
  *total_count*) echo "\$total" ;;
  *"/actions/runs?"*)
    [ "\$total" = "0" ] || cat "\$GH_FIXTURES/runs-\$sha" 2>/dev/null
    ;;
esac
exit 0
`

type Result = {
  readonly code: number
  readonly stdout: string
  readonly summary: string
  readonly calls: readonly string[]
}

/** Runs the job's step against a `gh` answering from `fixtures`, and reports what it did. */
async function drive(fixtures: Record<string, string>): Promise<Result> {
  const dir = await mkdtemp(path.join(tmpdir(), 'treadle-parked-'))
  const bin = path.join(dir, 'bin')
  const fx = path.join(dir, 'fixtures')
  await mkdir(bin)
  await mkdir(fx)
  await writeFile(path.join(bin, 'gh'), STUB)
  await chmod(path.join(bin, 'gh'), 0o755)
  for (const [name, body] of Object.entries(fixtures)) await writeFile(path.join(fx, name), body)

  const log = path.join(dir, 'calls')
  const summary = path.join(dir, 'summary.md')
  const script = path.join(dir, 'step.sh')
  await writeFile(log, '')
  await writeFile(summary, '')
  const body = JOB?.steps[0]?.run
  assert.ok(body !== undefined, 'release.yml no longer has a parked-checks step with a run body')
  await writeFile(script, body)

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    GH_LOG: log,
    GH_FIXTURES: fx,
    GITHUB_REPOSITORY: REPO,
    GITHUB_STEP_SUMMARY: summary,
    // The two values release.yml's `env:` block composes from the run's own context. The
    // assertions below check that the workflow still composes them; here they are the
    // literals it would have expanded to.
    CONTEXT: CONTEXT_NAME,
    SUMMARY_URL: `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
  }
  let code = 0
  let stdout = ''
  try {
    stdout = (await run('bash', [script], { cwd: dir, env })).stdout
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    code = failure.code ?? 1
    stdout = failure.stdout ?? ''
  }
  return {
    code,
    stdout,
    summary: await readFile(summary, 'utf8'),
    calls: (await readFile(log, 'utf8')).split('\n').filter((line) => line.length > 0),
  }
}

/** The status posts the job made, in order, as the argument line the stub was called with. */
function statuses(result: Result): readonly string[] {
  return result.calls.filter((line) => line.includes(`/statuses/`))
}

describe('the release pull request carries its own parked state', () => {
  it('reports a parked pull request without reddening the Release run on main', async () => {
    const result = await drive({
      pulls: `69\t${HEAD}\n`,
      [`count-${HEAD}`]: '2\n',
      [`runs-${HEAD}`]: '111\tCI\n222\tsecret scan\n',
    })

    assert.equal(result.code, 0, `the job failed main:\n${result.stdout}`)
    const posted = statuses(result)
    assert.equal(posted.length, 1, `expected one status post, got ${JSON.stringify(posted)}`)
    assert.match(posted[0] as string, new RegExp(`/statuses/${HEAD}\\b`))
    assert.match(posted[0] as string, /state=failure/)
    assert.match(posted[0] as string, new RegExp(`context=${CONTEXT_NAME}`))
    // Behavioural, not textual: the summary prints the approve command for a person to run,
    // so only the calls the job actually made can say that it approved nothing itself.
    assert.deepEqual(result.calls.filter((line) => line.includes('/approve')), [])
  })

  it('sends the reader to the summary that carries the approve command', async () => {
    const result = await drive({
      pulls: `69\t${HEAD}\n`,
      [`count-${HEAD}`]: '2\n',
      [`runs-${HEAD}`]: '111\tCI\n222\tsecret scan\n',
    })

    assert.match(statuses(result)[0] as string, new RegExp(`actions/runs/${RUN_ID}`))
    assert.match(result.summary, /gh api -X POST repos\/owner\/repo\/actions\/runs\/111\/approve/)
    assert.match(result.summary, /gh api -X POST repos\/owner\/repo\/actions\/runs\/222\/approve/)
  })

  it('clears the state once the runs are no longer parked', async () => {
    const result = await drive({ pulls: `69\t${HEAD}\n`, [`count-${HEAD}`]: '8\n' })

    assert.equal(result.code, 0)
    assert.match(statuses(result)[0] as string, /state=success/)
    assert.equal(result.summary, '', 'a clear pull request should write no summary')
  })

  // Measured on run 34288199967: release-pr completed at 22:56:53Z and the two runs on the
  // head it had just pushed were created at 22:56:55Z. A read that lands in that gap sees no
  // runs at all, and reporting clear there would put a green tick on a parked pull request -
  // the one answer this must not give.
  it('waits rather than reporting clear on a head whose runs have not appeared', async () => {
    const result = await drive({
      pulls: `69\t${HEAD}\n`,
      [`count-${HEAD}`]: '0\n2\n',
      [`runs-${HEAD}`]: '111\tCI\n',
    })

    assert.match(statuses(result)[0] as string, /state=failure/)
  })

  // The last line of `gh --jq @tsv` output has no trailing newline, which leaves `read` at
  // exit 1 with the fields already set. Without the `|| [ -n ... ]` guard the loop drops it,
  // and a lone parked pull request would be reported as clear.
  it('reads a final pull request line that has no newline', async () => {
    const result = await drive({
      pulls: `69\t${HEAD}`,
      [`count-${HEAD}`]: '2\n',
      [`runs-${HEAD}`]: '111\tCI\n',
    })

    assert.match(statuses(result)[0] as string, /state=failure/)
  })

  it('answers for each release pull request on its own head', async () => {
    const other = 'bbbb2222'
    const result = await drive({
      pulls: `69\t${HEAD}\n70\t${other}\n`,
      [`count-${HEAD}`]: '2\n',
      [`runs-${HEAD}`]: '111\tCI\n',
      [`count-${other}`]: '8\n',
    })

    const posted = statuses(result)
    assert.equal(posted.length, 2)
    assert.match(posted[0] as string, new RegExp(`/statuses/${HEAD} .*state=failure`))
    assert.match(posted[1] as string, new RegExp(`/statuses/${other} .*state=success`))
    assert.match(result.summary, /#69 is waiting/)
    assert.doesNotMatch(result.summary, /#70 is waiting/)
  })

  it("ignores a pull request that is not release-please's", async () => {
    const result = await drive({ pulls: '' })

    assert.equal(result.code, 0)
    assert.deepEqual(statuses(result), [])
  })

  it('still fails when the forge itself refuses', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'treadle-parked-fail-'))
    const bin = path.join(dir, 'bin')
    await mkdir(bin)
    await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nexit 4\n')
    await chmod(path.join(bin, 'gh'), 0o755)
    const script = path.join(dir, 'step.sh')
    await writeFile(script, JOB?.steps[0]?.run ?? '')
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: REPO }
    await assert.rejects(run('bash', [script], { cwd: dir, env }))
  })

  it('writes the state with the run token and nothing wider', () => {
    assert.deepEqual(JOB?.permissions, {
      actions: 'read',
      'pull-requests': 'read',
      statuses: 'write',
    })
    assert.match(JOB?.text ?? '', /^ {6}GH_TOKEN: \$\{\{ github\.token \}\}$/m)
    assert.match(JOB?.text ?? '', new RegExp(`^ {6}CONTEXT: ${CONTEXT_NAME}$`, 'm'))
    assert.match(JOB?.text ?? '', /^ {6}SUMMARY_URL: .*github\.run_id \}\}$/m)
  })

  // Without this the job read the pull request one second into the run and reported the head
  // commit release-please was about to replace, so the status would land on a commit the pull
  // request no longer points at. Measured on run 34288199967.
  it('reads the pull request after release-please has updated it', () => {
    assert.match(JOB?.text ?? '', /^ {4}needs: release-pr$/m)
  })
})
