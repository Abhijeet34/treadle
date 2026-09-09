// SPDX-License-Identifier: Apache-2.0
// One workspace of 24 items, built through the real use cases under the fixed clock and the
// sequential id generator, and one golden result object per command taken from it.
//
// The suite reads both: the render conformance test feeds every golden object to every
// renderer, the schema test validates every golden object against the shipped schema, and
// the budget test measures the agent rendering of each against the interface's A.3 figures.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { WorkItemType } from '../../src/domain/index.ts'
import type { ResultObject } from '../../src/application/result.ts'
import type { Store } from '../../src/application/ports/store.ts'
import { setFields } from '../../src/application/services/editing.ts'
import { backlog, fileItem, showItem } from '../../src/application/services/items.ts'
import { history } from '../../src/application/services/history.ts'
import { readConfig, setConfig } from '../../src/application/services/config.ts'
import { explain, next, status } from '../../src/application/services/insight.ts'
import { relate } from '../../src/application/services/relation.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import type { Actor } from '../../src/application/services/mutation.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { initWorkspace } from '../../src/adapters/workspace.ts'
import { commandHelp, topLevelHelp } from '../../src/cli/help.ts'

export const ACTOR: Actor = { id: 'dana', kind: 'human' }
export const NOW = '2026-09-04T09:30:00Z'

type Seed = {
  readonly id: string
  readonly type: WorkItemType
  readonly title: string
  readonly filed: string
  readonly to?: readonly string[]
  readonly fields?: Readonly<Record<string, string>>
}

const CRITERIA = 'acceptance_criteria'

