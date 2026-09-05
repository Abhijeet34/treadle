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

import type { ResultObject } from '../../src/application/result.ts'
import { shapeFor } from '../../src/application/shapes.ts'
import { humanRenderer } from '../../src/adapters/render/human.ts'
import { goldenResults } from '../helpers/cli-fixtures.ts'

/** 60 drops a free-text column, 80 is the default off a pipe, 200 is the clamp's ceiling. */
const WIDTHS = [60, 80, 200] as const

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
