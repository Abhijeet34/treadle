// SPDX-License-Identifier: Apache-2.0
// The typed relation graph (domain model 2.3): six kinds, each with a defined inverse,
// cycle detection on write, and the derived blocked flag computed above storage.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  LINKABLE_KINDS,
  MAX_RELATION_DEPTH,
  MAX_RELATION_ENTRIES,
  RELATION_KINDS,
  addRelation,
  blockersOf,
  emptyRelationGraph,
  findRelationCycle,
  inverseOf,
  isBlocked,
  linkableKindOf,
  relationGraphFrom,
  relationsOf,
  removeRelation,
  validateWorkItem,
} from '../../src/domain/index.ts'
import type { Relation, RelationGraph, RelationKind, WorkItemState } from '../../src/domain/index.ts'
import { NOW, errorOf, item, unwrap } from '../helpers/fixtures.ts'

function graphOf(...edges: readonly (readonly [string, RelationKind, string])[]): RelationGraph {
  return edges.reduce(
    (g, [source, kind, target]) => unwrap(addRelation(g, { kind, source, target }, live)).graph,
    emptyRelationGraph(),
  )
}

const states = (entries: Record<string, WorkItemState>) => (id: string) => entries[id]

/**
 * The state reader `addRelation` takes for `R5`. These graphs are built from bare ids with
 * no records behind them, and an id the store does not hold is not terminal, so every edge
 * below is written as if its source were live; the `R5` suite passes a real table instead.
 */
