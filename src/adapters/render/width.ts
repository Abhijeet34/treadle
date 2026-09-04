// SPDX-License-Identifier: Apache-2.0
// Display width for the human rendering (interface B.4). Codepoint count is not width: a
// CJK title counts two cells per character and a combining mark counts none, and a column
// laid out on the wrong number shifts every column after it.
//
// The ranges below are the East Asian Wide and Fullwidth blocks of UAX #11 plus the
// combining marks; `Intl.Segmenter` supplies the grapheme clusters, so a ZWJ sequence is
// measured as one cluster rather than as the sum of its parts.

/** East Asian Wide (W) and Fullwidth (F), as inclusive codepoint ranges. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x17000, 0x18aff], [0x1b000, 0x1b12f], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

/** Combining marks and format controls that occupy no cell of their own. */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a], [0x0eb1, 0x0eb1], [0x0eb4, 0x0eb9], [0x200b, 0x200f],
  [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff], [0xe0100, 0xe01ef],
]

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid] as readonly [number, number]
    if (code < range[0]) high = mid - 1
    else if (code > range[1]) low = mid + 1
    else return true
  }
  return false
}

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Cells one grapheme cluster occupies. A cluster is wide if any codepoint in it is wide. */
function clusterWidth(cluster: string): number {
  let width = 0
  let wide = false
  for (const character of cluster) {
    const code = character.codePointAt(0) as number
    if (inRanges(code, ZERO)) continue
    if (inRanges(code, WIDE)) wide = true
    width += 1
  }
  if (width === 0) return 0
  return wide ? 2 : 1
}

export function displayWidth(value: string): number {
  let total = 0
  for (const { segment } of SEGMENTER.segment(value)) total += clusterWidth(segment)
  return total
}

/**
 * The longest prefix of whole clusters that fits, then an ellipsis, padded to exactly
 * `cells`. The pad matters: cutting before a wide character leaves an odd cell, and without
 * it the column after this one shifts by one.
 */
export function truncateToWidth(value: string, cells: number, ascii = false): string {
  if (displayWidth(value) <= cells) return value + ' '.repeat(cells - displayWidth(value))
  const mark = ascii ? '...' : '…'
  const budget = cells - displayWidth(mark)
  let out = ''
  let width = 0
  for (const { segment } of SEGMENTER.segment(value)) {
    const next = clusterWidth(segment)
    if (width + next > budget) break
    out += segment
    width += next
  }
  return `${out}${mark}${' '.repeat(cells - width - displayWidth(mark))}`
}
