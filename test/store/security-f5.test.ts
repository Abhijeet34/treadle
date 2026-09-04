// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F5, incomplete bidi rejection.
//
// The design rejected U+202A to U+202E and nothing else. The audit's probe listed seven
// characters that passed it, including U+2069 POP DIRECTIONAL ISOLATE, which closes the
// isolate wrapper the tool's own renderer opens and lets reordering escape back into the
// surrounding row. This suite is the whole class, not those seven: control, format,
// surrogate and separator, with the emoji joiner carved out where it is a joiner.
//
// Every character below is written as an escape on purpose: a literal one in a source file
// is invisible to a reviewer, which is the property that makes the class dangerous.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { findUnsafeCharacter, isSafeText } from '../../src/domain/index.ts'
import { parseRecordSource, renderRecord } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem } from '../helpers/store-fixtures.ts'

/** The design's own rule, as the audit implemented it, so the gap is visible in the table. */
const OLD_RULE = /[\u202A-\u202E]/

const REFUSED: readonly (readonly [string, string])[] = [
  ['\u200E', 'U+200E LEFT-TO-RIGHT MARK'],
  ['\u200F', 'U+200F RIGHT-TO-LEFT MARK'],
  ['\u061C', 'U+061C ARABIC LETTER MARK'],
  ['\u2066', 'U+2066 LEFT-TO-RIGHT ISOLATE'],
  ['\u2067', 'U+2067 RIGHT-TO-LEFT ISOLATE'],
  ['\u2068', 'U+2068 FIRST STRONG ISOLATE'],
  ['\u2069', 'U+2069 POP DIRECTIONAL ISOLATE'],
  ['\u200B', 'U+200B ZERO WIDTH SPACE'],
  ['\uFEFF', 'U+FEFF ZERO WIDTH NO-BREAK SPACE'],
  ['\u202A', 'U+202A LEFT-TO-RIGHT EMBEDDING'],
  ['\u202E', 'U+202E RIGHT-TO-LEFT OVERRIDE'],
  ['\u00AD', 'U+00AD'],
  ['\u2060', 'U+2060'],
  ['\u2028', 'U+2028 LINE SEPARATOR'],
  ['\u2029', 'U+2029 PARAGRAPH SEPARATOR'],
  ['\u{E0041}', 'U+E0041'],
  ['\u0007', 'U+0007'],
  ['\u0085', 'U+0085'],
]

describe('the class F5 asks for, not the five code points the design named', () => {
  for (const [character, label] of REFUSED) {
    it(`refuses ${label} in a single-line value`, () => {
      const found = findUnsafeCharacter(`before${character}after`, 'line')
      assert.ok(found, `${label} was accepted`)
      assert.equal(found.label, label)
      assert.equal(found.codePoint, character.codePointAt(0))
    })
  }

  it("names the characters the design's own rule let through", () => {
    const slipped = REFUSED.filter(([character]) => !OLD_RULE.test(character))
    assert.equal(slipped.length, 16, 'the old rule covered only U+202A to U+202E')
    for (const [character, label] of slipped) {
      assert.equal(isSafeText(character, 'line'), false, `${label} still passes`)
    }
  })

  it('refuses a tab and a newline in a single-line value and allows both in text', () => {
    assert.equal(isSafeText('a\tb', 'line'), false)
    assert.equal(isSafeText('a\nb', 'line'), false)
    assert.equal(isSafeText('a\tb\nc', 'text'), true)
    assert.equal(isSafeText('a\rb', 'text'), false)
  })

  it('keeps an emoji sequence whose joiner is a joiner', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    assert.equal(isSafeText(`a ${family} family`, 'line'), true)
    assert.equal(isSafeText('\u{1F44D}\u{1F680}', 'line'), true)
    assert.equal(isSafeText('lone\u200Djoiner', 'line'), false, 'U+200D is not free rein')
  })
})

describe('the class is enforced at the store boundary, in both directions', () => {
  it('refuses to write a title carrying a pop directional isolate', async () => {
    const workspace = await aWorkspace()
    try {
      const refused = await workspace.store.apply({
        txn: 't1',
        writes: [{ item: anItem({ title: 'Ship the\u2069 release' }) }],
        events: [],
      })
      assert.equal(refused.ok, false)
      assert.match(refused.ok ? '' : refused.error.message, /title must be a single line/)
    } finally {
      await workspace.dispose()
    }
  })

  it('quarantines a hand-edited record whose field carries one, naming the character', async () => {
    const workspace = await aWorkspace()
    try {
      await workspace.store.apply({ txn: 't1', writes: [{ item: anItem() }], events: [] })
      const shard = path.join(workspace.root, 'items/2026-09.md')
      const edited = (await readFile(shard, 'utf8')).replace('state: draft', 'state: dr\u202Eaft')
      await writeFile(shard, edited)

      const items = await workspace.store.list()
      assert.deepEqual(items.ok ? items.value.map((i) => i.id) : [], [])
      const findings = await workspace.store.findings()
      assert.ok(findings.ok)
      assert.equal(findings.value[0]?.rule, 'S2')
      assert.match(findings.value[0]?.reason ?? '', /U\+202E RIGHT-TO-LEFT OVERRIDE/)
    } finally {
      await workspace.dispose()
    }
  })

  it('refuses a section body carrying one', () => {
    const source = renderRecord({
      id: 'alpha-one', title: 'Alpha', fields: new Map([['state', 'draft']]),
      sections: [{ name: 'Description', body: 'a line\nand a\u2066 wrapped one' }],
    })
    const parsed = parseRecordSource(source, 1)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.rule, 'S2')
    assert.match(parsed.ok ? '' : parsed.reason, /U\+2066 LEFT-TO-RIGHT ISOLATE/)
  })
})
