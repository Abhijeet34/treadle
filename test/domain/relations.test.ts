// SPDX-License-Identifier: Apache-2.0
// The typed relation graph (domain model 2.3): six kinds, each with a defined inverse,
// cycle detection on write, and the derived blocked flag computed above storage.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_RELATION_DEPTH,
  RELATION_KINDS,
  addRelation,
  blockersOf,
  emptyRelationGraph,
  findRelationCycle,
  inverseOf,
  isBlocked,
  relationsOf,
  removeRelation,
} from '../../src/domain/index.ts'
import type { RelationGraph, RelationKind, WorkItemState } from '../../src/domain/index.ts'
import { errorOf, unwrap } from '../helpers/fixtures.ts'

function graphOf(...edges: readonly (readonly [string, RelationKind, string])[]): RelationGraph {
  return edges.reduce(
    (g, [source, kind, target]) => unwrap(addRelation(g, { kind, source, target })).graph,
    emptyRelationGraph(),
  )
}

const states = (entries: Record<string, WorkItemState>) => (id: string) => entries[id]

describe('the relation kinds', () => {
  it('is exactly the six the model names', () => {
    assert.deepEqual(
      [...RELATION_KINDS],
      ['blocks', 'duplicates', 'caused_by', 'discovered_from', 'split_from', 'relates_to'],
    )
  })

  it('gives every kind the inverse the model names', () => {
    assert.deepEqual(
      Object.fromEntries(RELATION_KINDS.map((k) => [k, inverseOf(k)])),
      {
        blocks: 'blocked_by',
        duplicates: 'duplicated_by',
        caused_by: 'causes',
        discovered_from: 'led_to',
        split_from: 'split_into',
        relates_to: 'relates_to',
      },
    )
  })
})

describe('writing a relation', () => {
  it('refuses a self relation for every kind', () => {
    for (const kind of RELATION_KINDS) {
      const error = errorOf(addRelation(emptyRelationGraph(), { kind, source: 'a-1', target: 'a-1' }))
      assert.equal(error.rule, 'R1', `${kind} self relation must be refused`)
    }
  })

  it('is idempotent: writing the same edge twice adds nothing the second time', () => {
    const first = unwrap(addRelation(emptyRelationGraph(), { kind: 'blocks', source: 'a-1', target: 'b-1' }))
    assert.equal(first.added, true)
    const second = unwrap(addRelation(first.graph, { kind: 'blocks', source: 'a-1', target: 'b-1' }))
    assert.equal(second.added, false)
    assert.equal(second.graph.relations.length, 1)
  })

  it('treats relates_to as symmetric, so both spellings are the same edge', () => {
    const graph = graphOf(['a-1', 'relates_to', 'b-1'])
    const again = unwrap(addRelation(graph, { kind: 'relates_to', source: 'b-1', target: 'a-1' }))
    assert.equal(again.added, false)
    assert.equal(again.graph.relations.length, 1)
  })

  it('keeps two kinds between the same pair as two edges', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'], ['a-1', 'relates_to', 'b-1'])
    assert.equal(graph.relations.length, 2)
  })

  it('removes an edge, and removing a missing edge is a no-op rather than an error', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'])
    const removed = removeRelation(graph, { kind: 'blocks', source: 'a-1', target: 'b-1' })
    assert.equal(removed.removed, true)
    assert.equal(removed.graph.relations.length, 0)
    assert.equal(removeRelation(removed.graph, { kind: 'blocks', source: 'a-1', target: 'b-1' }).removed, false)
  })
})