const live = (): WorkItemState | undefined => undefined

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
      const error = errorOf(addRelation(emptyRelationGraph(), { kind, source: 'a-1', target: 'a-1' }, live))
      assert.equal(error.rule, 'R1', `${kind} self relation must be refused`)
    }
  })

  it('is idempotent: writing the same edge twice adds nothing the second time', () => {
    const first = unwrap(addRelation(emptyRelationGraph(), { kind: 'blocks', source: 'a-1', target: 'b-1' }, live))
    assert.equal(first.added, true)
    const second = unwrap(addRelation(first.graph, { kind: 'blocks', source: 'a-1', target: 'b-1' }, live))
    assert.equal(second.added, false)
    assert.equal(second.graph.relations.length, 1)
  })

  it('treats relates_to as symmetric, so both spellings are the same edge', () => {
    const graph = graphOf(['a-1', 'relates_to', 'b-1'])
    const again = unwrap(addRelation(graph, { kind: 'relates_to', source: 'b-1', target: 'a-1' }, live))
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

describe('the kinds a caller may write', () => {
  it('is the three the capability contract names, out of the six the file format reads', () => {
    assert.deepEqual([...LINKABLE_KINDS], ['blocks', 'duplicates', 'relates_to'])
  })

  it('takes the contract spelling and the closed-set spelling of the symmetric kind as one kind', () => {
    assert.equal(linkableKindOf('relates-to'), 'relates_to')
    assert.equal(linkableKindOf('relates_to'), 'relates_to')
    assert.equal(linkableKindOf('blocks'), 'blocks')
    assert.equal(linkableKindOf('caused_by'), undefined)
    assert.equal(linkableKindOf('blocked_by'), undefined)
  })
})

describe('a duplicate has one original', () => {
  it('refuses a second duplicates edge out of one item, naming the first original', () => {
    const graph = graphOf(['copy-1', 'duplicates', 'orig-1'])
    const error = errorOf(addRelation(graph, { kind: 'duplicates', source: 'copy-1', target: 'orig-2' }, live))
    assert.equal(error.code, 'GUARD_REFUSED')
    assert.equal(error.rule, 'R4')
    assert.ok(error.message.includes('orig-1'), error.message)
    assert.deepEqual(error.entities, ['copy-1', 'orig-1'])
  })

  it('lets one original have many copies', () => {
    const graph = graphOf(['copy-1', 'duplicates', 'orig-1'])
    unwrap(addRelation(graph, { kind: 'duplicates', source: 'copy-2', target: 'orig-1' }, live))
  })
})

describe('the graph a set of records carries', () => {
  it('reads a stored edge off its source record and nothing off the target', () => {
    const graph = relationGraphFrom([
      item('task', { id: 'a-1', relations: [{ kind: 'blocks', target: 'b-1' }] }),
      item('task', { id: 'b-1' }),
    ])
    assert.deepEqual(graph.relations, [{ kind: 'blocks', source: 'a-1', target: 'b-1' }])
  })

  it('reads a symmetric edge a file spells from the higher id as the one edge', () => {
    const graph = relationGraphFrom([
      item('task', { id: 'b-1', relations: [{ kind: 'relates_to', target: 'a-1' }] }),
      item('task', { id: 'a-1', relations: [{ kind: 'relates_to', target: 'b-1' }] }),
    ])
    assert.deepEqual(graph.relations, [{ kind: 'relates_to', source: 'a-1', target: 'b-1' }])
  })

  it('refuses nothing, because it is the load path: a stored cycle is the load-time finder\'s', () => {
    const graph = relationGraphFrom([
      item('task', { id: 'a-1', relations: [{ kind: 'blocks', target: 'b-1' }] }),
      item('task', { id: 'b-1', relations: [{ kind: 'blocks', target: 'a-1' }] }),
    ])
    assert.equal(graph.relations.length, 2)
    assert.ok(findRelationCycle(graph, 'blocks') !== undefined)
  })
})

describe('the stored field\'s own validation', () => {
  it('refuses a self edge and a repeated edge on one record, which need no other record to see', () => {
    assert.equal(
      errorOf(validateWorkItem(item('task', { id: 'a-1', relations: [{ kind: 'blocks', target: 'a-1' }] }), { now: NOW })).rule,
      'V4',
    )
    const twice = [{ kind: 'blocks' as const, target: 'b-1' }, { kind: 'blocks' as const, target: 'b-1' }]
    assert.equal(errorOf(validateWorkItem(item('task', { id: 'a-1', relations: twice }), { now: NOW })).rule, 'V4')
  })

  it('bounds the list, naming the limit', () => {
    const relations = Array.from({ length: MAX_RELATION_ENTRIES + 1 }, (_, i) => ({ kind: 'blocks' as const, target: `t-${String(i).padStart(3, '0')}` }))
    const error = errorOf(validateWorkItem(item('task', { id: 'a-1', relations }), { now: NOW }))
    assert.equal(error.rule, 'V4')
    assert.ok(error.message.includes(String(MAX_RELATION_ENTRIES)), error.message)
    unwrap(validateWorkItem(item('task', { id: 'a-1', relations: relations.slice(1) }), { now: NOW }))
  })
})

describe('cycle detection on write', () => {
  it('refuses a two-item blocking cycle and names the path from the edge being written', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'])
    const error = errorOf(addRelation(graph, { kind: 'blocks', source: 'b-1', target: 'a-1' }, live))
    assert.equal(error.code, 'GUARD_REFUSED')
    assert.equal(error.rule, 'R2')
    assert.ok(error.message.endsWith('through b-1 -> a-1 -> b-1'), error.message)
  })

  it('refuses a longer blocking cycle', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'], ['b-1', 'blocks', 'c-1'])
    assert.equal(errorOf(addRelation(graph, { kind: 'blocks', source: 'c-1', target: 'a-1' }, live)).rule, 'R2')
  })

  it('checks each kind on its own graph, so a blocks edge does not close a duplicates cycle', () => {
    const graph = graphOf(['a-1', 'blocks', 'b-1'])
    unwrap(addRelation(graph, { kind: 'duplicates', source: 'b-1', target: 'a-1' }, live))
  })

  it('refuses a cycle in every directional kind', () => {
    for (const kind of RELATION_KINDS.filter((k) => k !== 'relates_to')) {
      const graph = graphOf(['a-1', kind, 'b-1'])
      assert.equal(
        errorOf(addRelation(graph, { kind, source: 'b-1', target: 'a-1' }, live)).rule,
        'R2',
        `${kind} must refuse a cycle`,
      )
    }
  })

  it('does not check the symmetric kind, where a cycle has no meaning', () => {
    const graph = graphOf(['a-1', 'relates_to', 'b-1'], ['b-1', 'relates_to', 'c-1'])
    unwrap(addRelation(graph, { kind: 'relates_to', source: 'c-1', target: 'a-1' }, live))
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
    const error = errorOf(addRelation(deep, { kind: 'blocks', source: last, target: 'n-0000' }, live))
    // Either the cycle or the ceiling refuses it; both are named refusals, never a crash.
    assert.ok(['R2', 'R3'].includes(error.rule ?? ''), `rule was ${error.rule}`)
  })
})

