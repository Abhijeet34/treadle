// SPDX-License-Identifier: Apache-2.0
// The one convention the `what` column of `history` has, held over every op the log records.
//
// The column carried three vocabularies: `state=in_progress->in_review` from a transition,
// the bare `expected,actual` from a `set` over prose, and the bare word `evidence` from an
// append. A reader could not tell whether `expected,actual` named two fields that moved or
// two values that were literally those words, and `reviewer=->dev` read as a typo.
//
// The convention is stated in the header of src/application/services/history.ts. This file
// is what makes a new op inherit it: an op whose cell carries a bare name, or a side left
// empty, fails here rather than reaching a user.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { initWorkspace } from '../../src/adapters/workspace.ts'
import { setFields } from '../../src/application/services/editing.ts'
import { history } from '../../src/application/services/history.ts'
import { fileItem } from '../../src/application/services/items.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { addEvidence, markItem } from '../../src/application/services/marking.ts'
import type { Actor } from '../../src/application/services/mutation.ts'
import type { Store } from '../../src/application/ports/store.ts'

const ACTOR: Actor = { id: 'priya', kind: 'human' }
const NOW = '2026-09-05T18:00:00Z'
const ID = 'checkout-drops-paid-orders'

/**
 * Every part of the cell: `name=value` or `name=from->to`, and nothing else. A side is a
 * printable token or one of the three markers, never empty, which is what `reviewer=->dev`
 * was.
 */
const SIDE = String.raw`(?:\(unset\)|\(\?\)|\(text:\d+\)|[^\s,>=]+)`
const PART = new RegExp(String.raw`^[a-z_.]+=${SIDE}(?:->${SIDE})?$`)

type Rig = { readonly store: Store; readonly dispose: () => Promise<void> }

/** One item taken through every op this build's log records. */
async function aLogCarryingEveryOp(): Promise<Rig> {
  const parent = await mkdtemp(path.join(tmpdir(), 'treadle-what-'))
  const root = path.join(parent, 'platform', '.work')
  const ids = sequentialIds()
  const clock = fixedClock(NOW)
  await initWorkspace(clock, ids, { at: root, name: 'what-column', actor: ACTOR })

  const opened = await openWorkspace(root)
  if (!opened.ok) throw new Error(opened.error.message)
  const store = opened.value
  const apply = targetFor(store, 'apply')
  const must = (result: { ok: boolean; data: Record<string, unknown> }, what: string) => {
    if (!result.ok) throw new Error(`${what}: ${String(result.data['cause'])}`)
  }

  must(await fileItem(apply, clock, ids, {
    type: 'bug', title: 'Checkout drops paid orders', id: ID,
    fields: {
      severity: 'S2', found_in: 'production',
      repro_steps: 'add two items to the cart and pay with a saved card',
    },
    actor: ACTOR,
  }), 'file')
  must(await setFields(apply, clock, ids, {
    id: ID,
    assignments: ['reviewer=dev', 'fix_confirmed=true', 'expected=both orders are listed', 'actual=one is charged'],
    actor: ACTOR,
  }), 'set')
  must(await markItem(apply, clock, ids, {
    id: ID, priority: '1', reason: 'it drops paid orders', actor: ACTOR,
  }), 'mark')
  must(await addEvidence(apply, clock, ids, {
    id: ID, kind: 'run', ref: '8813', label: '664 pass', actor: ACTOR,
  }), 'evidence')
  for (const target of ['ready', 'in_progress', 'in_review'] as const) {
    must(await transition(apply, clock, ids, { id: ID, target, reason: 'fixture', actor: ACTOR }), target)
  }

  return {
    store,
    dispose: async () => {
      await store.close()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

describe('the what column of history has one convention', () => {
  let rig: Rig
  let cells: readonly string[]
  let ops: readonly string[]

  before(async () => {
    rig = await aLogCarryingEveryOp()
    const log = await history(rig.store, ID, { limit: 50 })
    assert.equal(log.ok, true)
    const block = log.data['events'] as { rows: readonly Record<string, string>[] }
    cells = block.rows.map((row) => row['what'] as string)
    ops = block.rows.map((row) => row['op'] as string)
  })

  after(async () => { await rig.dispose() })

  it('covers every op this build writes, so the rule is not asserted over one shape', () => {
    assert.deepEqual([...new Set(ops)].sort(), ['item.evidence.add', 'item.file', 'item.mark', 'item.set', 'item.transition'])
  })

  it('writes every part as name=value or name=from->to, and never a bare name', (t) => {
    let parts = 0
    for (const [at, cell] of cells.entries()) {
      for (const part of cell.split(',')) {
        assert.match(part, PART, `${ops[at] as string} wrote the part ${JSON.stringify(part)}, which is not name=value or name=from->to`)
        parts += 1
      }
    }
    t.diagnostic(`${parts} parts over ${cells.length} events, ${new Set(ops).size} ops`)
  })

  it('gives the was-unset case a form a reader parses on sight', () => {
    const set = cells[ops.indexOf('item.set')] as string
    assert.match(set, /reviewer=\(unset\)->dev/, 'a field that had no previous value')
    assert.equal(set.includes('=->'), false, 'an empty side reads as a typo')
  })

  it('says of a prose field that it moved and by how much, rather than naming it alone', () => {
    const set = cells[ops.indexOf('item.set')] as string
    assert.match(set, /expected=\(unset\)->\(text:\d+\)/)
    assert.match(set, /actual=\(unset\)->\(text:\d+\)/)
  })

  it('names the kind an evidence pointer carries, and its ref where the ref fits a cell', () => {
    assert.equal(cells[ops.indexOf('item.evidence.add')], 'evidence=run:8813')
  })

  it('keeps the shapes that already read correctly', () => {
    assert.match(cells[ops.indexOf('item.transition')] as string, /state=[a-z_]+->[a-z_]+/)
    assert.match(cells[ops.indexOf('item.mark')] as string, /priority=\(unset\)->1/)
    assert.match(cells[ops.indexOf('item.file')] as string, /type=bug/)
  })

  it('reaches the rendered line with no space in the cell, which the row grammar requires', () => {
    const rendered = agentRenderer.render({
      schema: 'history/1', ok: true, code: 'OK', command: 'history', workspace: 'w',
      effect: 'read', txn: null, changed: null,
      data: { item: ID, sort: 'at desc', events: { columns: [{ name: 'what' }, { name: 'by', text: true }], shown: cells.length, total: cells.length, rows: cells.map((what) => ({ what, by: ACTOR.id })) } },
    })
    for (const cell of cells) assert.equal(/\s/.test(cell), false, `${cell} carries whitespace`)
    assert.ok(rendered.includes('evidence=run:8813'))
  })
})
