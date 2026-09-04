// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F3.
//
// The row grammar splits on the first arity-1 spaces, so only the last field may contain
// spaces. The default column sets put `title` last, and appending a column after it moves
// every value from `title` onward into the wrong field, silently and with no error, which
// is worse than a refusal. Two controls, and the tests below hold both:
// the renderer places the one free-text column last whatever order it was asked for, and a
// column set naming two free-text columns is refused before it is rendered.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import type { ResultObject } from '../../src/application/result.ts'
import { backlog } from '../../src/application/services/items.ts'
import { agentRenderer, orderColumns } from '../../src/adapters/render/agent.ts'
import { RenderInvariant } from '../../src/adapters/render/grammar.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'

/** The row grammar exactly as a consumer would implement it from the contract. */
function parseRows(rendered: string): readonly Readonly<Record<string, string>>[] {
  const lines = rendered.trimEnd().split('\n')
  const header = lines.find((line) => line.startsWith('#'))
  assert.notEqual(header, undefined, 'a block with rows declares a header')
  const columns = (header as string).slice(1).split(' ').map((name) => name.replace(/^"/, ''))
  const start = lines.indexOf(header as string) + 1
  const rows: Record<string, string>[] = []
  for (const line of lines.slice(start)) {
    if (/^[a-z_]+ /.test(line) || line.startsWith('~') || line.startsWith('#')) break
    const row: Record<string, string> = {}
    let rest = line
    for (let i = 0; i < columns.length - 1; i += 1) {
      const at = rest.indexOf(' ')
      row[columns[i] as string] = rest.slice(0, at)
      rest = rest.slice(at + 1)
    }
    row[columns[columns.length - 1] as string] = rest
    rows.push(row)
  }
  return rows
}

describe('F3: a column appended after a space-bearing one cannot corrupt the split', () => {
  let demo: Demo

  before(async () => {
    demo = await aDemoWorkspace()
  })

  after(async () => {
    await demo.dispose()
  })

  it('refuses a column set naming two free-text columns, and names both', async () => {
    const result = await backlog(demo.store, {
      filters: [], limit: 9,
      columns: ['id', 'type', 'state', 'pts', 'title', 'assignee'],
    })
    assert.equal(result.ok, false, 'title and assignee both carry spaces')
    assert.equal(result.code, 'VALIDATION')
    const cause = String(result.data['cause'])
    assert.match(cause, /assignee/)
    assert.match(cause, /title/)
  })

  it('places the one free-text column last whatever order it was asked for', async () => {
    const result = await backlog(demo.store, {
      filters: [{ field: 'state', value: 'ready' }], limit: 9,
      columns: ['id', 'title', 'state', 'pts'],
    })
    assert.equal(result.ok, true)
    const rendered = agentRenderer.render(result as ResultObject)
    const header = rendered.split('\n').find((line) => line.startsWith('#')) as string
    assert.equal(header, '#id state pts "title', `the free-text column is not last: ${header}`)

    const rows = parseRows(rendered)
    assert.ok(rows.length >= 3, `only ${rows.length} rows to check`)
    for (const row of rows) {
      assert.match(row['id'] as string, /^[a-z0-9-]+$/, 'an id absorbed part of a title')
      assert.match(row['state'] as string, /^[a-z_]+$/)
      assert.match(row['pts'] as string, /^(\d+|-)$/)
      assert.ok((row['title'] as string).includes(' '), 'the title kept its spaces')
    }
  })

  it('fails loudly rather than emitting a row two free-text columns would corrupt', () => {
    assert.throws(
      () => orderColumns([{ name: 'id' }, { name: 'title', text: true }, { name: 'assignee', text: true }]),
      RenderInvariant,
    )
  })

  it('refuses a non-final cell that carries a space, whatever put it there', () => {
    assert.throws(() => agentRenderer.render({
      schema: 'backlog/1', ok: true, code: 'OK', command: 'backlog', workspace: 'w',
      effect: 'read', txn: null, changed: null,
      data: {
        items: {
          columns: [{ name: 'id' }, { name: 'state' }, { name: 'title', text: true }],
          shown: 1, total: 1,
          rows: [{ id: 'a b', state: 'ready', title: 'a title with spaces' }],
        },
      },
    }), RenderInvariant)
  })
})
