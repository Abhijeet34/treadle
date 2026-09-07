// SPDX-License-Identifier: Apache-2.0
// `mark --reason` is recorded and can be read back.
//
// Measured on 2026-09-07: `treadle mark <id> --priority 1 --reason "revenue path"` wrote
// `"reason":"revenue path"` into events/<month>.jsonl, and `history <id>`, `history <id>
// --out json` and `history <id> -vvv --log-values` printed no part of it. `mark`'s own
// one-line contract says the reason is in the log; the log is the tool's, so a caller who
// has to open the JSONL to read it is reading around the tool.
//
// `explain` prints the reason of the event that put the item in the state it is in, which is
// a transition or a creation. A mark moves no state, so no reading reached it.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { history } from '../../src/application/services/history.ts'
import { markItem } from '../../src/application/services/marking.ts'
import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { humanRenderer } from '../../src/adapters/render/human.ts'
import { jsonRenderer } from '../../src/adapters/render/json.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { targetFor } from '../../src/adapters/target.ts'

const REASON = 'revenue path, the checkout funnel depends on it'

describe('a reason the log records is a reason a reading returns', () => {
  let demo: Demo
  let id: string

  before(async () => {
    demo = await aDemoWorkspace()
    const clock = fixedClock('2026-09-07T10:00:00Z')
    const items = await demo.store.list({})
    assert.ok(items.ok && items.value.length > 0, 'the demo workspace holds no item to mark')
    id = (items.value[0] as { id: string }).id
    const marked = await markItem(targetFor(demo.store, 'apply'), clock, sequentialIds(900), {
      id, priority: '1', reason: REASON, actor: { id: 'dana', kind: 'human' },
    })
    assert.equal(marked.ok, true, `mark refused: ${String(marked.data['cause'])}`)
  })

  after(async () => { await demo.dispose() })

  for (const [name, renderer] of [
    ['agent', agentRenderer], ['human', humanRenderer], ['json', jsonRenderer],
  ] as const) {
    it(`returns it in the ${name} rendering of history`, async () => {
      const result = await history(demo.store, id, { limit: 50 })
      assert.equal(result.ok, true, String(result.data['cause']))
      const text = renderer.render(result, { width: 200 })
      assert.ok(
        text.includes(REASON),
        `the ${name} rendering of history carries no part of the recorded reason:\n${text}`,
      )
    })
  }
})