/** A layered graph: every item in one layer blocks every item in the next. */
function layered(layers: number, width: number): RelationGraph {
  const relations: Relation[] = []
  for (let layer = 0; layer < layers - 1; layer += 1) {
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < width; j += 1) {
        relations.push({ kind: 'blocks', source: `l${layer}-${i}`, target: `l${layer + 1}-${j}` })
      }
    }
  }
  return { relations }
}

/** The graph with its relation list counting how many times something walked it whole. */
function counted(graph: RelationGraph): { readonly graph: RelationGraph; readonly passes: () => number } {
  let passes = 0
  const walks: ReadonlySet<string | symbol> = new Set([Symbol.iterator, 'filter', 'some', 'map', 'find', 'forEach'])
  const relations = new Proxy(graph.relations, {
    get(target, property, receiver) {
      if (walks.has(property)) passes += 1
      return Reflect.get(target, property, receiver)
    },
  })
  return { graph: { relations }, passes: () => passes }
}

describe('the cost of a cycle check, and the read set it reports', () => {
  it('walks the relation list once per decision, not once per node it visits', () => {
    // `doctor` took 12.3 s over 200 records carrying 3,600 blocks edges, because each
    // node visited filtered the whole list; a pass count is the shape, wall time is not.
    const finder = counted(layered(6, 8))
    assert.equal(findRelationCycle(finder.graph, 'blocks'), undefined)
    assert.ok(finder.passes() <= 2, `findRelationCycle walked the list ${finder.passes()} times`)

    const writer = counted(layered(6, 8))
    unwrap(addRelation(writer.graph, { kind: 'blocks', source: 'top', target: 'l0-0' }, live))
    assert.ok(writer.passes() <= 3, `addRelation walked the list ${writer.passes()} times`)
  })

  it('finds a hand-edited cycle longer than the write-time ceiling, which a bounded walk missed', () => {
    const length = MAX_RELATION_DEPTH + 6
    const ring: RelationGraph = {
      relations: Array.from({ length }, (_, i) => ({
        kind: 'blocks' as const, source: `r-${i}`, target: `r-${(i + 1) % length}`,
      })),
    }
    const path = findRelationCycle(ring, 'blocks')
    assert.ok(path !== undefined, 'a cycle is a cycle at any length')
    assert.equal(path[0], path[path.length - 1])
    assert.equal(path.length, length + 1)
  })

  it('reports every record whose edges decided the write, so the store can refuse if one moved', () => {
    const graph = graphOf(['b-1', 'blocks', 'c-1'], ['c-1', 'blocks', 'd-1'], ['x-1', 'blocks', 'y-1'])
    const added = unwrap(addRelation(graph, { kind: 'blocks', source: 'a-1', target: 'b-1' }, live))
    assert.deepEqual([...added.read].sort(), ['b-1', 'c-1', 'd-1'], 'the nodes reachable from the target, and nothing off that path')
    const symmetric = unwrap(addRelation(graph, { kind: 'relates_to', source: 'a-1', target: 'b-1' }, live))
    assert.deepEqual(symmetric.read, [], 'a symmetric edge reads nothing')
    const again = unwrap(addRelation(graph, { kind: 'blocks', source: 'b-1', target: 'c-1' }, live))
    assert.deepEqual(again.read, [], 'an edge already stored decides nothing')
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

  it('treats a blocker the caller cannot find as inactive, so a record removed by hand holds nothing forever', () => {
    const stateOf = states({ 'legacy-oauth': 'ready', 'sso-saml': 'ready' })
    assert.deepEqual(blockersOf(graph, stateOf, 'sso-saml'), ['legacy-oauth'])
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
