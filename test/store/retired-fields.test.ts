// SPDX-License-Identifier: Apache-2.0
// A workspace written before ADR-0029 carries `sprint_id`, `points`, `hours_estimate`,
// `timebox_hours` and `component` on its records, and one written before ADR-0032 carries
// `reporter`; this build's dictionary has none of them.
//
// A key this build declared retired is dropped: `decodeItem` reads it as nothing and
// `encodeItem` never carries it forward, so it disappears from the shard on the next ordinary
// write with no user action. A key this build has simply never seen, such as one a newer build
// might write, is kept: it lands in `extra` on read and rides back out unchanged on write. The
// declared `RETIRED_FIELDS` map in src/adapters/store/item-codec.ts is what separates the two,
// and this test proves both sides of that line on the same record so they cannot be confused.
//
// The fixture is a shard written by hand rather than through the tool, because no command in
// this build can produce one and the point is a file an older or newer build wrote.

import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { doctor } from '../../src/application/services/doctor.ts'
import { showItem } from '../../src/application/services/items.ts'
import { setFields } from '../../src/application/services/editing.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { aWorkspace } from '../helpers/store-fixtures.ts'
import type { Actor } from '../../src/application/services/mutation.ts'

const NOW = '2026-09-08T09:00:00Z'
const ACTOR: Actor = { id: 'dana', kind: 'human' }

/**
 * One item shard carrying both cases at once: the six keys this build retired, and one key
 * (`squad`) it has simply never heard of, standing in for a field a newer build might write.
 */
const LEGACY_SHARD = `schema: 1

# legacy-story: A story an older build wrote

type: story
state: ready
filed_at: 2026-08-20T09:00:00Z
version: 3
priority: 2
points: 5
hours_estimate: 6
timebox_hours: 4
assignee: kim
reporter: ravi
component: payments
sprint_id: sprint-31
squad: platform

## Description

Filed before the sprint and the estimate were removed.

## Acceptance criteria

- [ ] it refreshes once
`

describe('a record written before the fields were retired', () => {
  let workspace: Awaited<ReturnType<typeof aWorkspace>>
  let root: string
  let store: Awaited<ReturnType<typeof aWorkspace>>['store']

  before(async () => {
    workspace = await aWorkspace()
    root = workspace.root
    store = workspace.store
    await mkdir(path.join(root, 'items'), { recursive: true })
    await writeFile(path.join(root, 'items', '2026-08.md'), LEGACY_SHARD, 'utf8')
  })

  after(async () => { await workspace.dispose() })

  it('serves the record rather than quarantining it, and reports no finding about it', async () => {
    const held = await store.get('legacy-story')
    assert.ok(held.ok, held.ok ? '' : held.error.message)
    assert.equal(held.value?.title, 'A story an older build wrote')
    assert.equal(held.value?.state, 'ready')

    const findings = await store.findings()
    assert.ok(findings.ok)
    assert.deepEqual(findings.value, [], 'a retired key is not a finding')

    const audit = await doctor(store, fixedClock(NOW))
    assert.equal(audit.ok, true, String(audit.data['cause']))
    assert.equal(audit.data['checked'], 1)
  })

  it('drops the six retired keys from extra, and keeps the one key it has never seen', async () => {
    const held = await store.get('legacy-story')
    assert.ok(held.ok && held.value !== undefined)
    assert.deepEqual(
      [...(held.value.extra ?? new Map())].sort(),
      [['squad', 'platform']],
      'a retired key must not reach extra, and an unknown key must',
    )
  })

  it('reports the unknown key to a reader as an extra count, never printing a retired key', async () => {
    const shown = await showItem(store, fixedClock(NOW), 'legacy-story')
    assert.equal(shown.ok, true)
    assert.equal(shown.data['extra'], 1)
    const printed = agentRenderer.render(shown)
    for (const gone of ['pts', 'sprint', 'hrs', 'component', 'timebox', 'reporter']) {
      assert.equal(printed.includes(`\n${gone} `), false, `show printed a retired key as ${gone}`)
    }
  })

  it('drops the retired keys on the next ordinary write, and carries the unknown key forward unchanged', async () => {
    const written = await setFields(targetFor(store, 'apply'), fixedClock(NOW), sequentialIds(200), {
      id: 'legacy-story', assignments: ['reviewer=ravi'], actor: ACTOR,
    })
    assert.equal(written.ok, true, String(written.data['cause']))

    const shard = await readFile(path.join(root, 'items', '2026-08.md'), 'utf8')
    for (const line of ['points: 5', 'hours_estimate: 6', 'timebox_hours: 4', 'component: payments', 'sprint_id: sprint-31', 'reporter: ravi']) {
      assert.equal(shard.includes(line), false, `the write kept the retired line ${JSON.stringify(line)}`)
    }
    assert.ok(shard.includes('squad: platform'), 'the write dropped an unknown key it should have carried forward')
    assert.ok(shard.includes('reviewer: ravi'), 'the write did not land')
  })
})
