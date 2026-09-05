// SPDX-License-Identifier: Apache-2.0
// The four primitives from the domain model's 2.12, which are the product's differentiator
// rather than polish: a dry run that shows the exact diff, a preview that resolves the
// target without evaluating a guard, an explanation of an absence, and a ranking that prints
// the components and weights that produced it.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { backlog, fileItem } from '../../src/application/services/items.ts'
import { DEFAULT_WEIGHTS, next, rank, scoreOf } from '../../src/application/services/insight.ts'
import { readWorkspace } from '../../src/application/services/context.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { aDemoWorkspace, ACTOR, NOW, type Demo } from '../helpers/cli-fixtures.ts'

const CLOCK = fixedClock(NOW)

describe('--dry-run evaluates every guard and writes nothing', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  it('prints the field diff and the exit status the real run would return', async () => {
    const result = await transition(targetFor(demo.store, 'dry-run'), CLOCK, sequentialIds(100), {
      id: 'csv-export', target: 'in_progress', actor: ACTOR,
    })
    assert.equal(result.ok, true)
    assert.equal(result.data['dry_run'], 1)
    assert.equal(result.data['would_exit'], 0)
    assert.equal(result.data['state'], 'ready -> in_progress')
    assert.equal(result.data['v'], '2 -> 3')
    assert.match(String(result.data['guards']), /^G2 pass /)
  })

  it('leaves the store exactly as it was, which is the property the flag promises', async () => {
    const before = await readWorkspace(demo.store)
    assert.equal(before.ok, true)
    await transition(targetFor(demo.store, 'dry-run'), CLOCK, sequentialIds(200), {
      id: 'csv-export', target: 'in_progress', actor: ACTOR,
    })
    await fileItem(targetFor(demo.store, 'dry-run'), CLOCK, sequentialIds(300), {
      type: 'task', title: 'A task that must not be written', id: 'ghost-task', fields: {}, actor: ACTOR,
    })
    const after = await readWorkspace(demo.store)
    assert.equal(after.ok, true)
    assert.deepEqual(
      after.ok ? after.value.items.map((item) => `${item.id}@${item.version}:${item.state}`) : [],
      before.ok ? before.value.items.map((item) => `${item.id}@${item.version}:${item.state}`) : [null],
    )
  })

  it('carries a guard refusal through, so a dry run cannot approve what the real run refuses', async () => {
    const result = await transition(targetFor(demo.store, 'dry-run'), CLOCK, sequentialIds(400), {
      id: 'sso-saml', target: 'done', actor: ACTOR,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'GUARD_REFUSED')
    assert.equal(result.data['guard'], 'G5')
  })
})

describe('--preview resolves the target and evaluates nothing', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  it('names the store, the target and the guards it would evaluate', async () => {
    const result = await transition(targetFor(demo.store, 'preview'), CLOCK, sequentialIds(500), {
      id: 'csv-export', target: 'in_progress', actor: ACTOR,
    })
    assert.equal(result.data['preview'], 1)
    assert.equal(result.data['item'], 'csv-export')
    assert.match(String(result.data['store']), /platform\/\.work$/)
    assert.equal(result.data['will_evaluate'], 'G2 G3 G4')
    assert.equal(result.data['will_write'], 'item.transition')
  })

  it('says on its last line that no guard ran, so it cannot be read as a guard check', async () => {
    const result = await transition(targetFor(demo.store, 'preview'), CLOCK, sequentialIds(501), {
      id: 'sso-saml', target: 'done', actor: ACTOR,
    })
    assert.equal(result.ok, true, 'preview evaluates nothing, so a guard cannot refuse it')
    assert.equal(result.data['note'], 'guards not evaluated; use --dry-run for the outcome')
    assert.equal(result.data['guards'], undefined)
  })
})

