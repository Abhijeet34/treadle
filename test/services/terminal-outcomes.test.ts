// SPDX-License-Identifier: Apache-2.0
// The three things the board audit asked for that change what a reader or an agent does:
// a machine-readable reason an item stopped, an edge that says an attempt failed without
// taking the item off the board, and a date something acts on. Every case here goes through
// the real store, because what is being asserted is what lands in the committed file and in
// the log, not what a pure function returned.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { backlog, fileItem, showItem, slugFor } from '../../src/application/services/items.ts'
import { status } from '../../src/application/services/insight.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { aDemoWorkspace, ACTOR, NOW, type Demo } from '../helpers/cli-fixtures.ts'
import type { Block } from '../../src/application/result.ts'

const CLOCK = fixedClock(NOW)

describe('a cancel records why the item stopped, and revive clears it', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  it('refuses the cancel that names no resolution, naming T6 and the set', async () => {
    const refused = await transition(targetFor(demo.store, 'apply'), CLOCK, sequentialIds(300), {
      id: 'metrics-p95', target: 'cancelled', reason: 'the dashboard already has it', actor: ACTOR,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.data['rule'], 'T6')
    assert.match(String(refused.data['cause']), /cannot_reproduce/)
  })

  it('stores the resolution, reports it as a moved field and shows it on the record', async () => {
    const cancelled = await transition(targetFor(demo.store, 'apply'), CLOCK, sequentialIds(310), {
      id: 'metrics-p95', target: 'cancelled', reason: 'the dashboard already has it',
      resolution: 'duplicate', actor: ACTOR,
    })
    assert.equal(cancelled.ok, true)
    assert.deepEqual(cancelled.data['set'], ['resolution - -> duplicate'])

    const shown = await showItem(demo.store, CLOCK, 'metrics-p95')
    assert.equal(shown.data['state'], 'cancelled')
    assert.equal(shown.data['resolution'], 'duplicate')
  })

  it('counts the stopped work by resolution without reading one line of prose', async () => {
    const listed = await backlog(demo.store, {
      filters: [{ field: 'state', value: 'cancelled' }, { field: 'resolution', value: 'duplicate' }],
      columns: ['id', 'type', 'state'], limit: 9,
    })
    const block = listed.data['items'] as Block
    assert.deepEqual(block.rows.map((row) => row['id']), ['metrics-p95'])
    assert.equal(listed.data['filter'], 'state cancelled resolution duplicate')
  })

  it('clears the resolution on revive, so no record says both draft and why it stopped', async () => {
    const revived = await transition(targetFor(demo.store, 'apply'), CLOCK, sequentialIds(320), {
      id: 'metrics-p95', target: 'draft', reason: 'the dashboard was removed', actor: ACTOR,
    })
    assert.equal(revived.ok, true)
    assert.deepEqual(revived.data['set'], ['resolution duplicate -> -'])
    const shown = await showItem(demo.store, CLOCK, 'metrics-p95')
    assert.equal(shown.data['resolution'], undefined)
  })
})

describe('a failed attempt goes back to the queue, and the log says whose it was', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  it('refuses the release that names no attempt outcome', async () => {
    const refused = await transition(targetFor(demo.store, 'apply'), CLOCK, sequentialIds(330), {
      id: 'log-redact', target: 'ready', reason: 'the redactor drops the request id', actor: ACTOR,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.data['rule'], 'T6')
  })

  it('returns the item to ready with its version bumped and no field but state moved', async () => {
    const released = await transition(targetFor(demo.store, 'apply'), CLOCK, sequentialIds(340), {
      id: 'log-redact', target: 'ready', reason: 'the redactor drops the request id',
      outcome: 'failed', actor: ACTOR,
    })
    assert.equal(released.ok, true)
    assert.equal(released.data['state'], 'in_progress -> ready')
    assert.equal(released.data['v'], '3 -> 4')
    assert.deepEqual(released.data['set'], [])
  })

  it('carries the outcome and the reason in the event, and nothing of either on the record', async () => {
    const events = await demo.store.events({ entity: 'log-redact' })
    assert.equal(events.ok, true)
    const last = events.ok ? events.value[events.value.length - 1] : undefined
    assert.equal(last?.op, 'item.transition')
    assert.equal(last?.outcome, 'failed')
    assert.equal(last?.reason, 'the redactor drops the request id')

    const shown = await showItem(demo.store, CLOCK, 'log-redact')
    assert.equal(shown.data['state'], 'ready')
    assert.equal(shown.data['outcome'], undefined)
  })
})

describe('a due date is a thing three reads act on', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  it('is stored on any type and shown with the days it is past', async () => {
    const filed = await fileItem(targetFor(demo.store, 'apply'), fixedClock('2026-09-01T09:00:00Z'), sequentialIds(350), {
      type: 'task', title: 'Rotate the signing key', id: 'key-rotate',
      fields: { priority: '2', due: '2026-09-02T09:00:00Z' }, actor: ACTOR,
    })
    assert.equal(filed.ok, true)
    assert.ok((filed.data['set'] as readonly string[]).includes('due - -> 2026-09-02T09:00:00Z'))

    const shown = await showItem(demo.store, CLOCK, 'key-rotate')
    assert.equal(shown.data['due'], '2026-09-02T09:00:00Z')
    assert.equal(shown.data['overdue'], 2)
  })

  it('raises H17 on status, because a date nobody owns is a date nothing acts on', async () => {
    const before = await status(demo.store, CLOCK)
    assert.equal(before.data['overdue'], 1)
    const health = before.data['health'] as Block
    assert.deepEqual(health.rows, [{ rule: 'H17', item: 'key-rotate', saw: 'due 2026-09-02T09:00:00Z and assigned to nobody' }])
  })

  it('says nothing at all when no date has passed, which is the common read', async () => {
    const early = await status(demo.store, fixedClock('2026-09-01T10:00:00Z'))
    assert.equal(early.data['overdue'], undefined)
    assert.equal(early.data['health'], undefined)
  })
})

describe('a generated id stops at a word, because a person reads it hundreds of times', () => {
  const taken = new Set<string>()

  it('keeps a whole word rather than cutting mid-word at byte 24', () => {
    assert.equal(slugFor('SAML login for enterprise tenants', 'story', taken), 'saml-login-for-enterprise')
    assert.equal(slugFor('Checkout drops the session on a 401', 'bug', taken), 'checkout-drops-the-session-on-a')
    assert.equal(slugFor('Export a filtered list to CSV', 'story', taken), 'export-a-filtered-list-to-csv')
  })

  it('stays inside the dictionary and never ends on a hyphen', () => {
    for (const title of [
      'Supercalifragilisticexpialidocious behaviour in the parser',
      'a b c d e f g h i j k l m n o p q r s t u v w x y z',
      'Rewrite the first-run text',
    ]) {
      const slug = slugFor(title, 'task', taken)
      assert.ok(slug.length >= 3 && slug.length <= 64, `${slug} is ${slug.length} characters`)
      assert.doesNotMatch(slug, /^-|-$/, slug)
    }
  })

  it('still dedupes against what the store already holds', () => {
    const held = new Set(['saml-login-for-enterprise'])
    assert.equal(slugFor('SAML login for enterprise tenants', 'story', held), 'saml-login-for-enterprise-2')
  })
})
