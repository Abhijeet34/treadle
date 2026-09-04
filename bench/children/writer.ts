// SPDX-License-Identifier: Apache-2.0
// One create from its own process, for axis A1. The axis counts persisted writes over
// writes that reported success, so the child reports only what it was told by the store and
// the parent counts persistence by reading the files back. A child that counted its own
// success would be measuring the claim rather than the outcome.
//
// Usage: writer.ts <root> <id> <month>

import { ShardedStore } from '../../src/adapters/store/index.ts'

const [root, id, month] = process.argv.slice(2)

const store = new ShardedStore(root as string)
const started = Date.now()
const txn = `txn-a1-${id}`

const applied = await store.apply({
  txn,
  writes: [{
    item: {
      id: id as string,
      type: 'task',
      state: 'draft',
      title: `A1 parallel create ${id}`,
      filed_at: `${month}-15T12:00:00Z`,
      version: 1,
    },
  }],
  events: [{
    id: `ev-a1-${id}`,
    at: '2026-09-01T12:00:00Z',
    actor: 'bench', actor_kind: 'process', entity_kind: 'work_item',
    entity: id as string, op: 'file', txn,
  }],
})

await store.close()

process.stdout.write(JSON.stringify(applied.ok
  ? { id, reported: 'ok', version: applied.value.writes[0]?.version, ms: Date.now() - started }
  : { id, reported: 'refused', code: applied.error.code, rule: applied.error.rule, ms: Date.now() - started }) + '\n')
if (!applied.ok) process.exitCode = 1
