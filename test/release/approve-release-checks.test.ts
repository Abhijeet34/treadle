// SPDX-License-Identifier: Apache-2.0
// The job that makes a release unattended, and the four clauses that keep it from reaching any
// other pull request. It is driven through its own request function rather than through a `gh`
// stub on PATH, so an assertion names the request the script actually sent.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  approveReleaseChecks,
  parkedRuns,
  releasePullRequest,
  type PullRequest,
  type RunsPage,
} from '../../scripts/approve-release-checks.ts'
import { workflowOf } from '../helpers/workflow.ts'
import { fileURLToPath } from 'node:url'

const REPO = 'Abhijeet34/treadling'
const HEAD = 'aaaa1111'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const RELEASE_PULL: PullRequest = {
  number: 69,
  user: { login: 'github-actions[bot]' },
  head: {
    ref: 'release-please--branches--main--components--treadling',
    sha: HEAD,
    repo: { full_name: REPO },
  },
  base: { ref: 'main', repo: { default_branch: 'main' } },
}

const parked = (...ids: readonly number[]): RunsPage => ({
  total_count: ids.length,
  workflow_runs: ids.map((id) => ({ id, conclusion: 'action_required' })),
})
const running = (...ids: readonly number[]): RunsPage => ({
  total_count: ids.length,
  workflow_runs: ids.map((id) => ({ id, conclusion: null as unknown as undefined })),
})
const NO_RUNS: RunsPage = { total_count: 0, workflow_runs: [] }

type Drive = {
  readonly ok: boolean
  readonly message: string
  readonly calls: readonly string[]
  readonly slept: number
}

/**
 * @param pages what the runs endpoint answers, one entry per read, the last one standing once
 * the timeline runs out. `refuse` is the run id whose approval the forge rejects.
 */
async function drive(input: {
  pulls?: readonly PullRequest[]
  pages: readonly RunsPage[]
  refuse?: number
}): Promise<Drive> {
  const calls: string[] = []
  let slept = 0
  let read = 0
  const pages = input.pages
  const request = async (method: string, endpoint: string): Promise<unknown> => {
    calls.push(`${method} ${endpoint}`)
    if (endpoint.includes('/pulls?')) return input.pulls ?? [RELEASE_PULL]
    if (endpoint.endsWith('/approve')) {
      if (input.refuse !== undefined && endpoint.includes(`/${input.refuse}/`)) {
        throw new Error('Resource not accessible by integration')
      }
      return null
    }
    const page = pages[Math.min(read, pages.length - 1)]
    read += 1
    return page
  }
  const result = await approveReleaseChecks({
    repo: REPO,
    request,
    sleep: async (ms) => {
      slept += ms
    },
    attempts: 3,
    intervalMs: 10_000,
    log: () => {},
  })
  return { ...result, calls, slept }
}

const approvals = (result: Drive): readonly string[] =>
  result.calls.filter((call) => call.endsWith('/approve'))

