// SPDX-License-Identifier: Apache-2.0
// One store operation in one cold process, which is the only honest shape for a cold-start
// figure: an in-process loop would measure a warm V8 and a warm index handle, and DR1's
// budget is about neither.
//
// Six of these are store operations and are labelled as such. The rest sit one layer up, at
// the application seam: `workspace` is the read every command performs, `board`, `next` and
// `doctor` are the three commands whose cost is not the store's, and `cycle` is the load-time
// relation check on its own. None of them renders, so a figure here prices the work and not
// the renderer; the six behaviour axes drive the command surface itself (bench/axes/surface.ts).
//
// Usage: op.ts <root> <op> [argument]

import { board } from '../../src/application/services/board.ts'
import { readWorkspace } from '../../src/application/services/context.ts'
import { doctor } from '../../src/application/services/doctor.ts'
import { next as nextUp } from '../../src/application/services/insight.ts'
import { ShardedStore } from '../../src/adapters/store/index.ts'
import type { StoreEvent, StoreResult } from '../../src/application/ports/store.ts'
import { findRelationCycle, relationGraphFrom, type WorkItemState } from '../../src/domain/index.ts'

/** The clock the three service reads need. Fixed, so a run is not a function of the day. */
const CLOCK = { now: () => '2026-09-15T12:00:00Z' }

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
    // Leaving `on_hold` clears the two fields that state owns, exactly as the transition
    // service does. Without it the probe landed on an on_hold record 20 times out of 20 and
    // the whole mutation column was V4 refusals, which the gate then reported as NOT
    // MEASURED rather than as a pass.
    const { hold_reason: _reason, held_from: _from, ...rest } = found
    const applied = unwrap(await store.apply({
      txn,
      writes: [{ item: { ...rest, state: next }, ifVersion: found.version }],
      events: [event(found.id, 'transition', txn)],
    }))
    ops = applied.writes.length
    detail = { id: found.id, from: found.state, to: next, version: applied.writes[0]?.version }
    break
  }
  // Three commands rather than store calls, because each pays something the store seam
  // cannot see. `board` is the widest read in the tool: the whole-workspace read plus the
  // relation graph indexed by blocked item plus five grouped columns. `next` ranks every
  // ready item and asks the graph for each one's blockers. `doctor` pairs every item with
  // its events and runs the load-time relation cycle check.
  case 'board': {
    // The whole workspace rather than the open sprint: the budget prices the widest read the
    // product performs, and `--all` is that form of this command.
    const result = await board(store, CLOCK, { filters: [], columns: [], limit: 50, all: true })
    if (!result.ok) {
      process.stderr.write(`${result.code}: ${String(result.data['cause'])}\n`)
      process.exit(3)
    }
    ops = 1
    detail = { blocked: result.data['blocked'], scope: result.data['scope'] }
    break
  }
  case 'next': {
    const result = await nextUp(store, CLOCK, { limit: 50 })
    if (!result.ok) {
      process.stderr.write(`${result.code}: ${String(result.data['cause'])}\n`)
      process.exit(3)
    }
    ops = 1
    detail = { ranked: (result.data['next'] as { total?: number } | undefined)?.total }
    break
  }
  case 'doctor': {
    const result = await doctor(store)
    if (!result.ok) {
      process.stderr.write(`${result.code}: ${String(result.data['cause'])}\n`)
      process.exit(3)
    }
    ops = 1
    detail = { checked: result.data['checked'], findings: (result.data['findings'] as { total?: number } | undefined)?.total }
    break
  }
  // The load-time cycle check on its own, off a graph the store has already handed over, so
  // the figure is the walk and not the read that fed it.
  case 'cycle': {
    const view = unwrap(await readWorkspace(store))
    const graphStarted = performance.now()
    const graph = relationGraphFrom(view.items)
    const built = performance.now()
    const cycle = findRelationCycle(graph, 'blocks')
    ops = 1
    detail = {
      edges: graph.relations.length,
      buildMs: Number((built - graphStarted).toFixed(3)),
      findMs: Number((performance.now() - built).toFixed(3)),
      cycle: cycle === undefined ? 'none' : cycle.join(' -> '),
    }
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
