// SPDX-License-Identifier: Apache-2.0
// Parent/child hierarchy, allowed pairs, cycle detection and roll-up (domain model 2.3).
// The depth and cycle tests are the regression for threat-model finding F8: write-time
// cycle detection is bypassed by a hand edit and by a git merge, so the roll-up has to
// refuse a cycle it is handed rather than recurse into it.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALLOWED_PARENT_PAIRS,
  MAX_HIERARCHY_DEPTH,
  WORK_ITEM_TYPES,
  findHierarchyCycle,
  hierarchyFrom,
  rollUp,
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
      ['epic>chore', 'epic>story', 'epic>task', 'spike>task', 'story>bug', 'story>task'],
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
          assert.ok(error.message.includes(parent) && error.message.includes(child), error.message)
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
    assert.equal(findHierarchyCycle(clean), undefined)
    const path = findHierarchyCycle(cycle)
    assert.ok(path !== undefined, 'the hand-edited cycle must be found on load')
    assert.equal(path[0], path[path.length - 1], 'the reported path closes on itself')
    assert.equal(new Set(path).size, 3)
  })
})

describe('F8 the roll-up is bounded', () => {
  it('refuses a hand-edited hierarchy cycle instead of recursing into it', () => {
    const cycle = hierarchyFrom([
      item('epic', { id: 'epic-a', parent_id: 'epic-b' }),
      item('epic', { id: 'epic-b', parent_id: 'epic-a' }),
    ])
    const error = errorOf(rollUp(cycle, 'epic-a'))
    assert.equal(error.code, 'INTEGRITY')
    assert.equal(error.rule, 'P2')
    assert.ok(error.message.includes('epic-a'), error.message)
  })

  it('refuses a self-parent cycle the same way', () => {
    const cycle = hierarchyFrom([item('task', { id: 'task-a', parent_id: 'task-a' })])
    assert.equal(errorOf(rollUp(cycle, 'task-a')).rule, 'P2')
  })

  it('refuses a chain deeper than the stated ceiling rather than overflowing the stack', () => {
    const depth = MAX_HIERARCHY_DEPTH + 5
    const chain = Array.from({ length: depth }, (_, i) =>
      item('task', {
        id: `task-${String(i).padStart(4, '0')}`,
        ...(i + 1 < depth ? { parent_id: `task-${String(i + 1).padStart(4, '0')}` } : {}),
      }))
    // Deepest first: the root is the last element, so a roll-up from it walks the whole chain.
    const error = errorOf(rollUp(hierarchyFrom(chain), `task-${String(depth - 1).padStart(4, '0')}`))
    assert.equal(error.code, 'INTEGRITY')
    assert.equal(error.rule, 'P3')
    assert.ok(error.message.includes(String(MAX_HIERARCHY_DEPTH)), error.message)
  })

  it('states a ceiling that is a real number, not Infinity', () => {
    assert.ok(Number.isInteger(MAX_HIERARCHY_DEPTH) && MAX_HIERARCHY_DEPTH > 0)
  })

  it('walks a chain exactly at the ceiling without refusing', () => {
    const depth = MAX_HIERARCHY_DEPTH
    const chain = Array.from({ length: depth }, (_, i) =>
      item('task', {
        id: `task-${String(i).padStart(4, '0')}`,
        ...(i + 1 < depth ? { parent_id: `task-${String(i + 1).padStart(4, '0')}` } : {}),
      }))
    unwrap(rollUp(hierarchyFrom(chain), `task-${String(depth - 1).padStart(4, '0')}`))
  })
})

describe('roll-up', () => {
  const epic = item('epic', { id: 'sso', state: 'in_progress' })
  const stories = [
    item('story', { id: 'sso-saml', parent_id: 'sso', points: 8, state: 'done' }),
    item('story', { id: 'sso-oidc', parent_id: 'sso', points: 5, state: 'in_progress' }),
    item('story', { id: 'sso-scim', parent_id: 'sso', points: 3, state: 'cancelled' }),
  ]

  it('sums the points of non-cancelled descendants and excludes cancelled ones from both sides', () => {
    const summary = unwrap(rollUp(hierarchyFrom([epic, ...stories]), 'sso'))
    assert.equal(summary.points, 13)
    assert.equal(summary.donePoints, 8)
    assert.equal(summary.progress, 8 / 13)
  })

  it('counts direct children and done children', () => {
    const summary = unwrap(rollUp(hierarchyFrom([epic, ...stories]), 'sso'))
    assert.equal(summary.children, 2)
    assert.equal(summary.doneChildren, 1)
  })

  it('reports progress as null rather than a division by zero when nothing is estimated', () => {
    const bare = hierarchyFrom([item('epic', { id: 'e' }), item('task', { id: 't', parent_id: 'e' })])
    assert.equal(unwrap(rollUp(bare, 'e')).progress, null)
  })

  it('rolls up through a grandchild', () => {
    const graph = hierarchyFrom([
      epic,
      item('story', { id: 'sso-saml', parent_id: 'sso', points: 8, state: 'in_progress' }),
      item('task', { id: 'saml-meta', parent_id: 'sso-saml', points: 2, state: 'done' }),
    ])
    const summary = unwrap(rollUp(graph, 'sso'))
    assert.equal(summary.points, 10)
    assert.equal(summary.donePoints, 2)
    assert.equal(summary.descendants, 2)
    assert.equal(summary.children, 1)
  })

  it('excludes a cancelled parent subtree entirely, not just the cancelled item', () => {
    const graph = hierarchyFrom([
      epic,
      item('story', { id: 'sso-saml', parent_id: 'sso', points: 8, state: 'cancelled' }),
      item('task', { id: 'saml-meta', parent_id: 'sso-saml', points: 2, state: 'done' }),
    ])
    const summary = unwrap(rollUp(graph, 'sso'))
    assert.equal(summary.points, 0)
    assert.equal(summary.descendants, 0)
  })

  it('refuses to roll up an id the graph does not hold', () => {
    assert.equal(errorOf(rollUp(hierarchyFrom([epic]), 'nowhere')).rule, 'P4')
  })
})
