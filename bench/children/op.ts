// SPDX-License-Identifier: Apache-2.0
// One store operation in one cold process, which is the only honest shape for a cold-start
// figure: an in-process loop would measure a warm V8 and a warm index handle, and DR1's
// budget is about neither.
//
// These are store operations and are labelled as such, plus `workspace`, which is the one
// application-layer read every command performs. The six behaviour axes drive the command
// surface itself (bench/axes/surface.ts); this child stays underneath it so a timing figure
// prices the store rather than the renderer.
//
// Usage: op.ts <root> <op> [argument]

import { readWorkspace } from '../../src/application/services/context.ts'
import { ShardedStore } from '../../src/adapters/store/index.ts'
import type { StoreEvent, StoreResult } from '../../src/application/ports/store.ts'
import type { WorkItemState } from '../../src/domain/index.ts'

const loadMs = performance.now()

const [root, op, argument] = process.argv.slice(2)
if (root === undefined || op === undefined) {
  process.stderr.write('usage: op.ts <root> <op> [argument]\n')
  process.exit(2)
}

const store = new ShardedStore(root)
const started = performance.now()

function unwrap<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    process.stderr.write(`${result.error.code} ${result.error.rule}: ${result.error.message}\n`)
    process.exit(3)
  }
  return result.value
}

/** A create appends to the shard the argument names, so it is priced against a real shard. */
function newItem(month: string) {
  const id = `bench-${process.pid}-${Date.now().toString(36)}`
  return {
    id,
    type: 'task' as const,
    state: 'draft' as const,
    title: 'benchmark create',
    filed_at: `${month}-15T12:00:00Z`,
    version: 1,
  }
}

function event(entity: string, operation: string, txn: string): StoreEvent {
  return {
    id: `ev-${process.pid}-${Date.now().toString(36)}`,
    at: '2026-09-01T12:00:00Z',
    actor: 'bench',
    actor_kind: 'process',
    entity_kind: 'work_item',
    entity,
    op: operation,
    txn,
  }
}

let ops = 0
let detail: Record<string, unknown> = {}

switch (op) {
  case 'identity': {
    const identity = unwrap(await store.identity())
    ops = 1
    detail = { workspace: identity.id }
    break
  }
  case 'get': {
    const item = unwrap(await store.get(argument as string))
    ops = 1
    detail = { found: item !== undefined, id: argument }
    break
  }
  case 'list': {
    const rows = unwrap(await store.list({ state: argument as WorkItemState, limit: 50 }))
    ops = 1
    detail = { rows: rows.length, state: argument }
    break
  }
  // The read every command performs, and the largest one the product has: `readWorkspace`
  // lists the store unbounded, indexes it by id and builds the hierarchy graph, because a
  // backlog counts the whole set and a gate reads an item's children out of it. `list` above
  // is bounded at 50 rows and prices none of that, so the memory budget was being weighed
  // over an operation no command makes.
  case 'workspace': {
    const view = unwrap(await readWorkspace(store))
    ops = 1
    detail = { items: view.items.length }
    break
  }
  case 'create': {
    const txn = `txn-bench-${process.pid}`
    const item = newItem(argument as string)
    const applied = unwrap(await store.apply({
      txn, writes: [{ item }], events: [event(item.id, 'file', txn)],
    }))
    ops = applied.writes.length
    detail = { id: item.id, version: applied.writes[0]?.version }
    break
  }
  case 'transition': {
    const found = unwrap(await store.get(argument as string))
    if (found === undefined) {
      process.stderr.write(`transition target ${argument} is not in the store\n`)
      process.exit(3)
    }
    const txn = `txn-bench-${process.pid}`
    const next: WorkItemState = found.state === 'ready' ? 'draft' : 'ready'
    const applied = unwrap(await store.apply({
      txn,
      writes: [{ item: { ...found, state: next }, ifVersion: found.version }],
      events: [event(found.id, 'transition', txn)],
    }))
    ops = applied.writes.length
    detail = { id: found.id, from: found.state, to: next, version: applied.writes[0]?.version }
    break
  }
  case 'findings': {
    const found = unwrap(await store.findings())
    ops = 1
    detail = { findings: found.length }
    break
  }
  default:
    process.stderr.write(`unknown op ${op}\n`)
    process.exit(2)
}

const inProcessMs = performance.now() - started
await store.close()

process.stdout.write(JSON.stringify({
  inProcessMs,
  maxRssKb: process.resourceUsage().maxRSS,
  ops,
  detail: { ...detail, loadMs },
}) + '\n')
