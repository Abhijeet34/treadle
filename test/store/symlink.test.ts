// SPDX-License-Identifier: Apache-2.0
// The containment claim `init` prints, "nothing outside this directory", held against the
// one thing POSIX would use to break it. A workspace is a committed directory and git
// materialises a symbolic link on checkout, so a clone can carry `items -> elsewhere`;
// before this rule every `file` wrote its shard through the link, measured, with nothing
// refused. ADR-0002 carries the decision: no path at or below the root is followed.

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { ShardedStore, openWorkspace } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

/** Every path the store creates below its root, plus the one shard and one log a write makes. */
const LINKED = ['workspace.md', 'items', 'events', '.index', 'items/2026-09.md', 'events/2026-09.jsonl'] as const

/** A snapshot of a directory tree: relative path to size, so a write into it is visible. */
async function snapshot(root: string): Promise<string> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name)
      const info = await stat(full)
      if (info.isDirectory()) await walk(full)
      else out.push(`${path.relative(root, full)}:${info.size}`)
    }
  }
  await walk(root)
  return out.join('\n')
}

function update(id: string): Parameters<ShardedStore['apply']>[0] {
  return {
    txn: `t-${id}`,
    writes: [],
    events: [{
      id, at: '2026-09-02T10:00:00Z', actor: 'a', actor_kind: 'human', entity_kind: 'item',
      entity: 'item-one', op: 'update', txn: `t-${id}`,
    }],
  }
}

describe('no path at or below the workspace root is followed as a symbolic link', () => {
  for (const relative of LINKED) {
    it(`refuses ${relative} as a link, on read and on write, and writes nothing through it`, async () => {
      const workspace = await aWorkspace()
      const outside = await mkdtemp(path.join(tmpdir(), 'treadle-outside-'))
      try {
        await workspace.store.apply({ txn: 't0', writes: [{ item: anItem() }], events: [update('e0').events[0] as never] })
        await workspace.store.close()

        // Move the real path out of the workspace and leave a link in its place, which is
        // what a checkout of a hostile commit produces.
        const target = path.join(outside, path.basename(relative))
        await rename(path.join(workspace.root, relative), target)
        await symlink(target, path.join(workspace.root, relative))
        const before = await snapshot(outside)

        const store = new ShardedStore(workspace.root)
        try {
          const read = await store.list()
          assert.ok(!read.ok, `${relative} as a link was read through`)
          assert.equal(read.error.rule, 'S15')
          assert.match(read.error.message, new RegExp(`^${relative.replaceAll('.', '\\.')} is a symbolic link to `))
          assert.match(read.error.message, /--workspace/)

          const written = await store.apply(update('e1'))
          assert.ok(!written.ok, `${relative} as a link was written through`)
          assert.equal(written.error.rule, 'S15')
        } finally {
          await store.close()
        }
        assert.equal(await snapshot(outside), before, `something was written through the ${relative} link`)
      } finally {
        await rm(outside, { recursive: true, force: true })
        await workspace.dispose()
      }
    })
  }

  it('refuses the root itself as a link, naming the directory and its target', async () => {
    const workspace = await aWorkspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'treadle-outside-'))
    const link = path.join(outside, '.work')
    try {
      await workspace.store.close()
      await symlink(workspace.root, link)
      const opened = await openWorkspace(link)
      assert.ok(!opened.ok, 'a linked root was opened')
      assert.equal(opened.error.rule, 'S15')
      assert.match(opened.error.message, new RegExp(`^the workspace directory ${link.replaceAll('.', '\\.')} is a symbolic link to `))
      assert.equal(await readFile(path.join(workspace.root, 'workspace.md'), 'utf8').then((t) => t.length > 0), true, 'the real workspace is untouched')
    } finally {
      await rm(outside, { recursive: true, force: true })
      await workspace.dispose()
    }
  })
})
