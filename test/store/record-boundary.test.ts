// SPDX-License-Identifier: Apache-2.0
// The property ADR-0003 claims for the record format: damaging or renaming a record heading
// never silently changes which records exist. The reference implementation inferred an
// item's state from a section heading, and renaming that heading dropped every item under it
// while the command exited zero; this file is what makes the same failure impossible here.
//
// A heading is the record boundary, so damage to it moves the boundary. What must not happen
// is that the record above swallows the record below and nothing says so. Either the record
// still serves, or a finding names it. There is no third outcome.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { parseFile, renderFile, renderHeader, renderRecord } from '../../src/adapters/store/index.ts'
import { Gen, aWorkspace, anItem } from '../helpers/store-fixtures.ts'

const SHARD = 'items/2026-09.md'

/** The heading of the second record, and the shapes a hand edit turns it into. */
const HEADING = '# item-two: A second task'

const DAMAGE: readonly (readonly [string, string])[] = [
  ['demoted to an H2 heading', '## item-two: A second task'],
  ['demoted to an H3 heading', '### item-two: A second task'],
  ['the space after the hash removed', '#item-two: A second task'],
  ['the hash removed altogether', 'item-two: A second task'],
  ['the heading indented by one space', ' # item-two: A second task'],
  ['the hash doubled and the title reflowed', '##item-two:   A second task'],
]

async function twoRecords(): Promise<Awaited<ReturnType<typeof aWorkspace>>> {
  const workspace = await aWorkspace()
  const applied = await workspace.store.apply({
    txn: 't1',
    events: [],
    writes: [
      { item: anItem({ description: 'Prose that belongs to the first record.' }) },
      { item: anItem({ id: 'item-two', title: 'A second task', filed_at: '2026-09-02T10:00:00Z', description: 'Prose that belongs to the second record.' }) },
    ],
  })
  assert.ok(applied.ok, applied.ok ? '' : applied.error.message)
  return workspace
}

describe('a record heading a hand edit damaged', () => {
  for (const [label, damaged] of DAMAGE) {
    it(`is reported rather than absorbed: ${label}`, async () => {
      const workspace = await twoRecords()
      try {
        const shard = path.join(workspace.root, SHARD)
        const text = await readFile(shard, 'utf8')
        assert.ok(text.includes(HEADING), 'the fixture did not write the heading this case damages')
        // A function replacement, because a `$` sequence in a plain one is substitution syntax.
        await writeFile(shard, text.replace(HEADING, () => damaged))

        const listed = await workspace.store.list()
        assert.ok(listed.ok, listed.ok ? '' : listed.error.message)
        const ids = listed.value.map((item) => item.id)

        const findings = await workspace.store.findings()
        assert.ok(findings.ok, findings.ok ? '' : findings.error.message)
        const named = new Set(findings.value.flatMap((f) => (f.id === undefined ? [] : [f.id])))

        assert.ok(
          ids.includes('item-two') || named.has('item-two'),
          `item-two neither served nor named by a finding: served ${JSON.stringify(ids)}, findings ${JSON.stringify(findings.value)}`,
        )
        assert.ok(
          ids.includes('item-one'),
          `the record above the damage stopped serving: ${JSON.stringify(findings.value)}`,
        )
        const one = listed.value.find((item) => item.id === 'item-one')
        assert.equal(
          one?.description,
          'Prose that belongs to the first record.',
          'the record above the damage silently absorbed the record below',
        )
      } finally {
        await workspace.dispose()
      }
    })
  }
})

const DOCUMENTS = 200

/**
 * The property, over generated files rather than the six shapes above: for every record in a
 * file and every damage shape, the set of ids the file serves plus the set a finding names
 * still covers every id the undamaged file served.
 */
describe('damaging a heading never silently changes which records exist', () => {
  it(`holds over ${DOCUMENTS} generated documents`, () => {
    for (let seed = 1; seed <= DOCUMENTS; seed += 1) {
      const gen = new Gen(seed)
      const specs = []
      const used = new Set<string>()
      for (let i = 0; i < gen.int(2, 5); i += 1) {
        const item = gen.workItem({ description: gen.safeBody() })
        if (used.has(item.id)) continue
        used.add(item.id)
        specs.push({
          id: item.id,
          title: item.title,
          fields: new Map([
            ['type', item.type], ['state', item.state],
            ['filed_at', item.filed_at], ['version', String(item.version)],
          ]),
          sections: [{ name: 'Description', body: item.description as string }],
        })
      }
      if (specs.length < 2) continue
      const text = renderHeader(1) + specs.map(renderRecord).join('')
      const pristine = parseFile(text, SHARD)
      assert.ok(pristine.ok)
      const before = pristine.value.records.map((r) => r.id)

      for (const spec of specs) {
        const heading = `# ${spec.id}: ${spec.title}`
        for (const [label, shape] of [
          ['h2', `## ${spec.id}: ${spec.title}`],
          ['no space', `#${spec.id}: ${spec.title}`],
          ['no hash', `${spec.id}: ${spec.title}`],
        ] as const) {
          const parsed = parseFile(text.replace(heading, () => shape), SHARD)
          assert.ok(parsed.ok, `seed ${seed} ${label}: the file stopped serving entirely`)
          const served = new Set(parsed.value.records.map((r) => r.id))
          const named = new Set(parsed.value.quarantined.flatMap((q) => (q.id === undefined ? [] : [q.id])))
          for (const id of before) {
            assert.ok(
              served.has(id) || named.has(id),
              `seed ${seed} ${label}: ${id} vanished from ${SHARD} and no finding names it`,
            )
          }
        }
      }
    }
  })
})

describe('a section name that appears twice in one record', () => {
  it('is a named refusal rather than a silent last-one-wins', () => {
    const text = [
      'schema: 1',
      '',
      '# item-one: A first task',
      '',
      'type: task',
      'state: draft',
      'filed_at: 2026-09-01T10:00:00Z',
      'version: 1',
      '',
      '## Description',
      '',
      'The description a reviewer approved.',
      '',
      '## Description',
      '',
      'A second description a merge left behind.',
      '',
    ].join('\n')
    const parsed = parseFile(text, SHARD)
    assert.ok(parsed.ok)
    assert.equal(parsed.value.records.length, 0, 'a record with two Description sections was served')
    assert.equal(parsed.value.quarantined.length, 1)
    assert.equal(parsed.value.quarantined[0]?.id, 'item-one')
    assert.match(parsed.value.quarantined[0]?.reason ?? '', /Description/)
  })

  it('keeps the file byte-exact through parse and render', () => {
    const text = `schema: 1\n\n# item-one: A first task\n\ntype: task\n\n## Notes\n\na\n\n## Notes\n\nb\n`
    const parsed = parseFile(text, SHARD)
    assert.ok(parsed.ok)
    assert.equal(renderFile(parsed.value), text)
  })
})
