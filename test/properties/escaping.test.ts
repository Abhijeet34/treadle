// SPDX-License-Identifier: Apache-2.0
// Escaping totality, over generated input rather than a list of cases. This is finding F2's
// class, the highest-severity item in the audit, so it gets the strongest form of proof
// available: an independent reader of the `agent/1` contract, driven by the declared shape
// rather than by the renderer, decodes every stream the renderer produced and has to find
// exactly the values that went in and not one line more.
//
// The property has two legal outcomes and no third. Either the grammar refuses the value
// with a `RenderInvariant` naming the key, or the stream decodes to exactly the tool's own
// speech plus the values it was given. A forged envelope, a forged scalar, a row that
// splits into the wrong number of fields or a block that ends early is a failure, and the
// reader below is written to notice each of them by construction rather than by pattern.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { RenderInvariant } from '../../src/adapters/render/grammar.ts'
import { SHAPES } from '../../src/application/shapes.ts'
import type {
  Block, ColumnSpec, PropertySpec, ResultData, ResultObject, ResultShape, Row, Value,
} from '../../src/application/result.ts'
import { Adversary, missingCategories } from './adversary.ts'

const CASES_PER_SHAPE = 220

/** The contract's own ordering rule (F3): the one free-text column renders last. */
function ordered(columns: readonly ColumnSpec[]): readonly ColumnSpec[] {
  return [...columns.filter((c) => c.text !== true), ...columns.filter((c) => c.text === true)]
}

