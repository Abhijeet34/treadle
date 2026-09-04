// SPDX-License-Identifier: Apache-2.0
// `init` decides where the workspace goes and what its id is, and every one of its refusal
// paths is a path a user meets on their first minute with the tool. The happy path is
// covered by every fixture in the suite; these are the four that are not.
//
// The nested-workspace rule is here too, because "walk up to the nearest workspace.md" and
// ".work at this level wins" are two rules and only one of them is obvious from the code.

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { initWorkspace, resolveStore, workspaceIdFor, WORKSPACE_DIR } from '../../src/adapters/workspace.ts'
import type { Actor } from '../../src/application/services/mutation.ts'

const ACTOR: Actor = { id: 'dana', kind: 'human' }
const CLOCK = fixedClock('2026-09-04T09:30:00Z')

async function aDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'treadle-init-'))
}

describe('the workspace id is derived from the name, and is always usable as one', () => {
  it('slugs punctuation, case and runs of separators', () => {
    assert.equal(workspaceIdFor('Acme Platform'), 'acme-platform')
    assert.equal(workspaceIdFor('  ACME__platform!!  '), 'acme-platform')
    assert.equal(workspaceIdFor('acme/platform'), 'acme-platform')
  })

  it('pads a name too short to be a slug rather than emitting one the grammar refuses', () => {
    assert.equal(workspaceIdFor('a'), 'workspace-a')
    assert.equal(workspaceIdFor('ab'), 'workspace-ab')
    assert.equal(workspaceIdFor('!!'), 'workspace')
    assert.equal(workspaceIdFor(''), 'workspace')
  })

  it('cuts a name longer than the id grammar allows', () => {
    const id = workspaceIdFor('x'.repeat(300))
    assert.equal(id.length, 64)
    assert.match(id, /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
  })
})

describe('init on a directory that is already a workspace', () => {
  it('reports the workspace it found rather than creating a second one', async () => {
    const parent = await aDirectory()
    try {
      const at = path.join(parent, WORKSPACE_DIR)
      const first = await initWorkspace(CLOCK, sequentialIds(), { at, name: 'acme-platform', actor: ACTOR })
      assert.equal(first.ok, true, String(first.data['cause']))
      assert.equal(first.data['already'], undefined)

      const again = await initWorkspace(CLOCK, sequentialIds(), { at, name: 'something-else', actor: ACTOR })
      assert.equal(again.ok, true, String(again.data['cause']))
      assert.equal(again.data['already'], 'acme-platform')
      assert.equal(again.workspace, 'acme-platform', 'the second init renamed the workspace')
      assert.equal(again.txn, null, 'a no-op init claimed a transaction')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('init on a directory that already holds files', () => {
  it('refuses, names the path, and offers the flag that overrides it', async () => {
    const at = await aDirectory()
    try {
      await writeFile(path.join(at, 'README.md'), '# not a workspace\n')
      const refused = await initWorkspace(CLOCK, sequentialIds(), { at, name: 'acme', actor: ACTOR })
      assert.equal(refused.ok, false)
      assert.equal(refused.code, 'VALIDATION')
      assert.equal(refused.data['rule'], 'C1')
      assert.match(String(refused.data['cause']), new RegExp(at.replaceAll('/', '\\/')))
      assert.deepEqual(refused.data['fix'], ['treadle init --yes'])
    } finally {
      await rm(at, { recursive: true, force: true })
    }
  })

  it('creates it anyway when the caller said yes', async () => {
    const at = await aDirectory()
    try {
      await writeFile(path.join(at, 'README.md'), '# not a workspace\n')
      const created = await initWorkspace(CLOCK, sequentialIds(), { at, name: 'acme', actor: ACTOR, yes: true })
      assert.equal(created.ok, true, String(created.data['cause']))
      assert.equal(created.workspace, 'acme')
      assert.equal(await resolveStore(at), at)
    } finally {
      await rm(at, { recursive: true, force: true })
    }
  })
})

describe('init where the workspace cannot be created', () => {
  it('reports the store failure rather than a half-made workspace', async () => {
    const parent = await aDirectory()
    try {
      // A file where the workspace directory would go: the create fails at the filesystem
      // rather than at a check, which is the path a permission or a full disk takes too.
      const at = path.join(parent, 'occupied')
      await writeFile(at, 'not a directory\n')
      const refused = await initWorkspace(CLOCK, sequentialIds(), { at, name: 'acme', actor: ACTOR })
      assert.equal(refused.ok, false)
      assert.equal(refused.code, 'STORE_UNAVAILABLE')
      assert.ok(String(refused.data['cause']).length > 0, 'the refusal says nothing')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('reports the first event failing to land, and does not claim success', async () => {
    const parent = await aDirectory()
    const at = path.join(parent, WORKSPACE_DIR)
    try {
      // The layout is made and then the first event cannot be written. A read-only events
      // directory placed before the run is the narrowest way to reach that half, because
      // `createWorkspace` writes nothing into it and the workspace.init event does.
      await mkdir(path.join(at, 'events'), { recursive: true })
      await chmod(path.join(at, 'events'), 0o500)

      const blocked = await initWorkspace(CLOCK, sequentialIds(), { at, name: 'acme', actor: ACTOR, yes: true })
      assert.equal(blocked.ok, false, 'init claimed success with no event written')
      assert.equal(blocked.code, 'STORE_UNAVAILABLE')
      assert.equal(blocked.data['rule'], 'S13')
      assert.match(String(blocked.data['cause']), /EACCES/)
      assert.equal(blocked.workspace, 'acme', 'the refusal does not name the workspace it was making')
    } finally {
      await chmod(path.join(at, 'events'), 0o700).catch(() => undefined)
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('the walk prefers the nested workspace directory at the same level', () => {
  it('finds .work under an ancestor before that ancestor itself', async () => {
    const parent = await aDirectory()
    try {
      const at = path.join(parent, WORKSPACE_DIR)
      await initWorkspace(CLOCK, sequentialIds(), { at, actor: ACTOR })
      await writeFile(path.join(parent, 'workspace.md'), 'schema: 1\n\n# other: Other\n\n')

      assert.equal(await resolveStore(parent), at, 'the ancestor\'s own file won over .work')
      const deep = path.join(parent, 'src', 'deep')
      await mkdir(deep, { recursive: true })
      assert.equal(await resolveStore(deep), at)
      assert.equal(await resolveStore(path.parse(parent).root), undefined)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('names the workspace after the directory above it when no name is given', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'treadle-named-'))
    try {
      const at = path.join(parent, WORKSPACE_DIR)
      const created = await initWorkspace(CLOCK, sequentialIds(), { at, actor: ACTOR })
      assert.equal(created.ok, true, String(created.data['cause']))
      assert.equal(created.workspace, workspaceIdFor(path.basename(parent)))
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
