// SPDX-License-Identifier: Apache-2.0
// A creation refusal names every field the type requires and is missing, in one line.
//
// Measured on 2026-09-07: `treadling file bug "Nothing set here"` answered `a bug needs
// severity at creation`, and answering it earned `a bug needs repro_steps at creation`, and
// answering that earned `a bug needs found_in at creation`. Three refusals and three round
// trips for one fact the tool held all along, on `bug` and on `spike` alike.
//
// ADR-0020 settled this for reads: a finding is decided by a whole read, not by the first
// thing that fails. The same rule applies to a refusal, and DOR2 already names every missing
// field in one sentence; the creation check was the one place that stopped at the first.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { WORK_ITEM_TYPES, requiredAtCreation, validateWorkItem, type WorkItem } from '../../src/domain/index.ts'

const NOW = '2026-09-07T09:00:00Z'

/** A record of one type carrying only what every work item needs, and none of its own. */
function bare(type: string): WorkItem {
  return {
    id: 'nothing-set-here', type, state: 'draft', title: 'Nothing set here',
    filed_at: NOW, version: 1,
  } as unknown as WorkItem
}

describe('a creation refusal names every field the type requires and has not got', () => {
  for (const type of WORK_ITEM_TYPES) {
    const required = requiredAtCreation(type)
    if (required.length < 2) continue
    it(`${type} names all ${required.length} of them in one refusal`, () => {
      const verdict = validateWorkItem(bare(type), { now: NOW })
      assert.equal(verdict.ok, false, `a ${type} with none of its required fields was accepted`)
      const cause = verdict.ok ? '' : verdict.error.message
      for (const field of required) {
        assert.ok(cause.includes(field), `${type}: the refusal does not name ${field}: ${cause}`)
      }
    })
  }

  it('still names one field alone when one is all that is missing', () => {
    const item = { ...bare('bug'), severity: 'S1', repro_steps: 'reload twice' } as unknown as WorkItem
    const verdict = validateWorkItem(item, { now: NOW })
    assert.equal(verdict.ok, false)
    const cause = verdict.ok ? '' : verdict.error.message
    assert.equal(cause, 'a bug needs found_in at creation')
  })
})