describe('an empty result and an absence are answered rather than left silent', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  it('says how many were searched, how many matched, and which clause was narrowest', async () => {
    const result = await backlog(demo.store, {
      filters: [{ field: 'state', value: 'ready' }, { field: 'assignee', value: 'kim' }],
      columns: ['id', 'type', 'state', 'pts', 'title'], limit: 9,
    })
    assert.equal(result.data['none'], 'searched 24 matched 0')
    assert.equal(result.data['narrowest'], 'assignee kim 2', 'kim owns two items, none of them ready')
  })

  it('names the first clause that excluded an id the caller expected', async () => {
    const result = await backlog(demo.store, {
      filters: [{ field: 'state', value: 'ready' }],
      columns: ['id', 'type', 'state', 'pts', 'title'], limit: 9, explainAbsence: 'sso-saml',
    })
    assert.equal(result.data['absent'], 'sso-saml')
    assert.equal(result.data['clause'], 'state want ready got in_progress')
  })

  it('names the store it searched when the id is nowhere in it', async () => {
    const result = await backlog(demo.store, {
      filters: [], columns: ['id', 'type', 'state', 'pts', 'title'], limit: 9, explainAbsence: 'no-such-item',
    })
    assert.equal(result.data['absent'], 'no-such-item')
    assert.match(String(result.data['store']), /platform\/\.work$/)
    assert.equal(result.data['clause'], 'unknown searched 24')
  })

  it('explains a rank absence too, naming the position the id actually reached', async () => {
    const result = await next(demo.store, CLOCK, { limit: 2, explainAbsence: 'avatar-crop' })
    assert.equal(result.data['absent'], 'avatar-crop')
    assert.match(String(result.data['clause']), /^rank want 1\.\.2 got \d+$/)
  })
})

describe('next ranks deterministically and prints the weights it used (R11)', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  it('gives identical bytes for the same store state and weights', async () => {
    const a = await next(demo.store, CLOCK, { limit: 5 })
    const b = await next(demo.store, CLOCK, { limit: 5 })
    assert.deepEqual(a, b)
  })

  it('carries the six components of each row, and the weights that multiplied them', async () => {
    const result = await next(demo.store, CLOCK, { limit: 3 })
    assert.equal(result.data['weights'], 'pri 10 age 1 dep 5 spr 8 asg 0 due 4')
    const block = result.data['next'] as { rows: readonly Record<string, unknown>[] }
    for (const row of block.rows) {
      assert.match(String(row['parts']), /^p\d+\/a\d+\/d\d+\/s[01]\/m[01]\/u\d+$/)
    }
  })

  it('sorts by score descending then by id, so two implementations cannot differ', async () => {
    const view = await readWorkspace(demo.store)
    assert.equal(view.ok, true)
    const ranked = view.ok ? rank(view.value, NOW, DEFAULT_WEIGHTS, undefined) : []
    for (let i = 1; i < ranked.length; i += 1) {
      const previous = ranked[i - 1]!
      const current = ranked[i]!
      assert.ok(
        previous.score > current.score || (previous.score === current.score && previous.item.id < current.item.id),
        `${previous.item.id} and ${current.item.id} are out of order`,
      )
    }
  })

  it('applies the assignee weight only when --for names an actor, and prints asg 0 when it does not', async () => {
    const view = await readWorkspace(demo.store)
    assert.equal(view.ok, true)
    const item = view.ok ? view.value.items.find((entry) => entry.id === 'gdpr-export')! : undefined
    const without = scoreOf(view.ok ? view.value : ({} as never), item!, NOW, DEFAULT_WEIGHTS, undefined)
    const withActor = scoreOf(view.ok ? view.value : ({} as never), item!, NOW, DEFAULT_WEIGHTS, 'dana')
    assert.equal(withActor.score - without.score, DEFAULT_WEIGHTS.asg)
    const plain = await next(demo.store, CLOCK, { limit: 1 })
    assert.match(String(plain.data['weights']), / asg 0 due 4$/)
    const personal = await next(demo.store, CLOCK, { limit: 1, forActor: 'dana' })
    assert.match(String(personal.data['weights']), / asg 8 due 4$/)
  })
})
