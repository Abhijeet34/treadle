// SPDX-License-Identifier: Apache-2.0
// A text scalar sits on its own line when the line has room for it.
//
// The rendering had one shape for every text-marked scalar: the key on one line and the value
// indented under it, at every width from the 40-cell floor to the 200-cell ceiling. `treadle
// show` printed `assignee` and then `kim`, `reviewer` and then `bob`, while `item`, `type`,
// `state`, `filed` and `v` sat inline beside their keys - so a record was laid out two ways at
// once, and the two-line shape was the one a reader met first. No prior report examined this
// surface as a product; it is what a person sees before anything else the tool does.
//
// The rule is the narrow one: inline when the composed line fits the width, the indented block
// when it does not. Held here across the widths the defect spanned, because a shape that is
// wrong at every width is not a wrapping bug and cannot be proved at one of them.

import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'

import type { ResultObject } from '../../src/application/result.ts'
import { MAX_WIDTH, MIN_WIDTH, humanRenderer } from '../../src/adapters/render/human.ts'
import { displayWidth } from '../../src/adapters/render/width.ts'
import { goldenResults } from '../helpers/cli-fixtures.ts'

/** The floor, the default off a pipe, and the ceiling. */
const WIDTHS = [MIN_WIDTH, 80, MAX_WIDTH] as const

/**
 * The inline form is two spaces, the key, two spaces and the value, so a value of
 * `width - key.length - 4` cells is the longest one that fits. `desc` is four characters, so
 * 72 characters sits exactly on an 80-cell line and 73 is one cell over it.
 */
const KEY = 'desc'
const exactly = (width: number): string => 'x'.repeat(width - KEY.length - 4)

function lines(result: ResultObject, width: number): readonly string[] {
  return humanRenderer.render(result, { width }).trimEnd().split('\n')
}

/** The `show` golden object with one text property rewritten, and every other one dropped. */
function withDesc(golden: ReadonlyMap<string, ResultObject>, desc: string): ResultObject {
  const show = golden.get('show') as ResultObject
  const data = { ...show.data, desc }
  delete (data as Record<string, unknown>)['assignee']
  delete (data as Record<string, unknown>)['title']
  return { ...show, data }
}

describe('a text scalar is inline where it fits and a block where it does not', () => {
  let golden: ReadonlyMap<string, ResultObject>
  before(async () => { golden = await goldenResults() })

  it('writes a short value beside its key at every width, which is what it never did', () => {
    const show = golden.get('show') as ResultObject
    for (const width of WIDTHS) {
      const rendered = lines(show, width)
      assert.ok(rendered.includes('  assignee  dana'),
        `at ${width}: assignee is not on its key's line\n${rendered.join('\n')}`)
      assert.equal(rendered.includes('  assignee'), false,
        `at ${width}: assignee is still a label with nothing on its line`)
    }
  })

  it('keeps the indented block for a value the line has no room for, at the narrowest width', () => {
    const rendered = lines(withDesc(golden, exactly(MIN_WIDTH + 1)), MIN_WIDTH)
    assert.ok(rendered.includes(`  ${KEY}`), `the label line is gone\n${rendered.join('\n')}`)
    assert.equal(rendered.some((line) => line.startsWith(`  ${KEY}  `)), false,
      'a value one cell over the width was written inline')
  })

  it('keeps it for a long value at the widest width too, where the rule is not about wrapping', () => {
    const rendered = lines(withDesc(golden, exactly(MAX_WIDTH + 1)), MAX_WIDTH)
    assert.ok(rendered.includes(`  ${KEY}`), `the label line is gone\n${rendered.join('\n')}`)
    assert.equal(rendered.some((line) => line.startsWith(`  ${KEY}  `)), false,
      'a value one cell over the ceiling was written inline')
  })

  it('turns on the exact cell, in both directions, at three widths', () => {
    for (const width of WIDTHS) {
      const fits = lines(withDesc(golden, exactly(width)), width)
      const inline = fits.find((line) => line.startsWith(`  ${KEY}  `))
      assert.ok(inline !== undefined, `at ${width}: a value of exactly ${width} cells was not written inline`)
      assert.equal(displayWidth(inline), width, `at ${width}: the inline line measures ${displayWidth(inline)}`)

      const over = lines(withDesc(golden, exactly(width + 1)), width)
      assert.ok(over.includes(`  ${KEY}`), `at ${width}: one cell over was not written as a block`)
    }
  })

  it('leaves a value carrying a newline a block whatever it measures', () => {
    // The rendering is line-oriented and the wrap below the inline form is what turns a
    // paragraph into lines, so a short two-line value must not become one line with a
    // delimiter in it.
    for (const width of WIDTHS) {
      const rendered = lines(withDesc(golden, 'first\nsecond'), width)
      assert.ok(rendered.includes(`  ${KEY}`), `at ${width}: a multi-line value was written inline`)
      assert.ok(rendered.includes('    first') && rendered.includes('    second'),
        `at ${width}: the two lines of the value are not both under the label`)
      for (const line of rendered) {
        assert.equal(line.includes('\n'), false, `at ${width}: a rendered line carries a delimiter`)
      }
    }
  })

  it('holds B.4 over every golden object at every width, inline or not', () => {
    for (const [name, result] of golden) {
      for (const width of [MIN_WIDTH, 60, 80, 100, MAX_WIDTH]) {
        for (const line of lines(result, width)) {
          assert.ok(displayWidth(line) <= width,
            `${name} at ${width}: "${line}" is ${displayWidth(line)} cells`)
        }
      }
    }
  })
})
