// SPDX-License-Identifier: Apache-2.0
// The human rendering: the same facts as `agent`, laid out for a person. Any fact present
// in one is present in the other; they differ in density, not in content.
//
// No colour is emitted at all. Which state gets which of the eight ANSI colours is a
// decision the interface specification deliberately left open, and the property that makes
// deferring it safe is that colour never carries meaning of its own: every signal is a
// glyph or a word first. Emitting none is that property at its limit.

import { shapeFor } from '../../application/shapes.ts'
import { isBlock, type ColumnSpec, type ResultObject, type Value } from '../../application/result.ts'
import type { Renderer, RenderOptions } from './index.ts'
import { displayWidth, splitToWidth, truncateToWidth } from './width.ts'

/**
 * Right-to-left content reorders the cells around it, so a correct table looks wrong. A
 * field carrying any strong right-to-left or Arabic-number character is emitted inside a
 * first-strong isolate, which confines the reordering to that field. Both isolate characters
 * are zero width, so the column arithmetic is unchanged.
 *
 * Only the human rendering does this. `agent` is parsed rather than displayed, and an
 * isolate spliced into a value there would be a byte the consumer did not store.
 */
const BIDI = /[\u0590-\u05ff\u0600-\u07bf\u0860-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]/u
const FIRST_STRONG_ISOLATE = '\u2068'
const POP_DIRECTIONAL_ISOLATE = '\u2069'

export function isolated(value: string): string {
  return BIDI.test(value) ? `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}` : value
}

const DEFAULT_WIDTH = 80
export const MIN_WIDTH = 40
export const MAX_WIDTH = 200

export function clampWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.trunc(width)))
}

function scalarText(value: Value): string {
  if (value === null) return '-'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

/** One aligned table, or two lines per row when the free-text column would fall under 16 cells. */
function table(
  columns: readonly ColumnSpec[], rows: readonly Readonly<Record<string, unknown>>[], width: number, ascii: boolean,
): readonly string[] {
  const free = columns.filter((column) => column.text === true)
  const fixed = columns.filter((column) => column.text !== true)
  const order = [...fixed, ...free]
  const cell = (row: Readonly<Record<string, unknown>>, column: ColumnSpec): string => {
    const value = row[column.name]
    return value === null || value === undefined || value === '' ? '-' : isolated(String(value))
  }
  // A loop, not a spread into `Math.max` or `push`: a block is bounded by the store and not
  // by the argument list, and `doctor` over 50,000 items overflowed the stack on both.
  const widths = order.map((column) =>
    rows.reduce((widest, row) => Math.max(widest, displayWidth(cell(row, column))), displayWidth(column.name)))

  const fixedWidth = fixed.reduce((sum, _, index) => sum + (widths[index] as number) + 2, 2)
  const freeBudget = width - fixedWidth
  const stacked = free.length > 0 && freeBudget < 16

  const pad = (text: string, cells: number): string => text + ' '.repeat(Math.max(0, cells - displayWidth(text)))
  const lines: string[] = []
  // A block with no rows names its count on the header line above, so a column header with
  // nothing under it is a stranded label; `agent` already drops its own `#` header the same
  // way for an empty block.
  if (rows.length === 0) return lines
  const headerColumns = stacked ? fixed : order
  const header = headerColumns.map((column) =>
    pad(column.name.toUpperCase(), widths[order.indexOf(column)] as number))
  lines.push(`  ${header.join('  ')}`.trimEnd())

  for (const row of rows) {
    const head = fixed.map((column, index) => pad(cell(row, column), widths[index] as number))
    if (stacked) {
      lines.push(`  ${head.join('  ')}`.trimEnd())
      for (const column of free) lines.push(`    ${cell(row, column)}`.trimEnd())
      continue
    }
    const tail = free.map((column) =>
      truncateToWidth(cell(row, column), Math.max(1, freeBudget - 2), ascii).trimEnd())
    lines.push(`  ${[...head, ...tail].join('  ')}`.trimEnd())
  }
  return lines
}

/**
 * The one global rule (B.4): no emitted line exceeds W display cells. A line that would is
 * broken at the last segment boundary that fits and continued with a two-space indent.
 * Applied once over everything the renderer composed, rather than at each site that builds
 * a line, because a rule applied per site is a rule with an exception waiting in it.
 *
 * A word longer than the room a continuation line has, a 200 character title with no space
 * in it or a long URL, is cut at that room before the wrap runs: the rule is about cells,
 * and a break at spaces alone held it only for text that happened to contain some.
 */
function fitLine(line: string, width: number): readonly string[] {
  if (displayWidth(line) <= width) return [line]
  const lead = line.length - line.trimStart().length
  const indent = ' '.repeat(lead + 2)
  const room = width - indent.length
  const out: string[] = []
  let current = ' '.repeat(lead)
  for (const word of line.trimStart().split(' ').flatMap((piece) => splitToWidth(piece, room))) {
    const candidate = current.trimEnd().length === 0 ? `${current}${word}` : `${current} ${word}`
    if (displayWidth(candidate) > width && current.trim().length > 0) {
      out.push(current)
      current = `${indent}${word}`
    } else {
      current = candidate
    }
  }
  out.push(current)
  return out
}

function wrap(text: string, width: number, indent: string): readonly string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (line.length > 0 && displayWidth(`${line} ${word}`) + indent.length > width) {
        out.push(`${indent}${line}`)
        line = word
      } else {
        line = line.length === 0 ? word : `${line} ${word}`
      }
    }
    out.push(`${indent}${line}`.trimEnd())
  }
  return out
}

