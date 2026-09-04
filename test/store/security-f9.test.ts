// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F9, predictable temp-file name without a stated exclusive create.
//
// The design wrote each file through `<file>.tmp.<pid>`, which is derivable from the target
// path and a process id, and stated `O_CREAT | O_EXCL` for the lock and not for the temp
// file. On a shared machine a co-tenant who can write the workspace directory pre-places
// that name as a symlink to a file the victim can write, and the write follows it.
//
// The first test is the attack as the design would have permitted it. It passes here only
// because the name is 96 bits of randomness and the open is exclusive.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { openExclusive, tempNameFor, writeFileAtomic } from '../../src/adapters/store/index.ts'
import { acquireLock } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

const NAMES = 1000

describe('the temp file cannot be aimed at anything', () => {
  it(`mints ${NAMES} distinct names, none of them derivable from the pid`, () => {
    const names = new Set<string>()
    for (let i = 0; i < NAMES; i += 1) names.add(tempNameFor('/w/items/2026-09.md'))
    assert.equal(names.size, NAMES, 'a repeated name is a guessable name')
    for (const name of names) {
      assert.notEqual(name, `/w/items/2026-09.md.tmp.${process.pid}`, 'the design\'s own name')
      assert.match(path.basename(name), /^\.2026-09\.md\.tmp\.[0-9a-f]{24}$/)
      assert.equal(path.dirname(name), '/w/items', 'the rename must stay inside one directory')
    }
  })

  it('does not follow a symlink pre-placed at the name the design would have used', async () => {
    const workspace = await aWorkspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'treadle-victim-'))
    const victim = path.join(outside, 'victim.txt')
    try {
      await writeFile(victim, 'the co-tenant cannot have this')
      const shard = path.join(workspace.root, 'items/2026-09.md')
      await symlink(victim, `${shard}.tmp.${process.pid}`)

      const applied = await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      assert.ok(applied.ok, applied.ok ? '' : applied.error.message)

      assert.equal(await readFile(victim, 'utf8'), 'the co-tenant cannot have this')
      assert.match(await readFile(shard, 'utf8'), /^# item-one: A first task$/m)
    } finally {
      await workspace.dispose()
    }
  })

  it('fails with EEXIST on an occupied path, including a dangling symlink', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'treadle-atomic-'))
    const taken = path.join(root, 'taken')
    await writeFile(taken, 'squatted')
    await assert.rejects(
      () => openExclusive(taken, 0o600),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    )
    assert.equal(await readFile(taken, 'utf8'), 'squatted')

    // The whole of F9: a co-tenant's symlink is an existing path to O_EXCL, so the open
    // fails rather than following the link to whatever it points at.
    const aimed = path.join(root, 'aimed')
    await symlink(path.join(root, 'nowhere'), aimed)
    await assert.rejects(
      () => openExclusive(aimed, 0o600),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    )
  })

  it('replaces a symlink at the target by rename rather than writing through it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'treadle-atomic-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'treadle-victim-'))
    const victim = path.join(outside, 'victim.txt')
    await writeFile(victim, 'untouched')
    const target = path.join(root, 'file.md')
    await symlink(victim, target)

    await writeFileAtomic(target, 'the real content')
    assert.equal(await readFile(victim, 'utf8'), 'untouched')
    assert.equal(await readFile(target, 'utf8'), 'the real content')
  })
})

describe('the permissions on every file the store owns', () => {
  it('writes records world-readable and the lock owner-only', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      for (const file of ['workspace.md', 'items/2026-09.md', '.gitignore', '.gitattributes']) {
        assert.equal((await stat(path.join(workspace.root, file))).mode & 0o777, 0o644, file)
      }
      const lock = await acquireLock(path.join(workspace.root, '.lock'))
      assert.ok(lock.ok)
      assert.equal((await stat(path.join(workspace.root, '.lock'))).mode & 0o777, 0o600)
      await lock.value.release()
    } finally {
      await workspace.dispose()
    }
  })

  it('keeps a mode the workspace tightened on an existing file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'treadle-atomic-'))
    const target = path.join(root, 'file.md')
    await writeFile(target, 'first', { mode: 0o600 })
    await writeFileAtomic(target, 'second')
    assert.equal((await stat(target)).mode & 0o777, 0o600)
  })
})
