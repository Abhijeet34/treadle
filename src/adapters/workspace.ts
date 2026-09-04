// SPDX-License-Identifier: Apache-2.0
// Resolving the store, and creating one. Both are filesystem work, which is why they are
// here and not beside the use cases.
//
// DR2's rule is "walk up to the nearest workspace.md". A workspace that a team commits wants
// a directory of its own rather than five entries in the repository root, so the walk looks
// for `.work/workspace.md` at each ancestor as well as `workspace.md` at the ancestor
// itself, and the nested one wins at the same level because it is the one `init` writes.

import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { initResult } from '../application/services/workspace.ts'
import { errorResult, type ResultObject } from '../application/result.ts'
import { makeEvent, type Actor } from '../application/services/mutation.ts'
import type { Clock } from '../application/ports/clock.ts'
import type { IdGenerator } from '../application/ports/ids.ts'
import { SCHEMA, ShardedStore, WORKSPACE_FILE, createWorkspace, openWorkspace } from './store/index.ts'

/** The directory `init` writes, and the one the walk looks for at every ancestor. */
export const WORKSPACE_DIR = '.work'

async function isWorkspace(at: string): Promise<boolean> {
  try {
    await stat(path.join(at, WORKSPACE_FILE))
    return true
  } catch {
    return false
  }
}

export async function resolveStore(from: string): Promise<string | undefined> {
  let at = path.resolve(from)
  for (;;) {
    const nested = path.join(at, WORKSPACE_DIR)
    if (await isWorkspace(nested)) return nested
    if (await isWorkspace(at)) return at
    const up = path.dirname(at)
    if (up === at) return undefined
    at = up
  }
}

const SLUG_TRIM = /^[^a-z0-9]+|[^a-z0-9]+$/g

export function workspaceIdFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(SLUG_TRIM, '').slice(0, 64)
  return slug.length >= 3 ? slug : `workspace-${slug}`.replace(SLUG_TRIM, '')
}

export type InitRequest = {
  readonly at: string
  readonly name?: string
  readonly actor: Actor
  readonly yes?: boolean
}

/**
 * Creates the workspace and reports what it created. Nothing is written outside `at`, which
 * is the claim `not_created` prints and the one a caller can check.
 */
export async function initWorkspace(
  clock: Clock, ids: IdGenerator, request: InitRequest,
): Promise<ResultObject> {
  const root = path.resolve(request.at)
  const name = request.name ?? path.basename(path.dirname(root))
  const id = workspaceIdFor(name)

  if (await isWorkspace(root)) {
    const opened = await openWorkspace(root)
    const known = opened.ok ? (await opened.value.identity()) : undefined
    if (opened.ok) await opened.value.close()
    return initResult({
      workspace: known !== undefined && known.ok ? known.value.id : id,
      path: root, actor: request.actor.id, schema: SCHEMA, txn: null, already: true,
    })
  }

  if (await nonEmpty(root) && request.yes !== true) {
    return errorResult({
      code: 'VALIDATION', command: 'init', workspace: '-', effect: 'mutate', rule: 'C1',
      cause: `${root} already holds files and is not a workspace; creating one here may collide with them`,
      fix: ['treadle init --yes'],
    })
  }

  const created = await createWorkspace(root, { id, name, at: clock.now() })
  if (!created.ok) {
    return errorResult({
      code: 'STORE_UNAVAILABLE', command: 'init', workspace: '-', effect: 'mutate',
      rule: created.error.rule, cause: created.error.message,
    })
  }

  const store = new ShardedStore(root)
  const txn = ids.txn()
  const applied = await store.apply({
    txn,
    writes: [],
    events: [makeEvent({
      id: ids.event(), at: clock.now(), actor: request.actor, entity: id, entityKind: 'workspace',
      op: 'workspace.init', after: { schema: SCHEMA }, txn, command: 'init',
    })],
  })
  await store.close()
  if (!applied.ok) {
    return errorResult({
      code: 'STORE_UNAVAILABLE', command: 'init', workspace: id, effect: 'mutate',
      rule: applied.error.rule, cause: applied.error.message,
    })
  }
  return initResult({ workspace: id, path: root, actor: request.actor.id, schema: SCHEMA, txn })
}

async function nonEmpty(at: string): Promise<boolean> {
  try {
    return (await readdir(at)).length > 0
  } catch {
    return false
  }
}

export async function ensureDirectory(at: string): Promise<void> {
  await mkdir(at, { recursive: true })
}
