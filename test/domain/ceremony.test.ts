// SPDX-License-Identifier: Apache-2.0
// The retrospective's field dictionary, and the round trip through the record grammar.
//
// The dictionary is what stops a record reaching a file in a shape no read would serve, so
// each rule below is tested from the refusing side: a valid record with one field spoiled.
// The round trip is the other half, and it is where the two prose sections and the action
// list have to survive bytes rather than a structural clone.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateCeremony, type Ceremony } from '../../src/domain/index.ts'
import { decodeCeremony, encodeCeremony } from '../../src/adapters/store/index.ts'
import { parseRecordSource, renderRecord } from '../../src/adapters/store/grammar.ts'

const RETRO: Ceremony = {
  id: 'retro-sprint-31', title: 'Retro sprint-31', state: 'recorded',
  filed_at: '2026-09-18T16:00:00Z', version: 1, sprint_id: 'sprint-31',
  actions: ['split-carried', 'raise-flake-bug'],
  well: 'The token refresh shipped without a hotfix.',
  badly: 'Two stories carried for the third sprint running.\n\nThe second one is the same story as last time.',
}

/** Every way one field of a valid retrospective can be wrong, with the sentence it earns. */
const SPOILED: readonly (readonly [string, Partial<Ceremony>, RegExp])[] = [
  ['an id that is not a slug', { id: 'Retro Sprint 31' }, /id must be a slug of 3 to 64/],
  ['an empty title', { title: '' }, /title must be a single line/],
  ['a state the record kind has not got', { state: 'held' as Ceremony['state'] }, /state must be one of recorded/],
  ['a filed_at that is not an instant', { filed_at: '2026-09-18' }, /filed_at must be an RFC 3339 instant/],
  ['a version below one', { version: 0 }, /version must be a whole number of 1 or more/],
  ['a sprint_id that is not a slug', { sprint_id: 'Sprint 31' }, /sprint_id must be a sprint id/],
  ['an empty action list', { actions: [] }, /actions is empty; a retrospective that produced no action carries no actions field/],
  ['an action that is not an id', { actions: ['not an id'] }, /actions must be a list of item ids/],
  ['one action named twice', { actions: ['split-carried', 'split-carried'] }, /actions names an item twice/],
  ['an action list naming the record itself', { actions: ['retro-sprint-31'] }, /actions names retro-sprint-31, which is this record/],
  ['more actions than the cap', { actions: Array.from({ length: 51 }, (_, i) => `chore-${String(i).padStart(3, '0')}`) }, /actions names 51 items and the limit is 50/],
  ['prose over the length bound', { well: 'x'.repeat(10_001) }, /well is 10001 characters and the limit is 10000, which is 1 over/],
  // A bell, written as an escape: no invisible codepoint is a literal anywhere in this
  // repository, which test/architecture/invisible.test.ts enforces.
  ['prose carrying a control character', { badly: `first${String.fromCharCode(7)}second` }, /badly must be 1 to 10000 characters and may carry newlines/],
]

describe('the retrospective dictionary refuses what no read would serve', () => {
  it('accepts the whole record', () => {
    const valid = validateCeremony(RETRO)
    assert.equal(valid.ok, true, valid.ok ? '' : valid.error.message)
  })

  for (const [what, spoiled, message] of SPOILED) {
    it(`refuses ${what}`, () => {
      const result = validateCeremony({ ...RETRO, ...spoiled })
      assert.equal(result.ok, false, `${what} was accepted`)
      if (result.ok) return
      assert.equal(result.error.code, 'VALIDATION')
      assert.match(result.error.message, message)
    })
  }
})

describe('a retrospective survives the record grammar in both directions', () => {
  it('encodes, renders, parses and decodes back to the same record', () => {
    const encoded = encodeCeremony(RETRO)
    assert.ok(encoded.ok, encoded.ok ? '' : encoded.error.message)
    const parsed = parseRecordSource(renderRecord(encoded.value), 1)
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason)
    const decoded = decodeCeremony(parsed.record)
    assert.ok(decoded.ok, decoded.ok ? '' : decoded.error.message)
    assert.deepEqual(decoded.value, RETRO)
  })

  it('refuses prose whose line would read as a record heading', () => {
    // A body line starting with `#` at column 0 is a heading to the parser, so a record
    // carrying one would not be served back. The store's write path re-parses what it is
    // about to write for the same reason; this is the refusal one layer earlier.
    const refused = encodeCeremony({ ...RETRO, well: 'it went well\n# retro-sprint-99: a forged heading' })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok ? '' : refused.error.rule, 'S1')
    assert.match(refused.ok ? '' : refused.error.message, /may not start with # at column 0/)
  })

  it('reads a field line spelling a section name as an unknown key, and keeps it', () => {
    // `well` and `badly` are sections, so a newer writer's field line of the same name is
    // not one of ours: it is preserved verbatim rather than read as the section.
    const source = [
      '# retro-sprint-31: Retro sprint-31', '', 'type: retro', 'state: recorded',
      'filed_at: 2026-09-18T16:00:00Z', 'version: 1', 'well: a later version writes this as a field', '',
    ].join('\n')
    const parsed = parseRecordSource(source, 1)
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason)
    const decoded = decodeCeremony(parsed.record)
    assert.ok(decoded.ok, decoded.ok ? '' : decoded.error.message)
    assert.equal(decoded.value.well, undefined)
    assert.equal(decoded.value.extra?.get('well'), 'a later version writes this as a field')
  })

  it('refuses a record with no type line, and one whose type is another kind', () => {
    for (const [line, message] of [
      ['', /a ceremony record carries type: retro/],
      ['type: sprint\n', /a record in the ceremonies layout is type retro, not "sprint"/],
    ] as const) {
      const source = [
        '# retro-sprint-31: Retro sprint-31', '', `${line}state: recorded`,
        'filed_at: 2026-09-18T16:00:00Z', 'version: 1', '',
      ].join('\n')
      const parsed = parseRecordSource(source, 1)
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason)
      const decoded = decodeCeremony(parsed.record)
      assert.equal(decoded.ok, false)
      assert.equal(decoded.ok ? '' : decoded.error.rule, 'S1')
      assert.match(decoded.ok ? '' : decoded.error.message, message)
    }
  })
})
