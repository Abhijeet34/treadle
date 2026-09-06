// SPDX-License-Identifier: Apache-2.0
// `next` ranked every ready item by asking the whole relation list twice per item, once for
// its active blockers and once for what it blocks, which is O(ready x edges): 1,250 ms of a
// 1,885 ms call over 7,122 ready items and 5,000 edges on the 50,000-item corpus. `rank` now
// reads both off one index over the graph, and the ranking is the same to the byte.
//
// As with `doctor`, the property is passes over the list rather than a wall time, because a
// wall time on a shared machine is a fact about the machine.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { activeBlockers, type WorkspaceView } from '../../src/application/services/context.ts'
import { DEFAULT_WEIGHTS, rank, scoreOf } from '../../src/application/services/insight.ts'
import { hierarchyFrom, relationGraphFrom, type Relation, type WorkItemSummary } from '../../src/domain/index.ts'

const READY = 60
const NOW = '2026-09-15T12:00:00Z'

/** Every third ready item is blocked by the one before it, and every fourth blocks a done one. */
function items(): readonly WorkItemSummary[] {
  const out: WorkItemSummary[] = []
  for (let index = 0; index < READY; index += 1) {
    const id = `wi-${String(index).padStart(3, '0')}`
    const relations = []
    if (index % 3 === 2) relations.push({ kind: 'blocks' as const, target: `wi-${String(index - 1).padStart(3, '0')}` })
    if (index % 4 === 3) relations.push({ kind: 'blocks' as const, target: 'done-1' })
    out.push({
      id, type: 'task', state: 'ready', title: `task ${index}`, filed_at: '2026-09-01T09:00:00Z', version: 1,
      priority: (index % 5) + 1, ...(relations.length === 0 ? {} : { relations }),
    })
  }
  out.push({ id: 'done-1', type: 'task', state: 'done', title: 'finished', filed_at: '2026-08-01T09:00:00Z', version: 1 })
  return out
}

function viewOf(all: readonly WorkItemSummary[]): { view: WorkspaceView; passes: () => number } {
  const graph = relationGraphFrom(all)
  const relations = [...graph.relations]
  let passes = 0
  Object.defineProperty(relations, Symbol.iterator, {
    value: function* (this: readonly Relation[]) {
      passes += 1
      yield* Array.prototype.values.call(this) as Iterable<Relation>
    },
  })
  const view: WorkspaceView = {
    identity: { id: 'test', name: 'test' },
    items: all,
    byId: new Map(all.map((item) => [item.id, item])),
    hierarchy: hierarchyFrom(all),
    relations: { relations },
    sprints: [],
    sprintById: new Map(),
  }
  return { view, passes: () => passes }
}

describe('next ranks off one index over the graph', () => {
  it('walks the relation list a bounded number of times, not once per ready item', () => {
    const { view, passes } = viewOf(items())
    const ranked = rank(view, NOW, DEFAULT_WEIGHTS, undefined)
    assert.ok(ranked.length > 0)
    assert.ok(passes() <= 2, `rank walked the relation list ${passes()} times over ${READY} ready items`)
  })

  it('returns exactly what scoring each item against the whole list returns', () => {
    const { view } = viewOf(items())
    const indexed = rank(view, NOW, DEFAULT_WEIGHTS, undefined)
    const perItem = view.items
      .filter((item) => item.state === 'ready' && activeBlockers(view, item.id).length === 0)
      .map((item) => scoreOf(view, item, NOW, DEFAULT_WEIGHTS, undefined))
      .sort((a, b) => (a.score === b.score ? (a.item.id < b.item.id ? -1 : 1) : b.score - a.score))
    assert.deepEqual(indexed, perItem)
    // The fixture has to exercise both directions of the edge, or the comparison proves nothing.
    assert.ok(indexed.some((scored) => scored.parts.includes('/d1/')), 'no ranked item blocks anything')
    assert.equal(indexed.length, READY - Math.floor(READY / 3), 'the blocked items were not left out')
  })
})
