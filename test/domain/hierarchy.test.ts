// SPDX-License-Identifier: Apache-2.0
// Parent/child hierarchy, allowed pairs and cycle detection (domain model 2.3).
// The depth and cycle tests are the regression for threat-model finding F8: write-time
// cycle detection is bypassed by a hand edit and by a git merge, so the parent walk has to
// refuse a chain it is handed rather than recurse into it.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALLOWED_PARENT_PAIRS,
  MAX_HIERARCHY_DEPTH,
  WORK_ITEM_TYPES,
  findParentCycle,
  hierarchyFrom,
  setParent,
} from '../../src/domain/index.ts'
import type { WorkItem } from '../../src/domain/index.ts'
import { errorOf, item, unwrap } from '../helpers/fixtures.ts'

function tree(...items: readonly WorkItem[]) {
  return hierarchyFrom(items)
}

describe('allowed parent pairs', () => {
  it('is exactly the six pairs the model names', () => {
    assert.deepEqual(
      ALLOWED_PARENT_PAIRS.map((p) => `${p.parent}>${p.child}`).sort(),
      ['epic>story', 'epic>task', 'spike>task', 'story>bug', 'story>task'],
    )
  })

  it('accepts every allowed pair and refuses every other one, naming the pair', () => {
    for (const parent of WORK_ITEM_TYPES) {
      for (const child of WORK_ITEM_TYPES) {
        const graph = tree(item(parent, { id: 'p-1' }), item(child, { id: 'c-1' }))
        const result = setParent(graph, 'c-1', 'p-1')
        const allowed = ALLOWED_PARENT_PAIRS.some((p) => p.parent === parent && p.child === child)
        if (allowed) {
          assert.equal(unwrap(result).parentOf.get('c-1'), 'p-1', `${parent}>${child}`)
        } else {
          const error = errorOf(result)
          assert.equal(error.rule, 'P1', `${parent}>${child} should be refused`)
          const article = (type: string): string => (type === 'epic' || type === 'impediment' ? 'an' : 'a')
          assert.equal(error.message, `${article(parent)} ${parent} cannot be the parent of ${article(child)} ${child}`)
        }
      }
    }
  })

  it('refuses a parent that is not in the store', () => {
    const graph = tree(item('task', { id: 'c-1' }))
    assert.equal(errorOf(setParent(graph, 'c-1', 'nowhere')).rule, 'P4')
  })
})

describe('cycle detection on write', () => {
  it('refuses an item as its own parent', () => {
    const graph = tree(item('task', { id: 'c-1' }))
    const error = errorOf(setParent(graph, 'c-1', 'c-1'))
    assert.equal(error.rule, 'P2')
  })

  it('refuses an edge that would close a cycle over an edge a hand edit already left', () => {
    // No pair in the table can form a cycle on its own, so the only way to reach the check
    // is a graph that a file or a merge already put a bad edge into. That is F8's premise.
    const handEdited = hierarchyFrom([
      item('story', { id: 'story-1', parent_id: 'task-1' }),
      item('task', { id: 'task-1' }),
    ])
    const error = errorOf(setParent(handEdited, 'task-1', 'story-1'))
    assert.equal(error.rule, 'P2')
    assert.ok(error.message.includes('story-1') && error.message.includes('task-1'), error.message)
  })

  it('finds a hand-edited cycle on load and reports the path that closes it', () => {
    const clean = hierarchyFrom([
      item('task', { id: 'task-a', parent_id: 'task-b' }),
      item('task', { id: 'task-b', parent_id: 'task-c' }),
      item('task', { id: 'task-c' }),
    ])
    const cycle = hierarchyFrom([
      item('task', { id: 'task-a', parent_id: 'task-b' }),
      item('task', { id: 'task-b', parent_id: 'task-c' }),
      item('task', { id: 'task-c', parent_id: 'task-a' }),
    ])
    assert.equal(findParentCycle(clean.parentOf), undefined)
    const path = findParentCycle(cycle.parentOf)
    assert.ok(path !== undefined, 'the hand-edited cycle must be found on load')
    assert.equal(path[0], path[path.length - 1], 'the reported path closes on itself')
    assert.equal(new Set(path).size, 3)
  })
})

describe('F8 the parent walk is bounded', () => {
  /** A chain a hand edit could leave: story parented to story is not an allowed pair, so
   *  no write makes this and only the load path can hand it to the walk. */
  const storyChain = (depth: number) => hierarchyFrom(Array.from({ length: depth }, (_, i) =>
    item('story', {
      id: `story-${String(i).padStart(4, '0')}`,
      ...(i + 1 < depth ? { parent_id: `story-${String(i + 1).padStart(4, '0')}` } : {}),
    })))

  it('states a ceiling that is a real number, not Infinity', () => {
    assert.ok(Number.isInteger(MAX_HIERARCHY_DEPTH) && MAX_HIERARCHY_DEPTH > 0)
  })

  it('refuses a parent chain a hand edit already closed into a cycle', () => {
    const graph = hierarchyFrom([
      item('story', { id: 'story-1', parent_id: 'story-2' }),
      item('story', { id: 'story-2', parent_id: 'story-1' }),
      item('task', { id: 'loose-task' }),
    ])
    const error = errorOf(setParent(graph, 'loose-task', 'story-1'))
    assert.equal(error.code, 'INTEGRITY')
    assert.equal(error.rule, 'P2')
    assert.ok(error.message.includes('story-1'), error.message)
  })

  it('refuses a parent chain deeper than the stated ceiling rather than overflowing the stack', () => {
    const graph = hierarchyFrom([
      ...[...storyChain(MAX_HIERARCHY_DEPTH + 5).parentOf].map(([id, parent_id]) =>
        item('story', { id, parent_id })),
      item('story', { id: `story-${String(MAX_HIERARCHY_DEPTH + 4).padStart(4, '0')}` }),
      item('task', { id: 'loose-task' }),
    ])
    const error = errorOf(setParent(graph, 'loose-task', 'story-0000'))
    assert.equal(error.code, 'INTEGRITY')
    assert.equal(error.rule, 'P3')
    assert.ok(error.message.includes(String(MAX_HIERARCHY_DEPTH)), error.message)
  })

  it('walks a parent chain exactly at the ceiling without refusing', () => {
    const graph = hierarchyFrom([
      ...[...storyChain(MAX_HIERARCHY_DEPTH).parentOf].map(([id, parent_id]) =>
        item('story', { id, parent_id })),
      item('story', { id: `story-${String(MAX_HIERARCHY_DEPTH - 1).padStart(4, '0')}` }),
      item('task', { id: 'loose-task' }),
    ])
    unwrap(setParent(graph, 'loose-task', 'story-0000'))
  })
})