/** Ids are short on purpose: every byte figure in the budget table shifts with them. */
export const SEEDS: readonly Seed[] = [
  { id: 'auth-refresh', type: 'story', title: 'Refresh the access token on a 401', filed: '2026-08-20T09:00:00Z', to: ['ready', 'in_progress'], fields: { priority: '2', assignee: 'dana', [CRITERIA]: 'a 401 refreshes once|the retry carries the new token', description: 'The client currently drops the session when the access token expires, and the user is signed out in the middle of a task they had already started.' } },
  { id: 'sso-saml', type: 'story', title: 'SAML login for enterprise tenants', filed: '2026-08-21T09:00:00Z', to: ['ready', 'in_progress'], fields: { priority: '1', assignee: 'kim', [CRITERIA]: 'metadata upload works|a signed assertion logs in' } },
  { id: 'rate-limit', type: 'story', title: 'Return 429 with a retry-after header', filed: '2026-08-22T09:00:00Z', to: ['ready', 'in_progress', 'in_review'], fields: { priority: '2', assignee: 'ravi', [CRITERIA]: 'a burst gets 429|the header names the wait' } },
  { id: 'csv-export', type: 'story', title: 'Export a filtered list to CSV', filed: '2026-08-23T09:00:00Z', to: ['ready'], fields: { priority: '3', [CRITERIA]: 'the header row is present' } },
  { id: 'flaky-e2e', type: 'bug', title: 'Checkout suite fails, one run in five', filed: '2026-08-24T09:00:00Z', to: ['ready'], fields: { priority: '2', severity: 'S2', found_in: 'test', repro_steps: 'run the checkout suite five times', expected: 'five passes', actual: 'one failure' } },
  { id: 'dep-bump', type: 'task', title: 'Move the toolchain to the current release', filed: '2026-08-25T09:00:00Z', to: ['ready'], fields: { priority: '4' } },
  { id: 'search-rank', type: 'spike', title: 'Which ranker do we adopt', filed: '2026-08-26T09:00:00Z', fields: { priority: '3', question: 'which ranker' } },
  { id: 'audit-log', type: 'story', title: 'Record who changed what and when', filed: '2026-08-27T09:00:00Z', fields: { priority: '2' } },
  { id: 'onboard-copy', type: 'task', title: 'Rewrite the first-run text', filed: '2026-08-28T09:00:00Z', to: ['ready', 'on_hold'], fields: { priority: '5', assignee: 'kim' } },
  { id: 'login-cta', type: 'task', title: 'Move the sign-in call to action above the fold', filed: '2026-08-29T09:00:00Z', to: ['ready', 'in_progress', 'done'], fields: { priority: '3', assignee: 'dana' } },
  { id: 'log-redact', type: 'task', title: 'Redact tokens from request logs', filed: '2026-08-30T09:00:00Z', to: ['ready', 'in_progress'], fields: { priority: '1', assignee: 'ravi' } },
  { id: 'avatar-crop', type: 'task', title: 'Crop an uploaded avatar to a square', filed: '2026-08-31T09:00:00Z', to: ['ready'], fields: { priority: '4' } },
  { id: 'webhook-retry', type: 'task', title: 'Retry a failed webhook three times', filed: '2026-09-01T09:00:00Z', to: ['ready'], fields: { priority: '3' } },
  { id: 'gdpr-export', type: 'story', title: 'Export everything we hold on one account', filed: '2026-09-01T10:00:00Z', to: ['ready'], fields: { priority: '2', assignee: 'dana', [CRITERIA]: 'the archive is complete' } },
  { id: 'legacy-oauth', type: 'task', title: 'Remove OAuth 1 support', filed: '2026-09-01T11:00:00Z', to: ['cancelled'], fields: { priority: '5' } },
  { id: 'stale-cache', type: 'bug', title: 'Profile cache serves a deleted avatar', filed: '2026-09-02T09:00:00Z', fields: { priority: '2', severity: 'S3', found_in: 'production', repro_steps: 'delete an avatar and reload' } },
  { id: 'metrics-p95', type: 'task', title: 'Publish p95 latency per route', filed: '2026-09-02T10:00:00Z', fields: { priority: '4' } },
  { id: 'docs-quickstart', type: 'task', title: 'Write the quickstart page', filed: '2026-09-02T11:00:00Z', fields: { priority: '5' } },
  { id: 'sess-timeout', type: 'bug', title: 'Session survives a password change', filed: '2026-09-03T09:00:00Z', fields: { priority: '1', severity: 'S1', found_in: 'production', repro_steps: 'change the password in a second browser' } },
  { id: 'i18n-dates', type: 'task', title: 'Format dates in the viewer locale', filed: '2026-09-03T10:00:00Z', fields: { priority: '4' } },
  { id: 'bulk-import', type: 'story', title: 'Import a list of accounts from CSV', filed: '2026-09-03T11:00:00Z', fields: { priority: '3' } },
  { id: 'perm-audit', type: 'spike', title: 'Do we need row level permissions', filed: '2026-09-03T12:00:00Z', fields: { priority: '3', question: 'row level permissions' } },
  { id: 'queue-drain', type: 'task', title: 'Drain the dead letter queue on deploy', filed: '2026-09-04T08:00:00Z', fields: { priority: '2' } },
  { id: 'theme-dark', type: 'story', title: 'Ship a dark theme', filed: '2026-09-04T08:30:00Z', fields: { priority: '5' } },
]

export type Demo = {
  readonly root: string
  readonly store: Store
  readonly dispose: () => Promise<void>
}