describe('the release pull request has its parked runs released', () => {
  it('approves every parked run on the head the pull request points at', async () => {
    const result = await drive({ pages: [parked(111, 222), running(111, 222)] })

    assert.ok(result.ok, result.message)
    assert.deepEqual(approvals(result), [
      `POST repos/${REPO}/actions/runs/111/approve`,
      `POST repos/${REPO}/actions/runs/222/approve`,
    ])
    assert.match(result.message, /#69 at aaaa1111 now faces the same gates/)
  })

  it('reads the runs on the head commit rather than on the branch', async () => {
    // A run parked on a commit the pull request has moved past stays `action_required` for the
    // life of the repository, so a branch-wide query reports parked once and never comes back.
    const result = await drive({ pages: [parked(111), running(111)] })

    const reads = result.calls.filter((call) => call.includes('/actions/runs?'))
    assert.ok(reads.length > 0, 'nothing read the runs')
    for (const read of reads) assert.match(read, new RegExp(`head_sha=${HEAD}\\b`))
  })

  it('approves nothing when the runs on the head are already in flight', async () => {
    const result = await drive({ pages: [running(111)] })

    assert.ok(result.ok, result.message)
    assert.deepEqual(approvals(result), [])
    assert.match(result.message, /nothing is awaiting approval/)
  })

  // Measured on run 34288199967: release-pr completed at 22:56:53Z and the runs on the head it
  // had just pushed were created at 22:56:55Z. A read landing in that gap sees nothing at all,
  // and reporting nothing to approve there leaves the release parked forever.
  it('waits for a head whose runs have not been created yet', async () => {
    const result = await drive({ pages: [NO_RUNS, NO_RUNS, parked(111), running(111)] })

    assert.ok(result.ok, result.message)
    assert.deepEqual(approvals(result), [`POST repos/${REPO}/actions/runs/111/approve`])
    assert.equal(result.slept, 20_000)
  })

  // Unknown and clear are different claims. A pull request whose runs never appeared reads
  // exactly like one whose runs have not finished, and that silence is what this replaces.
  it('fails rather than passing a head that never gets a run at all', async () => {
    const result = await drive({ pages: [NO_RUNS] })

    assert.equal(result.ok, false)
    assert.match(result.message, /no pull_request run at all after 30s/)
  })

  // Approving is a request and a 201 is not the outcome; the outcome is the run leaving the
  // parked state, which is what the required `checks` context waits on.
  it('fails when the runs are still parked after the approval was given', async () => {
    const result = await drive({ pages: [parked(111)] })

    assert.equal(result.ok, false)
    assert.match(result.message, /still awaiting approval 30s after it was given/)
  })

  it('names the permission it needs when the forge refuses the approval', async () => {
    const result = await drive({ pages: [parked(111, 222)], refuse: 222 })

    assert.equal(result.ok, false)
    assert.match(result.message, /could not approve run 222 on #69/)
    assert.match(result.message, /actions: write/)
  })

  it('says so and stops when no release pull request is open', async () => {
    const result = await drive({ pulls: [], pages: [parked(111)] })

    assert.ok(result.ok, result.message)
    assert.deepEqual(approvals(result), [])
    assert.deepEqual(
      result.calls.filter((call) => call.includes('/actions/runs?')),
      [],
    )
  })
})

describe('the one pull request the approval may ever reach', () => {
  // One impostor per clause. Each differs from the release pull request in exactly one field,
  // so a clause that stopped narrowing fails here rather than in a release.
  const impostors: readonly (readonly [string, PullRequest])[] = [
    ['a person opened it', { ...RELEASE_PULL, user: { login: 'someone' } }],
    [
      'the head branch is not release-please\'s',
      { ...RELEASE_PULL, head: { ...RELEASE_PULL.head, ref: 'feat/release-please-lookalike' } },
    ],
    [
      'the head branch is in a fork',
      { ...RELEASE_PULL, head: { ...RELEASE_PULL.head, repo: { full_name: 'someone/treadling' } } },
    ],
    [
      'it is not based on the default branch',
      { ...RELEASE_PULL, base: { ref: 'next', repo: { default_branch: 'main' } } },
    ],
  ]

  for (const [why, impostor] of impostors) {
    it(`ignores a pull request where ${why}`, () => {
      assert.equal(releasePullRequest([impostor], REPO), undefined)
    })
  }

  it('finds the release pull request among them', () => {
    const pulls = [...impostors.map(([, pull]) => pull), RELEASE_PULL]
    assert.equal(releasePullRequest(pulls, REPO)?.number, 69)
  })

  it('reads only the runs a person has to release', () => {
    assert.deepEqual(
      parkedRuns({
        workflow_runs: [
          { id: 1, conclusion: 'action_required' },
          { id: 2, conclusion: 'success' },
          { id: 3, conclusion: 'failure' },
        ],
      }).map((run) => run.id),
      [1],
    )
  })
})

describe('the job that runs it', () => {
  const job = workflowOf(ROOT, 'release.yml')['release-pr-checks']

  it('holds actions: write and nothing else that could change the tree', () => {
    assert.deepEqual(job?.permissions, {
      contents: 'read',
      'pull-requests': 'read',
      actions: 'write',
    })
  })

  it('runs after release-please has updated the pull request', () => {
    assert.deepEqual(job?.needs, ['release-pr'])
    // The guard `needs` exists to protect: a job-level `if:` letting this run after
    // `release-pr` fails would defeat the ordering even though `needs` still names it.
    assert.doesNotMatch(job?.ifExpr ?? '', /\b(always|failure|cancelled)\s*\(/)
  })

  it('runs the script rather than a copy of it in a run body', () => {
    const steps = job?.steps ?? []
    assert.ok(
      steps.some((step) => step.run?.includes('scripts/approve-release-checks.ts')),
      `release-pr-checks no longer runs the script: ${JSON.stringify(steps)}`,
    )
  })
})
