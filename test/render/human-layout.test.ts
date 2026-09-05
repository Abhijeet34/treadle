// SPDX-License-Identifier: Apache-2.0
// The human rendering's group rule, held two ways.
//
// The invariant below is the rule itself: a block closes its group, so no scalar, list or
// text property ever sits inside a table's group. The snapshot beside it pins the bytes at
// the three widths the interface names, because a rule stated over structure still admits
// two spellings of the same layout and the next change should have to look at the one it
// picked.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before } from 'node:test'

import type { Block, ResultObject } from '../../src/application/result.ts'
import { shapeFor } from '../../src/application/shapes.ts'
import { MAX_WIDTH, MIN_WIDTH, humanRenderer } from '../../src/adapters/render/human.ts'
import { displayWidth } from '../../src/adapters/render/width.ts'
import { goldenResults } from '../helpers/cli-fixtures.ts'

/** 60 drops a free-text column, 80 is the default off a pipe, 200 is the clamp's ceiling. */
const WIDTHS = [60, 80, 200] as const

/** The clamp's floor and ceiling, the two the snapshot skips, and the width that first broke. */
const EVERY_WIDTH = [MIN_WIDTH, 60, 80, 100, MAX_WIDTH] as const

/** The field dictionary's title ceiling, with no space for a wrap to break at. */
const UNBREAKABLE = 'x'.repeat(200)

/**
 * The golden objects plus two that carry an unbreakable title: a list whose stacked
 * continuation line was emitted whole at 60 cells, and a record whose title scalar is one
 * word. Titles in the demo workspace all have spaces, which is why the snapshot never saw it.
 */
function withUnbreakableTitles(golden: ReadonlyMap<string, ResultObject>): ReadonlyMap<string, ResultObject> {
  const out = new Map(golden)
  const list = golden.get('backlog') as ResultObject
  const items = list.data['items'] as Block
  out.set('backlog-unbreakable', {
    ...list,
    data: { ...list.data, items: { ...items, rows: items.rows.map((row) => ({ ...row, title: UNBREAKABLE })) } },
  })
  const record = golden.get('show') as ResultObject
  out.set('show-unbreakable', { ...record, data: { ...record.data, title: UNBREAKABLE, desc: `${UNBREAKABLE} ${UNBREAKABLE}` } })
  return out
}

describe('no emitted line exceeds the width (B.4)', () => {
  let cases: ReadonlyMap<string, ResultObject>

  before(async () => {
    cases = withUnbreakableTitles(await goldenResults())
  })

  it('holds at every width from the floor to the ceiling, for a title with no space in it too', () => {
    for (const [name, result] of cases) {
      for (const width of EVERY_WIDTH) {
        const lines = humanRenderer.render(result, { width }).trimEnd().split('\n')
        const longest = Math.max(...lines.map(displayWidth))
        assert.ok(longest <= width, `${name} at ${width}: the longest line is ${longest} cells`)
      }
    }
  })

  // At the floor the fixed columns leave the title under 16 cells, so it stacks on its own
  // line and is broken rather than truncated; joining the continuation lines gives it back.
  it('loses no character of the title when it breaks it', () => {
    const result = cases.get('backlog-unbreakable') as ResultObject
    const rendered = humanRenderer.render(result, { width: MIN_WIDTH }).replaceAll(/\n\s+/g, '')
    assert.ok(rendered.includes(UNBREAKABLE), 'the broken title does not reassemble')
  })
})

const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'human.snapshot.txt')

/** A group opened by a block header: `<key>  <shown> of <total>` at column 0. */
function blockGroups(rendered: string): readonly (readonly string[])[] {
  const groups: string[][] = []
  let current: string[] | undefined
  for (const line of rendered.trimEnd().split('\n')) {
    if (line.length === 0) { current = undefined; continue }
    if (/^\S.* \d+ of \d+$/.test(line)) { current = [line]; groups.push(current); continue }
    if (current !== undefined) current.push(line)
  }
  return groups
}

describe('a scalar that follows a table is not part of it', () => {
  let golden: ReadonlyMap<string, ResultObject>

  before(async () => {
    golden = await goldenResults()
  })

  it('never renders a non-block property inside a block group', () => {
    let checked = 0
    for (const [name, result] of golden) {
      const shape = shapeFor(result.schema)
      assert.ok(shape !== undefined, `no shape for ${result.schema}`)
      const keys = shape.properties.filter((property) => property.kind !== 'block').map((property) => property.key)
      for (const width of WIDTHS) {
        for (const group of blockGroups(humanRenderer.render(result, { width }))) {
          checked += 1
          for (const line of group.slice(1)) {
            for (const key of keys) {
              assert.equal(line === `  ${key}` || line.startsWith(`  ${key}  `), false,
                `${name} at ${width}: "${line.trim()}" is a ${key} scalar sitting in the "${group[0]}" table`)
            }
          }
        }
      }
    }
    assert.ok(checked > 0, 'no block group was rendered at all')
  })

  it('opens every group after a block with one blank line, and never two', () => {
    for (const [name, result] of golden) {
      for (const width of WIDTHS) {
        const lines = humanRenderer.render(result, { width }).trimEnd().split('\n')
        for (const [index, line] of lines.entries()) {
          if (line.length > 0) continue
          assert.notEqual(lines[index + 1], '', `${name} at ${width}: two blank lines at ${index}`)
        }
      }
    }
  })

  // TREADLE_SNAPSHOT=update rewrites the file; the diff is then the thing under review.
  it('renders every golden object at 60, 80 and 200 as the snapshot records', () => {
    const parts: string[] = []
    for (const [name, result] of golden) {
      for (const width of WIDTHS) {
        parts.push(`### ${name} @ ${width}`, humanRenderer.render(result, { width }).trimEnd(), '')
      }
    }
    // The demo workspace lives under a fresh temporary directory, so `status` prints a path
    // that is different every run. It is the one value in the artefact that is not the
    // renderer's own output, and pinning it would pin the machine that recorded it.
    const rendered = `${parts.join('\n')}\n`.replaceAll(/\S*treadle-cli-\S+/g, '<store>')
    if (process.env['TREADLE_SNAPSHOT'] === 'update') {
      writeFileSync(SNAPSHOT, rendered)
      return
    }
    const want = readFileSync(SNAPSHOT, 'utf8').split('\n')
    const got = rendered.split('\n')
    for (const [index, line] of got.entries()) {
      assert.equal(line, want[index],
        `line ${index + 1} of the snapshot moved; review it and rerun with TREADLE_SNAPSHOT=update`)
    }
    assert.equal(got.length, want.length, 'the snapshot has a different number of lines')
  })
})
