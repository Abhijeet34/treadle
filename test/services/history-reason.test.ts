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
import { makeEvent } from '../../src/application/services/mutation.ts'

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

  it('lists the reasons in the order of the events they came from', async () => {
    const result = await history(demo.store, id, { limit: 50 })
    assert.equal(result.ok, true)
    const events = result.data['events'] as { rows: readonly Record<string, unknown>[] }
    const reasons = result.data['reasons'] as { rows: readonly Record<string, unknown>[] }
    // `at` and `op` repeat when three moves land in one second, so the order is the join a
    // reader is left with; it holds because both blocks are built from the same page.
    const withReason = events.rows.filter((row) =>
      reasons.rows.some((reason) => reason['at'] === row['at'] && reason['op'] === row['op']))
    assert.deepEqual(
      reasons.rows.map((row) => [row['at'], row['op']]),
      withReason.map((row) => [row['at'], row['op']]),
      'the reasons block is not in the order of the events block above it',
    )
  })

  for (const [name, renderer] of [
    ['agent', agentRenderer], ['human', humanRenderer], ['json', jsonRenderer],
  ] as const) {
    it(`returns it in the ${name} rendering of history`, async () => {
      const result = await history(demo.store, id, { limit: 50 })
      assert.equal(result.ok, true)
      const text = renderer.render(result, { width: 200 })
      assert.ok(
        text.includes(REASON),
        `the ${name} rendering of history carries no part of the recorded reason:\n${text}`,
      )
    })
  }
})

// Found by attacking the block above with a hand-edited log. `reason` is not one of the keys
// `parseEventLine` holds to safe single-line text, so every one of these reached the cell,
// and a U+202E in it reordered the rest of the line in a terminal: threat-model finding F5's
// class, arriving through a read surface that did not exist when F5 was closed.
describe('a reason a hand edit made unprintable is marked, never printed', () => {
  let demo: Demo
  let id: string
  const unprintable: readonly (readonly [string, unknown])[] = [
    ['a newline', 'line one\nline two'],
    ['a carriage return', 'carriage\rreturn'],
    ['a right-to-left override', '\u202eRTL override'],
    ['a zero-width joiner between letters', 'a\u200db'],
    ['a value over the 500 character bound', 'y'.repeat(5000)],
    ['a number', 12345],
    ['an object', { nested: 'object' }],
    ['an empty string', ''],
  ]

  before(async () => {
    demo = await aDemoWorkspace()
    const items = await demo.store.list({})
    assert.ok(items.ok && items.value.length > 0)
    id = (items.value[0] as { id: string }).id
    const events = unprintable.map(([, value], at) => makeEvent({
      id: `ehand${at}`, at: '2026-09-07T11:00:00Z', actor: { id: 'dana', kind: 'human' },
      entity: id, op: 'item.mark', before: { priority: '-' }, after: { priority: '1' },
      reason: value as string, txn: `thand${at}`, command: 'mark',
    }))
    const applied = await demo.store.apply({ txn: 'thandall', writes: [], events })
    assert.equal(applied.ok, true, 'the hand-edited events were not written')
  })

  after(async () => { await demo.dispose() })

  it('prints one row per recorded reason and no unprintable value in any rendering', async () => {
    const result = await history(demo.store, id, { limit: 200 })
    assert.equal(result.ok, true, String(result.data['cause']))
    const reasons = result.data['reasons'] as { rows: readonly Record<string, unknown>[] }
    const marked = reasons.rows.filter((row) => row['why'] === '(?)')
    assert.equal(
      marked.length, unprintable.length,
      `${unprintable.length} unprintable reasons were written and ${marked.length} were marked`,
    )
    for (const [name, renderer] of [
      ['agent', agentRenderer], ['human', humanRenderer], ['json', jsonRenderer],
    ] as const) {
      const text = renderer.render(result, { width: 200 })
      for (const [what, value] of unprintable) {
        if (typeof value !== 'string' || value.length === 0) continue
        assert.equal(
          text.includes(value), false,
          `${name} printed ${what} out of a hand-edited log`,
        )
      }
    }
  })
})
