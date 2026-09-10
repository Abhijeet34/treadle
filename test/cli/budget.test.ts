// SPDX-License-Identifier: Apache-2.0
// The interface specification's A.3 budgets, enforced in bytes.
//
// Bytes are the gate and tokens are advisory, per DR8: a tokenizer is a package, this
// repository has zero runtime dependencies, and byte counts already move in the same
// direction for every decision A.2 measured. The token figures are in the pull request,
// taken with @anthropic-ai/tokenizer and gpt-tokenizer outside this tree.
//
// A budget is stated against a three-character binary name, and every figure shifts by
// (len(name) - 3) per occurrence; `treadling` is four characters longer, so a budget is
// re-derived here by counting the occurrences in the artefact itself.

import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'

import type { ResultObject } from '../../src/application/result.ts'
import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { goldenResults } from '../helpers/cli-fixtures.ts'

/** Artefact to the CI budget the interface specification states for it, in bytes. */
const BUDGET: Readonly<Record<string, number>> = {
  status: 1070,
  backlog: 960,
  'backlog-empty': 140,
  show: 310,
  next: 510,
  explain: 750,
  // A.3 predates the command, so this figure is derived rather than quoted: it gives the
  // golden history the same 75 percent fill that A.3 gave `backlog` (717 of 960) and `next`
  // (380 of 510). Raised from 380 when `history` began returning the reasons its own log
  // records: the golden artefact went from 280 B to 468 B, 88 of which are the `reasons`
  // block for two events that carry one, and a field the tool records and no reading returns
  // is the defect this product has now shipped four times. The budget owner reconciles it
  // with A.3 and with the copy of this table in bench/axes/a3-output.ts.
  history: 630,
  transition: 230,
  'transition-already': 110,
  'transition-dry-run': 250,
  'not-found': 160,
  'guard-refused': 270,
}

const NAME_COST = 'treadling'.length - 'wmx'.length

describe('every budgeted artefact is inside the byte budget A.3 measured', () => {
  let golden: ReadonlyMap<string, ResultObject>

  before(async () => {
    golden = await goldenResults()
  })

  it('has a golden object for every budgeted artefact', () => {
    for (const name of Object.keys(BUDGET)) {
      assert.ok(golden.has(name), `no golden object named ${name}`)
    }
  })

  for (const [name, budget] of Object.entries(BUDGET)) {
    it(`${name} is at most ${budget} B`, () => {
      const bytes = agentRenderer.render(golden.get(name) as ResultObject)
      const size = Buffer.byteLength(bytes, 'utf8')
      const occurrences = (bytes.match(/\btreadling\b/g) ?? []).length
      const allowed = budget + occurrences * NAME_COST
      assert.ok(
        size <= allowed,
        `${name} is ${size} B against ${allowed} B (${budget} plus ${occurrences} name occurrences):\n${bytes}`,
      )
    })
  }

  it('is cheaper than the JSON rendering of the same content, which is what R1 priced', () => {
    const list = golden.get('backlog') as ResultObject
    const line = Buffer.byteLength(agentRenderer.render(list), 'utf8')
    const json = Buffer.byteLength(`${JSON.stringify(list, null, 2)}\n`, 'utf8')
    assert.ok(json > line * 2, `JSON is ${json} B against ${line} B; R1's measured ratio was 2.42x`)
  })
})
