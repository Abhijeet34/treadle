// SPDX-License-Identifier: Apache-2.0
// Releases the release pull request's parked runs, so nothing about a release waits on a
// person to click.
//
// release-please opens that pull request as `github-actions[bot]`, which holds no write
// access and has never had a pull request merged here, so this repository's
// `first_time_contributors` approval policy parks every run on it. A parked run attaches no
// check to the pull request at all: `gh pr checks 69` reported "no CI checks configured"
// while forty-six runs sat at `action_required`, and `.github/rulesets/main.json` requires
// the `checks` context, so the one pull request that carries a release was the one pull
// request nothing could ever check. Four release pull requests waited four days that way.
//
// ADR-0037 is the decision to approve them here instead of reporting them, and what that
// trades away. The `release-pr-checks` job runs this with the run's own token and
// `actions: write`, so no credential is stored to make a release unattended.
//
// TypeScript over a `run:` body calling `gh` and `jq`: the parked-checks job it replaces was
// 60 lines of shell whose only test drove it through a stubbed binary on PATH, and this is
// driven directly with a request function instead.

import process from 'node:process'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const BOT = 'github-actions[bot]'
const RELEASE_BRANCH_PREFIX = 'release-please--'

export type PullRequest = {
  readonly number: number
  readonly user?: { readonly login?: string }
  readonly head?: {
    readonly ref?: string
    readonly sha?: string
    readonly repo?: { readonly full_name?: string }
  }
  readonly base?: {
    readonly ref?: string
    readonly repo?: { readonly default_branch?: string }
  }
}

export type RunsPage = {
  readonly total_count?: number
  readonly workflow_runs?: readonly { readonly id: number; readonly conclusion?: string }[]
}

/**
 * The one pull request this may ever act on, and every clause is a narrowing: the author is
 * the bot release-please runs as, the head branch is one release-please owns and lives in
 * this repository rather than a fork, and the base is the default branch. A pull request a
 * person opened matches none of them.
 */
export function releasePullRequest(
  pulls: readonly PullRequest[],
  repo: string,
): PullRequest | undefined {
  return pulls.find(
    (pull) =>
      pull.user?.login === BOT &&
      pull.head?.ref?.startsWith(RELEASE_BRANCH_PREFIX) === true &&
      pull.head?.repo?.full_name === repo &&
      pull.base?.ref !== undefined &&
      pull.base.ref === pull.base?.repo?.default_branch,
  )
}

export const parkedRuns = (page: RunsPage): readonly { readonly id: number }[] =>
  (page.workflow_runs ?? []).filter((run) => run.conclusion === 'action_required')

export type Outcome = { readonly ok: boolean; readonly message: string }

/**
 * @param request the forge, as `(method, path) => body`; a non-2xx answer throws.
 * @param attempts how many reads the two waits below get, `intervalMs` apart.
 */
export async function approveReleaseChecks(input: {
  readonly repo: string
  readonly request: (method: string, path: string) => Promise<unknown>
  readonly sleep: (ms: number) => Promise<void>
  readonly attempts?: number
  readonly intervalMs?: number
  readonly log?: (line: string) => void
}): Promise<Outcome> {
  const { repo, request, sleep, attempts = 12, intervalMs = 10_000, log = console.log } = input

  const pulls = (await request('GET', `repos/${repo}/pulls?state=open&per_page=100`)) as
    | readonly PullRequest[]
    | null
  const pull = releasePullRequest(pulls ?? [], repo)
  if (pull === undefined) {
    return { ok: true, message: 'no release pull request is open, nothing to approve' }
  }

  const sha = pull.head?.sha ?? ''
  const runsOnHead = async (): Promise<RunsPage> =>
    (await request(
      'GET',
      `repos/${repo}/actions/runs?event=pull_request&head_sha=${sha}&per_page=100`,
    )) as RunsPage
  const window = `${(attempts * intervalMs) / 1000}s`

  // The head commit is seconds old when this runs and GitHub creates its runs asynchronously:
  // measured on run 34288199967, two seconds after the job that pushed the head finished. So
  // a head carrying no runs is read again rather than called clear. Waiting for any run rather
  // than for a parked one, because a run already in flight needs no approval and is the
  // answer, not a reason to keep waiting.
  let page = await runsOnHead()
  for (let attempt = 1; attempt < attempts && parkedRuns(page).length === 0; attempt += 1) {
    if ((page.total_count ?? 0) > 0) break
    await sleep(intervalMs)
    page = await runsOnHead()
  }

  const parked = parkedRuns(page)
  if (parked.length === 0) {
    // Unknown and clear are different claims, and an absent signal reading as a pass is the
    // defect class this repository has been removing: a pull request whose runs never appeared
    // reads exactly like one whose runs have not finished.
    if ((page.total_count ?? 0) === 0) {
      return {
        ok: false,
        message: `#${pull.number} at ${sha} has no pull_request run at all after ${window}, so nothing will ever check it`,
      }
    }
    return { ok: true, message: `#${pull.number} at ${sha}: nothing is awaiting approval` }
  }

  for (const run of parked) {
    log(`approving run ${run.id} on #${pull.number}`)
    try {
      await request('POST', `repos/${repo}/actions/runs/${run.id}/approve`)
    } catch (error) {
      return {
        ok: false,
        message:
          `could not approve run ${run.id} on #${pull.number} (${(error as Error).message}); ` +
          'this job needs actions: write, and the release stays unchecked until it has it',
      }
    }
  }

  // Approving is a request and a 201 is not the outcome. The outcome is the run leaving the
  // parked state, which is what the required `checks` context waits on.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (parkedRuns(await runsOnHead()).length === 0) {
      return {
        ok: true,
        message: `#${pull.number} at ${sha} now faces the same gates as any other pull request`,
      }
    }
    await sleep(intervalMs)
  }
  return {
    ok: false,
    message: `#${pull.number} at ${sha} is still awaiting approval ${window} after it was given`,
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      attempts: { type: 'string' },
      'interval-ms': { type: 'string' },
    },
  })
  const repo = process.env['GITHUB_REPOSITORY']
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN must both be set')
  const apiUrl = process.env['GITHUB_API_URL'] ?? 'https://api.github.com'

  const request = async (method: string, endpoint: string): Promise<unknown> => {
    const response = await fetch(`${apiUrl}/${endpoint}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${method} ${endpoint} answered ${response.status}: ${body}`)
    return body ? (JSON.parse(body) as unknown) : null
  }

  const result = await approveReleaseChecks({
    repo,
    request,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    ...(values.attempts === undefined ? {} : { attempts: Number(values.attempts) }),
    ...(values['interval-ms'] === undefined ? {} : { intervalMs: Number(values['interval-ms']) }),
  })
  if (result.ok) console.log(result.message)
  else console.error(`::error::${result.message}`)
  process.exitCode = result.ok ? 0 : 1
}