/** The row grammar: split on the first arity-1 spaces, so the last field keeps its spaces. */
function splitRow(line: string, arity: number): readonly string[] {
  const parts: string[] = []
  let rest = line
  for (let i = 0; i < arity - 1; i += 1) {
    const at = rest.indexOf(' ')
    if (at < 0) return [...parts, rest]
    parts.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  return [...parts, rest]
}

function cellText(cell: unknown): string {
  return cell === null || cell === undefined || cell === '' ? '-' : String(cell)
}

class Reader {
  readonly #lines: readonly string[]
  #at = 0

  constructor(rendered: string) {
    assert.equal(rendered.endsWith('\n'), true, 'a stream must end with a newline')
    this.#lines = rendered.slice(0, -1).split('\n')
  }

  get remaining(): readonly string[] {
    return this.#lines.slice(this.#at)
  }

  take(what: string): string {
    assert.ok(this.#at < this.#lines.length, `the stream ended before ${what}`)
    return this.#lines[this.#at++] as string
  }

  /** Line 1 is the only envelope the stream may carry, and no later line may look like one. */
  envelope(result: ResultObject): void {
    const first = this.take('the envelope')
    assert.match(first, result.ok ? /^ok / : /^err /, 'line 1 is not an envelope')
    for (const line of this.#lines.slice(1)) {
      assert.equal(/^(ok|err) /.test(line), false, `a second envelope was forged: ${JSON.stringify(line)}`)
    }
  }

  scalar(key: string, expected: string): void {
    assert.equal(this.take(`scalar ${key}`), `${key} ${expected}`)
  }

  list(key: string, entries: readonly string[]): void {
    for (const entry of entries) assert.equal(this.take(`list ${key}`), `${key} ${entry}`)
  }

  /** A text field arrives whole as a marked scalar or as a counted block, never as loose lines. */
  text(key: string, expected: string): void {
    if (expected.length === 0) return
    if (!expected.includes('\n')) {
      assert.equal(this.take(`text ${key}`), `"${key} ${expected}`)
      return
    }
    const opener = this.take(`the block header for ${key}`)
    const match = /^\|(\S+) (\d+) (\d+)$/.exec(opener)
    assert.ok(match !== null, `${key} did not open a counted block: ${JSON.stringify(opener)}`)
    assert.equal(match[1], key)
    const count = Number(match[2])
    const body: string[] = []
    for (let i = 0; i < count; i += 1) {
      const line = this.take(`content line ${i + 1} of ${key}`)
      assert.ok(line === '"' || line.startsWith('" '), `a content line is not marked: ${JSON.stringify(line)}`)
      body.push(line === '"' ? '' : line.slice(2))
    }
    const value = body.join('\n')
    assert.equal(value, expected, `${key} did not come back verbatim`)
    assert.equal(Number(match[3]), Buffer.byteLength(expected, 'utf8'), `${key}'s byte count is wrong`)
  }

  block(key: string, block: Block): void {
    const columns = ordered(block.columns)
    assert.equal(this.take(`block ${key}`), `~${key} ${block.shown} ${block.total}`)
    if (block.rows.length === 0) return
    const header = this.take(`the header of ${key}`)
    assert.equal(
      header,
      `#${columns.map((c) => (c.text === true ? `"${c.name}` : c.name)).join(' ')}`,
      `the header of ${key} does not declare the columns it rendered`,
    )
    for (const row of block.rows) {
      const line = this.take(`a row of ${key}`)
      const cells = splitRow(line, columns.length)
      assert.equal(cells.length, columns.length, `a row of ${key} split into ${cells.length} fields`)
      assert.deepEqual(cells, columns.map((c) => cellText(row[c.name])), `a row of ${key} came back changed`)
    }
  }
}

/**
 * Fills every property a shape declares, so no slot goes unattacked. `legal` draws only
 * from the categories the safe-text class permits: a case where every slot is refused
 * proves the guard and nothing about the reader, so half of them have to get through.
 */
function dataFor(shape: ResultShape, adversary: Adversary, legal: boolean): ResultData {
  const data: Record<string, Value> = {}
  const gen = adversary.gen
  const scalar = (): string => (legal ? adversary.token() : adversary.value())
  for (const property of shape.properties) {
    if (property.kind === 'scalar') data[property.key] = scalar()
    else if (property.kind === 'list') {
      data[property.key] = Array.from({ length: gen.int(1, 3) }, scalar)
    } else if (property.kind === 'text') {
      // Half the legal text fields are multi-line, because the counted block is the whole
      // of F2's fix and a single-line generator would never reach it.
      data[property.key] = legal
        ? (gen.chance(0.5) ? adversary.survivable() : `${adversary.survivable()}\n${adversary.survivable()}`)
        : adversary.value()
    } else data[property.key] = blockFor(property, adversary, legal)
  }
  return data
}

function blockFor(
  property: Extract<PropertySpec, { kind: 'block' }>, adversary: Adversary, legal: boolean,
): Block {
  const rows: Row[] = []
  const columns = ordered(property.columns)
  for (let i = 0; i < adversary.gen.int(0, 3); i += 1) {
    const row: Record<string, string> = {}
    columns.forEach((column, index) => {
      const last = index === columns.length - 1
      row[column.name] = legal
        ? (last ? adversary.survivable() : adversary.token())
        : adversary.value()
    })
    rows.push(row)
  }
  return { columns: property.columns, shown: rows.length, total: rows.length, rows }
}

function verify(shape: ResultShape, result: ResultObject, reader: Reader): void {
  reader.envelope(result)
  for (const property of shape.properties) {
    const value = result.data[property.key]
    if (value === undefined) continue
    if (property.kind === 'block') reader.block(property.key, value as Block)
    else if (property.kind === 'list') reader.list(property.key, value as readonly string[])
    else if (property.kind === 'text') reader.text(property.key, String(value))
    else reader.scalar(property.key, String(value))
  }
  assert.deepEqual(reader.remaining, [], 'the stream carried lines the shape never declared')
}

describe('the agent rendering escapes totally, or refuses and names the key', () => {
  it(`holds over ${CASES_PER_SHAPE} adversarial cases for each of ${SHAPES.length} shapes`, (t) => {
    const covered = new Set<string>()
    let refused = 0
    let rendered = 0
    let cases = 0

    for (const shape of SHAPES) {
      for (let seed = 1; seed <= CASES_PER_SHAPE; seed += 1) {
        cases += 1
        const adversary = new Adversary(seed * 31 + shape.command.length * 7919)
        const legal = seed % 2 === 0
        const result: ResultObject = {
          schema: `${shape.command}/${shape.version}`,
          ok: shape.command !== 'error',
          code: shape.command === 'error' ? 'VALIDATION' : 'OK',
          command: shape.command,
          workspace: 'w',
          effect: shape.effect,
          txn: shape.effect === 'mutate' ? 'txn-1' : null,
          changed: shape.effect === 'mutate' ? 1 : null,
          data: dataFor(shape, adversary, legal),
        }
        for (const category of adversary.categoriesCovered) covered.add(category)

        let stream: string
        try {
          stream = agentRenderer.render(result, { fieldLimit: null })
        } catch (error) {
          assert.ok(error instanceof RenderInvariant, `${shape.command}/${seed} threw ${String(error)}`)
          assert.ok(error.message.length > 0, 'a refusal with no message')
          refused += 1
          continue
        }
        rendered += 1
        verify(shape, result, new Reader(stream))
      }
    }

    assert.deepEqual(missingCategories([...covered] as never), [], 'a hostile category went unused')
    assert.ok(refused > 0, 'nothing was refused, so the guard never ran')
    assert.ok(rendered > 0, 'nothing rendered, so the reader never ran')
    t.diagnostic(`${cases} cases over ${SHAPES.length} shapes: ${rendered} decoded exactly, ${refused} refused by the grammar`)
    t.diagnostic('injection escapes: 0')
  })
})

describe('the same property holds when free text is cut to a field limit', () => {
  it(`holds over ${CASES_PER_SHAPE} cases at the default 64-cell limit`, (t) => {
    let checked = 0
    for (const shape of SHAPES) {
      for (let seed = 1; seed <= CASES_PER_SHAPE; seed += 1) {
        const adversary = new Adversary(seed * 17 + shape.command.length * 104_729)
        const result: ResultObject = {
          schema: `${shape.command}/${shape.version}`,
          ok: true, code: 'OK', command: shape.command, workspace: 'w', effect: 'read',
          txn: null, changed: null, data: dataFor(shape, adversary, seed % 2 === 0),
        }
        let stream: string
        try {
          stream = agentRenderer.render(result)
        } catch (error) {
          assert.ok(error instanceof RenderInvariant)
          continue
        }
        checked += 1
        const lines = stream.slice(0, -1).split('\n')
        // A cut value is an excerpt, so it is not compared back; what must still hold is
        // that the cut never manufactures a line the tool did not compose.
        for (const line of lines.slice(1)) {
          assert.equal(/^(ok|err) /.test(line), false, `a truncation forged an envelope: ${JSON.stringify(line)}`)
        }
      }
    }
    assert.ok(checked > 0)
    t.diagnostic(`${checked} truncated streams carried no forged envelope`)
  })
})