function errorLines(result: ResultObject, width: number): readonly string[] {
  const cause = result.data['cause']
  const guard = result.data['guard']
  const entity = result.data['entity']
  const fixes = (result.data['fix'] as readonly string[] | undefined) ?? []
  const near = (result.data['near'] as readonly string[] | undefined) ?? []
  const lines: string[] = []
  for (const line of wrap(isolated(typeof cause === 'string' ? cause : result.code), width, '')) lines.push(line)
  lines.push('')
  if (guard !== undefined) lines.push(`  guard  ${String(guard)}`)
  if (entity !== undefined) lines.push(`  entity ${isolated(String(entity))}`)
  if (result.data['rule'] !== undefined) lines.push(`  rule   ${String(result.data['rule'])}`)
  if (near.length > 0) lines.push(`  near   ${near.map((value) => isolated(value)).join(', ')}`)
  if (fixes.length > 0) {
    lines.push('')
    lines.push('Do one of these')
    for (const fix of fixes) {
      lines.push('')
      lines.push(`  ${fix}`)
    }
  }
  return lines
}

export const humanRenderer: Renderer = {
  name: 'human',
  render(result: ResultObject, options: RenderOptions = {}): string {
    const shape = shapeFor(result.schema)
    if (shape === undefined) throw new Error(`no shape is registered for ${result.schema}`)
    const width = clampWidth(options.width)
    const ascii = options.ascii === true
    if (!result.ok) return `${fit(errorLines(result, width), width).join('\n')}\n`

    const quiet = options.quiet === true
    const lines: string[] = []
    if (!quiet) {
      // `version` and `help` answer without opening a workspace and carry `-` for one, which
      // the agent envelope needs as a positional field and a heading does not: `version  -`
      // reads as a heading whose value is missing rather than as one that has none.
      const head = [result.command, ...(result.workspace === '-' ? [] : [result.workspace])]
      if (result.effect === 'mutate') head.push(`${result.changed ?? 0} changed`, `txn ${result.txn ?? '-'}`)
      lines.push(head.join('  '))
    }

    /**
     * A block closes the group it is in: a scalar, list or text property that follows one
     * opens a new group and is preceded by a blank line. Rows and scalars share the two-space
     * indent, so without the break `findings 0` after the `states` table reads as a state
     * called findings, which is a value in a column it is not in. The blank line is the whole
     * rule, and it is the shape `explain` already had by ordering alone.
     */
    let afterBlock = false

    for (const property of shape.properties) {
      const value = result.data[property.key]
      if (value === undefined) continue
      if (property.kind === 'block') {
        if (!isBlock(value)) continue
        if (!quiet) {
          lines.push('')
          lines.push(`${property.key}  ${value.shown} of ${value.total}`)
        }
        for (const line of table(value.columns, value.rows, width, ascii)) lines.push(line)
        afterBlock = true
        continue
      }
      if (quiet) continue
      const open = (): void => {
        if (afterBlock) lines.push('')
        afterBlock = false
      }
      if (property.kind === 'list') {
        const entries = value as readonly string[]
        if (entries.length === 0) continue
        open()
        for (const entry of entries) lines.push(`  ${property.key}  ${entry}`)
        continue
      }
      if (property.kind === 'text') {
        const text = String(value)
        if (text.length === 0) continue
        open()
        lines.push(`  ${property.key}`)
        for (const line of wrap(isolated(text), width - 4, '    ')) lines.push(line)
        continue
      }
      const text = scalarText(value)
      if (text.length === 0) continue
      open()
      lines.push(`  ${property.key}  ${isolated(text)}`)
    }
    return `${fit(lines, width).join('\n')}\n`
  },
}

function fit(lines: readonly string[], width: number): readonly string[] {
  return lines.flatMap((line) => fitLine(line, width))
}