export async function aDemoWorkspace(): Promise<Demo> {
  const parent = await mkdtemp(path.join(tmpdir(), 'treadle-cli-'))
  const root = path.join(parent, 'platform', '.work')
  const ids = sequentialIds()
  await initWorkspace(fixedClock('2026-08-01T09:00:00Z'), ids, { at: root, name: 'acme-platform', actor: ACTOR })

  const opened = await openWorkspace(root)
  if (!opened.ok) throw new Error(opened.error.message)
  const store = opened.value

  for (const seed of SEEDS) {
    const filed = await fileItem(targetFor(store, 'apply'), fixedClock(seed.filed), ids, {
      type: seed.type, title: seed.title, id: seed.id, fields: seed.fields ?? {}, actor: ACTOR,
    })
    if (!filed.ok) throw new Error(`${seed.id}: ${String(filed.data['cause'])}`)
    for (const target of seed.to ?? []) {
      const moved = await transition(targetFor(store, 'apply'), fixedClock(seed.filed), ids, {
        id: seed.id, target: target as 'ready', reason: 'fixture', actor: ACTOR,
        // T6: cancel names a resolution from the closed set, so the fixture names one too.
        ...(target === 'cancelled' ? { resolution: 'wont_do' as const } : {}),
      })
      if (!moved.ok) throw new Error(`${seed.id} -> ${target}: ${String(moved.data['cause'])}`)
    }
  }

  return {
    root,
    store,
    dispose: async () => {
      await store.close()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

/**
 * The path every golden object below reports as its workspace, in place of the temporary
 * directory the demo really lives in.
 *
 * Two suites measure these objects rather than read them, and both were measuring the runner's
 * `mkdtemp` root: the A.3 byte budget counts the `store` line, and the human-layout snapshot
 * lays that line out against the terminal width. A macOS `/var/folders/bl/vzjcvbz.../T` root
 * is 44 characters where a Linux `/tmp` one is 4, which on macos-15 in run 34110894767 put
 * an artefact over its A.3 byte budget and wrapped the snapshot's `store` scalar onto a
 * second line. Neither is a fact about this tool.
 */
const GOLDEN_ROOT = '/w/platform/.work'

/** Every string carrying the demo's real root, rewritten to `GOLDEN_ROOT`, at any depth. */
function atGoldenRoot<T>(value: T, root: string): T {
  if (typeof value === 'string') return value.replaceAll(root, GOLDEN_ROOT) as T
  if (Array.isArray(value)) return value.map((entry: unknown) => atGoldenRoot(entry, root)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, atGoldenRoot(entry, root)]),
    ) as T
  }
  return value
}

