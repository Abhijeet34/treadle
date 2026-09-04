// SPDX-License-Identifier: Apache-2.0
// The `agent/1` rendering: a deterministic projection of one result object, specified so two
// implementations produce identical bytes. Line 1 is the envelope; every other line is a
// scalar, a marked scalar, a counted text block, a block opener, a column header or a row.
//
// Two invariants this file is the only home of, both from the threat model.
// F3: the one free-text column of a block renders last whatever order was asked for, so the
// row grammar's "only the last field may contain spaces" rule holds by construction, and a
// non-final cell carrying a space is refused rather than silently shifting every value
// after it. F2: a value that would end its own line never reaches a scalar or a cell.

import { shapeFor } from '../../application/shapes.ts'
import { isBlock, type Block, type ColumnSpec, type ResultObject, type Value } from '../../application/result.ts'
import type { Renderer, RenderOptions } from './index.ts'
import { RenderInvariant, guardCell, guardSingleLine, textBlock } from './grammar.ts'
import { displayWidth } from './width.ts'

const DEFAULT_FIELD_LIMIT = 64

function scalarText(value: Value): string {
  if (value === null) return '-'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** Non-text columns in the order asked for, then the one free-text column (F3). */
export function orderColumns(columns: readonly ColumnSpec[]): readonly ColumnSpec[] {
  const free = columns.filter((column) => column.text === true)
  if (free.length > 1) {
    throw new RenderInvariant(
      `a row may carry one free-text column and this one carries ${free.length} (${free.map((c) => c.name).join(', ')}); every field after the first space-bearing one would be read wrong`,
    )
  }
  return [...columns.filter((column) => column.text !== true), ...free]
}

function cutToCells(value: string, cells: number): string {
  let out = ''
  let width = 0
  for (const character of value) {
    const next = displayWidth(character)
    if (width + next > cells) return out
    out += character
    width += next
  }
  return out
}

function renderBlock(key: string, block: Block): readonly string[] {
  const columns = orderColumns(block.columns)
  const lines = [
    `~${key} ${block.shown} ${block.total}`,
    `#${columns.map((column) => (column.text === true ? `"${column.name}` : column.name)).join(' ')}`,
  ]
  for (const row of block.rows) {
    const cells = columns.map((column) => {
      const cell = row[column.name]
      return cell === null || cell === undefined || cell === '' ? '-' : String(cell)
    })
    cells.forEach((cell, index) => {
      const column = columns[index] as ColumnSpec
      if (index === cells.length - 1) guardSingleLine(column.name, cell)
      else guardCell(column.name, cell)
    })
    lines.push(cells.join(' '))
  }
  return lines
}

function renderText(
  key: string, value: string, limit: number | null, page: string | undefined,
): readonly string[] {
  if (value.length === 0) return []
  if (limit === null) {
    return value.includes('\n') ? [...textBlock(key, value)] : [`"${key} ${value}`]
  }
  const firstLine = value.split('\n')[0] as string
  const cut = cutToCells(firstLine, limit)
  const whole = cut === value
  if (whole) {
    guardSingleLine(key, cut)
    return [`"${key} ${cut}`]
  }
  guardSingleLine(key, cut)
  const lines = [`"${key} ${cut}`, `+${key} ${Buffer.byteLength(value, 'utf8')}B truncated-at ${limit}`]
  if (page !== undefined) lines.push(`page ${page} --field ${key}`)
  return lines
}

function envelope(result: ResultObject): string {
  if (!result.ok) return `err ${result.code} ${result.workspace}`
  if (result.effect === 'mutate') {
    return `ok ${result.command} ${result.workspace} ${result.txn ?? '-'} ${result.changed ?? 0}`
  }
  return `ok ${result.command} ${result.workspace}`
}

export const agentRenderer: Renderer = {
  name: 'agent',
  render(result: ResultObject, options: RenderOptions = {}): string {
    const shape = shapeFor(result.schema)
    if (shape === undefined) throw new RenderInvariant(`no shape is registered for ${result.schema}`)
    const limit = options.fieldLimit === undefined ? DEFAULT_FIELD_LIMIT : options.fieldLimit
    const quiet = options.quiet === true

    const lines: string[] = quiet ? [] : [envelope(result)]
    for (const property of shape.properties) {
      const value = result.data[property.key]
      if (value === undefined) continue
      if (property.kind === 'block') {
        if (!isBlock(value)) continue
        lines.push(...renderBlock(property.key, value))
        continue
      }
      if (quiet) continue
      if (property.kind === 'list') {
        for (const entry of value as readonly string[]) {
          guardSingleLine(property.key, entry)
          lines.push(`${property.key} ${entry}`)
        }
        continue
      }
      if (property.kind === 'text') {
        lines.push(...renderText(property.key, String(value), limit, options.page))
        continue
      }
      const text = scalarText(value)
      guardSingleLine(property.key, text)
      lines.push(`${property.key} ${text}`)
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`
  },
}