describe('cycle detection on write', () => {
  it('refuses a two-item blocking cycle and names the path', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'])
    const error = errorOf(addRelation(graph, { kind: 'blocks', source: 'b-1', target: 'a-1' }))
    assert.equal(error.code, 'GUARD_REFUSED')
    assert.equal(error.rule, 'R2')
    assert.ok(error.message.includes('a-1') && error.message.includes('b-1'), error.message)
  })

  it('refuses a longer blocking cycle', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'], ['b-1', 'blocks', 'c-1'])
    assert.equal(errorOf(addRelation(graph, { kind: 'blocks', source: 'c-1', target: 'a-1' })).rule, 'R2')
  })

  it('checks each kind on its own graph, so a blocks edge does not close a duplicates cycle', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'])
    unwrap(addRelation(graph, { kind: 'duplicates', source: 'b-1', target: 'a-1' }))
  })

  it('refuses a cycle in every directional kind', () => {
    for (const kind of RELATION_KINDS.filter((k) => k !== 'relates_to')) {
      const graph = graphOf(['a-1', kind, 'b-1'])
      assert.equal(
        errorOf(addRelation(graph, { kind, source: 'b-1', target: 'a-1' })).rule,
        'R2',
        `${kind} must refuse a cycle`,
      )
    }
  })

  it('does not check the symmetric kind, where a cycle has no meaning', () => {
    const graph = graphOf(['a-1', 'relates_to', 'b-1'], ['b-1', 'relates_to', 'c-1'])
    unwrap(addRelation(graph, { kind: 'relates_to', source: 'c-1', target: 'a-1' }))
  })

  it('finds a hand-edited cycle on load, which write-time detection cannot see', () => {
    const handEdited: RelationGraph = {
      relations: [
        { kind: 'blocks', source: 'a-1', target: 'b-1' },
        { kind: 'blocks', source: 'b-1', target: 'a-1' },
      ],
    }
    const path = findRelationCycle(handEdited, 'blocks')
    assert.ok(path !== undefined)
    assert.equal(path[0], path[path.length - 1])
    assert.equal(findRelationCycle(graphOf(['a-1', 'blocks', 'b-1']), 'blocks'), undefined)
  })

  it('F8: bounds the traversal, so a hand-edited chain past the ceiling refuses rather than overflowing', () => {
    const relations = Array.from({ length: MAX_RELATION_DEPTH + 5 }, (_, i) => ({
      kind: 'blocks' as const,
      source: `n-${String(i).padStart(4, '0')}`,
      target: `n-${String(i + 1).padStart(4, '0')}`,
    }))
    const deep: RelationGraph = { relations }
    const last = `n-${String(relations.length).padStart(4, '0')}`
    const error = errorOf(addRelation(deep, { kind: 'blocks', source: last, target: 'n-0000' }))
    // Either the cycle or the ceiling refuses it; both are named refusals, never a crash.
    assert.ok(['R2', 'R3'].includes(error.rule ?? ''), `rule was ${error.rule}`)
  })
})

describe('the derived blocked flag', () => {
  const graph = graphOf(
    ['auth-refresh', 'blocks', 'sso-saml'],
    ['legacy-oauth', 'blocks', 'sso-saml'],
    ['sso-saml', 'relates_to', 'audit-log'],
  )

  it('names only blockers that are still active', () => {
    const stateOf = states({
      'auth-refresh': 'in_progress',
      'legacy-oauth': 'done',
      'sso-saml': 'ready',
      'audit-log': 'draft',
    })
    assert.deepEqual(blockersOf(graph, stateOf, 'sso-saml'), ['auth-refresh'])
    assert.equal(isBlocked(graph, stateOf, 'sso-saml'), true)
  })

  it('treats a cancelled blocker as inactive', () => {
    const stateOf = states({
      'auth-refresh': 'cancelled',
      'legacy-oauth': 'done',
      'sso-saml': 'ready',
    })
    assert.deepEqual(blockersOf(graph, stateOf, 'sso-saml'), [])
    assert.equal(isBlocked(graph, stateOf, 'sso-saml'), false)
  })

  it('is computed, never stored: the same graph gives a different answer as states move', () => {
    const before = states({ 'auth-refresh': 'ready', 'legacy-oauth': 'ready', 'sso-saml': 'ready' })
    const after = states({ 'auth-refresh': 'done', 'legacy-oauth': 'done', 'sso-saml': 'ready' })
    assert.equal(blockersOf(graph, before, 'sso-saml').length, 2)
    assert.equal(blockersOf(graph, after, 'sso-saml').length, 0)
  })

  it('never reports a symmetric relation as a blocker', () => {
    const stateOf = states({ 'sso-saml': 'ready', 'audit-log': 'in_progress' })
    assert.deepEqual(blockersOf(graph, stateOf, 'audit-log'), [])
  })
})

describe('relationsOf', () => {
  it('reports outgoing edges under the kind and incoming edges under the inverse', () => {
    const graph = graphOf(['auth-refresh', 'blocks', 'sso-saml'])
    assert.deepEqual(relationsOf(graph, 'sso-saml'), [
      { kind: 'blocked_by', other: 'auth-refresh', direction: 'incoming' },
    ])
    assert.deepEqual(relationsOf(graph, 'auth-refresh'), [
      { kind: 'blocks', other: 'sso-saml', direction: 'outgoing' },
    ])
  })

  it('reports a symmetric relation once, under its own name, from either side', () => {
    const graph = graphOf(['a-1', 'relates_to', 'b-1'])
    assert.deepEqual(relationsOf(graph, 'a-1'), [
      { kind: 'relates_to', other: 'b-1', direction: 'outgoing' },
    ])
    assert.deepEqual(relationsOf(graph, 'b-1'), [
      { kind: 'relates_to', other: 'a-1', direction: 'outgoing' },
    ])
  })
})