/** One result object per command, which is what the conformance and schema suites read. */
export async function goldenResults(): Promise<ReadonlyMap<string, ResultObject>> {
  const demo = await aDemoWorkspace()
  try {
    const clock = fixedClock(NOW)
    const ids = sequentialIds(900)
    const golden = new Map<string, ResultObject>()
    golden.set('status', await status(demo.store, clock))
    golden.set('backlog', await backlog(demo.store, clock, {
      filters: [], columns: ['id', 'type', 'state', 'title'], limit: 9,
    }))
    golden.set('backlog-empty', await backlog(demo.store, clock, {
      filters: [{ field: 'state', value: 'ready' }, { field: 'assignee', value: 'kim' }],
      columns: ['id', 'type', 'state', 'title'], limit: 9,
    }))
    golden.set('backlog-absence', await backlog(demo.store, clock, {
      filters: [{ field: 'state', value: 'ready' }],
      columns: ['id', 'type', 'state', 'title'], limit: 9, explainAbsence: 'sso-saml',
    }))
    golden.set('show', await showItem(demo.store, clock, 'auth-refresh'))
    // The `ac` projection, which is the one read surface that prints a story's criteria: the
    // record itself carries the tally alone, because `show` has no headroom against A.3.
    golden.set('show-criteria', await showItem(demo.store, clock, 'auth-refresh', 'ac'))
    golden.set('next', await next(demo.store, clock, { limit: 3 }))
    golden.set('explain', await explain(demo.store, clock, 'sso-saml'))
    golden.set('history', await history(demo.store, { scope: { kind: 'item', id: 'sso-saml' }, limit: 9 }))
    golden.set('help', topLevelHelp('acme-platform'))
    golden.set('help-command', commandHelp('transition', 'acme-platform') as ResultObject)
    golden.set('not-found', await showItem(demo.store, clock, 'sso-saml-typo'))
    golden.set('transition-dry-run', await transition(targetFor(demo.store, 'dry-run'), clock, ids, {
      id: 'csv-export', target: 'in_progress', actor: ACTOR,
    }))
    golden.set('transition', await transition(targetFor(demo.store, 'apply'), clock, ids, {
      id: 'csv-export', target: 'in_progress', actor: ACTOR,
    }))
    golden.set('transition-already', await transition(targetFor(demo.store, 'apply'), clock, ids, {
      id: 'csv-export', target: 'in_progress', actor: ACTOR,
    }))
    golden.set('guard-refused', await transition(targetFor(demo.store, 'apply'), clock, ids, {
      id: 'sso-saml', target: 'done', actor: ACTOR,
    }))
    golden.set('file', await fileItem(targetFor(demo.store, 'apply'), clock, ids, {
      type: 'task', title: 'Add a health endpoint', id: 'health-endpoint',
      fields: { priority: '4' }, actor: ACTOR,
    }))
    // A second status, taken last so it moves none of the figures above. The workspace has
    // no missed date until this item exists, so without it the `overdue` scalar and the
    // `health` block reach no renderer and no schema check.
    await fileItem(targetFor(demo.store, 'apply'), fixedClock('2026-08-20T09:00:00Z'), ids, {
      type: 'task', title: 'Rotate the signing key', id: 'key-rotate',
      fields: { priority: '2', due: '2026-08-28T09:00:00Z' }, actor: ACTOR,
    })
    golden.set('status-overdue', await status(demo.store, clock))
    // The same store read before that date passes, which is the one pair whose difference
    // is the date alone rather than the date and an extra item.
    golden.set('status-not-yet-overdue', await status(demo.store, fixedClock('2026-08-27T09:00:00Z')))
    // Taken last, on the item `file` above created, so it moves none of the figures over it.
    golden.set('set', await setFields(targetFor(demo.store, 'apply'), clock, ids, {
      id: 'health-endpoint', assignments: ['assignee=kim', 'reviewer=dana'], actor: ACTOR,
    }))
    // Taken last, between two draft items, so neither `next` nor any figure above moves: the
    // `explain` over the blocked end is the line that was `blocked no` on every item before.
    golden.set('relation', await relate(targetFor(demo.store, 'apply'), clock, ids, {
      verb: 'add', id: 'queue-drain', kind: 'blocks', other: 'theme-dark', actor: ACTOR,
    }))
    golden.set('explain-blocked', await explain(demo.store, clock, 'theme-dark'))
    golden.set('show-relations', await showItem(demo.store, clock, 'queue-drain'))
    // The transaction-scoped read, over the transaction the `relation` write above returned.
    // Every command in this build writes one event per transaction, so this block carries one
    // row; the multi-row case is the store's to produce and lives in
    // test/services/history-transaction.test.ts, which builds one through `apply` directly.
    golden.set('history-txn', await history(demo.store, {
      scope: { kind: 'txn', txn: (golden.get('relation') as ResultObject).txn as string }, limit: 9,
    }))
    // Last of all, because a configured key changes what every read above evaluates: the
    // write moves `wip_limits` off its default, and the read that follows it is the one
    // artefact carrying a `source` column with both of its words in it.
    golden.set('config-set', await setConfig(targetFor(demo.store, 'apply'), clock, ids, {
      key: 'wip_limits', value: 'in_progress=5, in_review=2', actor: ACTOR,
    }))
    golden.set('config', await readConfig(demo.store))
    // After every other object, because it breaks the store: a `.txn/` file this store did
    // not write refuses every write past it. Without it the `writes` scalar and the `fix`
    // list `status` prints over an unwritable store reach no renderer and no schema check,
    // which is the reason `status-overdue` above exists for `overdue` and `health`.
    await mkdir(path.join(demo.root, '.txn'), { recursive: true })
    await writeFile(path.join(demo.root, '.txn', 'stray.json'), '{"garbage":true}')
    golden.set('status-unwritable', await status(demo.store, clock))
    return new Map([...golden].map(([name, result]) => [name, atGoldenRoot(result, demo.root)]))
  } finally {
    await demo.dispose()
  }
}
