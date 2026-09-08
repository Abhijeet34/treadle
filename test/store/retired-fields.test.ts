// SPDX-License-Identifier: Apache-2.0
// A workspace written before ADR-0029 carries `sprint_id`, `points`, `hours_estimate`,
// `timebox_hours` and `component` on its records, and this build's dictionary has none of them.
//
// There are three things a store can do with a field it no longer knows: drop it, quarantine
// the record, or keep it. Only the third is acceptable here, because docs/STABILITY.md says a
// workspace written by any released version is readable by every later one, and the mechanism
// that keeps it was already in the tree: `decodeItem` puts a key `isKnownField` refuses into
// `extra`, and `encodeItem` writes `extra` back out. The removal did not add that path, it
// inherited it, which is exactly why it needs a test of its own: nothing else in the suite
// would notice the day someone made a retired key quarantine or vanish.
//
// The fixture is a shard written by hand rather than through the tool, because no command in
// this build can produce one and the point is a file an older build wrote.

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

/** One item shard as the build before the cut wrote it: five retired keys and nothing else odd. */
const LEGACY_SHARD = `schema: 1

# legacy-story: A story an older build wrote

type: story
state: ready
filed_at: 2026-08-20T09:00:00Z
version: 3
priority: 2
points: 5
hours_estimate: 6
assignee: kim
component: payments
sprint_id: sprint-31

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

  it('carries all five retired keys in extra rather than dropping them', async () => {
    const held = await store.get('legacy-story')
    assert.ok(held.ok && held.value !== undefined)
    assert.deepEqual(
      [...(held.value.extra ?? new Map())].sort(),
      [
        ['component', 'payments'],
        ['hours_estimate', '6'],
        ['points', '5'],
        ['sprint_id', 'sprint-31'],
      ],
    )
  })

  it('reports them to a reader as a count, never as fields this build could validate', async () => {
    const shown = await showItem(store, fixedClock(NOW), 'legacy-story')
    assert.equal(shown.ok, true)
    assert.equal(shown.data['extra'], 4)
    const printed = agentRenderer.render(shown)
    for (const gone of ['pts', 'sprint', 'hrs', 'component']) {
      assert.equal(printed.includes(`\n${gone} `), false, `show printed a retired key as ${gone}`)
    }
  })

  it('writes them back unchanged on the next mutation, so the file survives a write', async () => {
    const written = await setFields(targetFor(store, 'apply'), fixedClock(NOW), sequentialIds(200), {
      id: 'legacy-story', assignments: ['reviewer=ravi'], actor: ACTOR,
    })
    assert.equal(written.ok, true, String(written.data['cause']))

    const shard = await readFile(path.join(root, 'items', '2026-08.md'), 'utf8')
    for (const line of ['points: 5', 'hours_estimate: 6', 'component: payments', 'sprint_id: sprint-31']) {
      assert.ok(shard.includes(line), `the write dropped ${JSON.stringify(line)} from the shard`)
    }
    assert.ok(shard.includes('reviewer: ravi'), 'the write did not land')
  })
})
