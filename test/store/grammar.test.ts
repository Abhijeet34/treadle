// SPDX-License-Identifier: Apache-2.0
// DR3's two round-trip properties, held over generated documents rather than over three
// fixtures, plus the per-record isolation the layout depends on.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseFile,
  parseRecordSource,
  renderFile,
  renderHeader,
  renderRecord,
  type Section,
} from '../../src/adapters/store/index.ts'
import { decodeItem, encodeItem, hiddenRecordBoundary } from '../../src/adapters/store/index.ts'
import { Gen } from '../helpers/store-fixtures.ts'

const DOCUMENTS = 400
const RECORDS = 1200
const ITEMS = 800

const FIELD_KEYS = [
  'type', 'state', 'filed_at', 'version', 'priority', 'assignee', 'reporter',
  'a_newer_tool_wrote_this', 'unknown_key', 'x9', 'zz_top',
]
const SECTION_NAMES = ['Description', 'Outcome', 'Findings', 'A Newer Section', 'Notes']

type RecordSpec = {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
}

function aRecordSpec(gen: Gen): RecordSpec {
  const fields = new Map<string, string>()
  for (let i = 0; i < gen.int(0, 8); i += 1) fields.set(gen.pick(FIELD_KEYS), gen.safeLine(1, 50))
  const sections: Section[] = []
  const used = new Set<string>()
  for (let i = 0; i < gen.int(0, 3); i += 1) {
    const name = gen.pick(SECTION_NAMES)
    if (used.has(name)) continue
    used.add(name)
    sections.push({ name, body: gen.safeBody() })
  }
  return { id: gen.slug(), title: gen.safeLine(1, 80), fields, sections }
}

const MALFORMED = [
  '# Not A Slug: a heading that is not a slug\n\nstate: draft\n\n',
  '# ok-record-id: a title\n\nthis line is not a field\n\n',
  '# ok-record-id: a title\n\n__proto__: pollution\n\n',
  '# ok-record-id: a title\n\nempty_value: \n\n',
]

describe('a file the tool has not mutated re-renders byte for byte', () => {
  it(`holds over ${DOCUMENTS} generated documents`, () => {
    for (let seed = 1; seed <= DOCUMENTS; seed += 1) {
      const gen = new Gen(seed)
      let text = renderHeader(1)
      if (gen.chance(0.2)) text += `${gen.safeLine(1, 40).replace(/^#+/, 'x')}\n\n`

      let segments = 0
      for (let i = 0; i < gen.int(0, 8); i += 1) {
        segments += 1
        text += gen.chance(0.2) ? gen.pick(MALFORMED) : renderRecord(aRecordSpec(gen))
      }

      const parsed = parseFile(text, 'items/2026-09.md')
      assert.ok(parsed.ok, `seed ${seed}: ${parsed.ok ? '' : parsed.error.message}`)
      assert.equal(renderFile(parsed.value), text, `seed ${seed} did not re-render byte for byte`)
      assert.equal(
        parsed.value.records.length + parsed.value.quarantined.length,
        segments,
        `seed ${seed}: every segment is either a record or a quarantine, never dropped`,
      )
    }
  })
})

describe('a rendered record is a fixed point of parse and render', () => {
  it(`holds over ${RECORDS} generated records`, () => {
    for (let seed = 1; seed <= RECORDS; seed += 1) {
      const gen = new Gen(seed + 100_000)
      const spec = aRecordSpec(gen)
      const first = renderRecord(spec)
      const parsed = parseRecordSource(first, 1)
      assert.ok(parsed.ok, `seed ${seed}: ${parsed.ok ? '' : parsed.reason}`)
      assert.equal(renderRecord(parsed.record), first, `seed ${seed} is not a fixed point`)
      assert.equal(parsed.record.id, spec.id)
      assert.equal(parsed.record.title, spec.title)
      assert.deepEqual([...parsed.record.fields], [...spec.fields])
      assert.deepEqual(parsed.record.sections, spec.sections)
    }
  })
})

describe('a work item survives encode, render, parse and decode unchanged', () => {
  it(`holds over ${ITEMS} generated items`, (t) => {
    let survived = 0
    let refused = 0
    for (let seed = 1; seed <= ITEMS; seed += 1) {
      const item = new Gen(seed + 200_000).workItem()
      const encoded = encodeItem(item)
      // What the write path still refuses is a body that would be read back as a second
      // record, not a heading in prose; DR3 rule 4 escapes those. A refusal here is the
      // encoder working, so it is counted and the rule id asserted, rather than the
      // property silently passing because no seed happened to hit it.
      if (!encoded.ok) {
        assert.equal(encoded.error.rule, 'S1', `seed ${seed}: ${encoded.error.message}`)
        refused += 1
        continue
      }
      const parsed = parseRecordSource(renderRecord(encoded.value), 1)
      assert.ok(parsed.ok, `seed ${seed}: ${parsed.ok ? '' : parsed.reason}`)
      const decoded = decodeItem(parsed.record)
      assert.ok(decoded.ok, `seed ${seed}: ${decoded.ok ? '' : decoded.error.message}`)
      assert.deepStrictEqual({ ...decoded.value }, { ...item }, `seed ${seed} did not survive the round trip`)
      survived += 1
    }
    t.diagnostic(`${ITEMS} items: ${survived} survived unchanged, ${refused} refused at encode`)
    assert.ok(survived > ITEMS * 0.9, `only ${survived} of ${ITEMS} items reached the round trip`)
  })
})

describe('one corrupt record is quarantined and every other record keeps serving', () => {
  const good = renderRecord({ id: 'alpha-one', title: 'Alpha', fields: new Map([['state', 'draft']]), sections: [] })
  const also = renderRecord({ id: 'gamma-one', title: 'Gamma', fields: new Map([['state', 'ready']]), sections: [] })
  const text = `${renderHeader(1)}${good}# Renamed Heading: broken\n\nstate: draft\n\n${also}`
  const parsed = parseFile(text, 'items/2026-09.md')

  it('serves the records either side of the corruption', () => {
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.value.records.map((r) => r.id), ['alpha-one', 'gamma-one'])
  })

  it('names the quarantined record by line and reason', () => {
    assert.ok(parsed.ok)
    assert.equal(parsed.value.quarantined.length, 1)
    const [bad] = parsed.value.quarantined
    assert.equal(bad?.line, 7)
    assert.equal(bad?.rule, 'S1')
    assert.match(bad?.reason ?? '', /record heading is not/)
  })

  it('keeps the corrupt bytes, so the file still re-renders exactly', () => {
    assert.ok(parsed.ok)
    assert.equal(renderFile(parsed.value), text)
  })
})

describe('a record missing a mandatory field before a later section', () => {
  it('is not split by a field-shaped line in its own section body', () => {
    // Regression for damagedHeadingAt resynchronising on `type: reminder` inside the
    // "## Notes" body: the record above is missing `version`, so the old code turned off
    // the mandatory-field exemption at the first "## " line rather than at the fourth
    // mandatory field, and treated the body line as a damaged heading of its own.
    const text = [
      'schema: 1',
      '',
      '# item-one: A first task',
      '',
      'type: task',
      'state: draft',
      'filed_at: 2026-09-01T10:00:00Z',
      '',
      '## Notes',
      '',
      'type: reminder',
      'state: draft',
      '',
    ].join('\n')
    const parsed = parseFile(text, 'items/2026-09.md')
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.value.records.map((r) => r.id), ['item-one'])
    assert.equal(
      parsed.value.quarantined.length, 0,
      `the section body was resynced as a phantom record: ${JSON.stringify(parsed.value.quarantined)}`,
    )
  })
})

describe('a file that is not one of ours, and a schema line that is', () => {
  it('refuses a file whose first line is not "schema: <n>"', () => {
    const parsed = parseFile('# alpha-one: no header\n\nstate: draft\n', 'items/2026-09.md')
    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? '' : parsed.error.rule, 'S1')
  })

  it('reads the schema number the file carries', () => {
    const parsed = parseFile('schema: 7\n\n', 'items/2026-09.md')
    assert.ok(parsed.ok)
    assert.equal(parsed.value.schema, 7)
  })

  it('reports CRLF so the next write can normalise it', () => {
    const parsed = parseFile('schema: 1\r\n\r\n# alpha-one: T\r\n\r\nstate: draft\r\n\r\n', 'items/2026-09.md')
    assert.ok(parsed.ok)
    assert.equal(parsed.value.crlf, true)
    assert.equal(parsed.value.records[0]?.id, 'alpha-one')
  })
})

describe('a newer tool\'s fields and sections travel through a mutation', () => {
  it('keeps an unknown field key and an unknown section on the record', () => {
    const source = renderRecord({
      id: 'alpha-one',
      title: 'Alpha',
      fields: new Map([['state', 'draft'], ['a_field_from_2027', 'kept']]),
      sections: [{ name: 'A Section From 2027', body: 'kept too' }],
    })
    const parsed = parseRecordSource(source, 1)
    assert.ok(parsed.ok)
    const item = decodeItem({ ...parsed.record, fields: new Map([...parsed.record.fields,
      ['type', 'task'], ['filed_at', '2026-09-01T10:00:00Z'], ['version', '3']]) })
    assert.ok(item.ok, item.ok ? '' : item.error.message)
    assert.equal(item.value.extra?.get('a_field_from_2027'), 'kept')

    const re = encodeItem(item.value, parsed.record)
    assert.ok(re.ok)
    assert.equal(re.value.fields.get('a_field_from_2027'), 'kept')
    assert.deepEqual(re.value.sections.at(-1), { name: 'A Section From 2027', body: 'kept too' })
  })
})

describe('a markdown heading inside a record body', () => {
  // DR3 rule 4 escapes rather than refuses, so these are the shapes a fleet backlog body
  // actually carries. Each must reach the file, survive the round trip byte for byte, and
  // stay one section: an unescaped `## ` line would open a second section instead.
  const BODIES = [
    '# a plain heading',
    '## The concern that must be priced into any answer',
    '###### six hashes',
    '#',
    '#nospace',
    '\\## prose that already carries a backslash',
    '\\\\## prose that carries two',
    '\\not a heading at all',
    'above\n## in the middle\nbelow',
    '# alpha-two: a title-shaped line with no field block under it',
  ]

  for (const body of BODIES) {
    it(`round trips ${JSON.stringify(body)}`, () => {
      const source = renderRecord({
        id: 'alpha-one',
        title: 'Alpha',
        fields: new Map([['type', 'task'], ['state', 'draft']]),
        sections: [{ name: 'Description', body }],
      })
      const parsed = parseRecordSource(source, 1)
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason)
      assert.deepEqual(parsed.record.sections, [{ name: 'Description', body }])
      assert.equal(renderRecord(parsed.record), source, 'the escaped record is not a fixed point')
    })
  }

  it('writes CommonMark\'s own escape, so a reader sees the prose the record holds', () => {
    const source = renderRecord({
      id: 'alpha-one',
      title: 'Alpha',
      fields: new Map([['state', 'draft']]),
      sections: [{ name: 'Description', body: '## A heading' }],
    })
    assert.match(source, /^\\## A heading$/m)
    assert.doesNotMatch(source, /^## A heading$/m)
  })

  // At file level a `# ` body line is the record boundary itself and a `## ` one is a
  // section heading, so this is where an unescaped heading costs a record rather than a
  // section: the file below holds two records whatever the prose in the first one says.
  for (const body of ['# gamma-one: a heading that reads like a record', '## Design notes']) {
    it(`keeps a file at two records with ${JSON.stringify(body)} in the first body`, () => {
      const first = renderRecord({
        id: 'alpha-one',
        title: 'Alpha',
        fields: new Map([['type', 'task'], ['state', 'draft']]),
        sections: [{ name: 'Description', body }],
      })
      const second = renderRecord({
        id: 'gamma-one', title: 'Gamma', fields: new Map([['state', 'ready']]), sections: [],
      })
      const text = `${renderHeader(1)}${first}${second}`
      const parsed = parseFile(text, 'items/2026-09.md')
      assert.ok(parsed.ok)
      assert.deepEqual(parsed.value.records.map((r) => r.id), ['alpha-one', 'gamma-one'])
      assert.deepEqual(parsed.value.quarantined, [])
      assert.deepEqual(parsed.value.records[0]?.sections, [{ name: 'Description', body }])
      assert.equal(renderFile(parsed.value), text)
    })
  }

  it('is not lost when the record is rewritten, because the escape does not accumulate', () => {
    const body = '## A heading'
    let source = renderRecord({
      id: 'alpha-one', title: 'Alpha',
      fields: new Map([['state', 'draft']]), sections: [{ name: 'Description', body }],
    })
    for (let round = 0; round < 5; round += 1) {
      const parsed = parseRecordSource(source, 1)
      assert.ok(parsed.ok)
      assert.equal(parsed.record.sections[0]?.body, body, `round ${round} drifted`)
      source = renderRecord(parsed.record)
    }
  })
})

describe('a body that would be read back as a second record', () => {
  const fields = new Map([['type', 'task'], ['state', 'draft'], ['filed_at', '2026-09-01T10:00:00Z'], ['version', '1']])
  const smuggled = 'the record I am quoting reads\n\ntype: task\nstate: draft\nfiled_at: 2026-01-01T00:00:00Z\nversion: 1'

  it('is named by the same predicate the read path resynchronises on', () => {
    const hidden = hiddenRecordBoundary({
      id: 'carrier-one', title: 'Carrier', fields, sections: [{ name: 'Description', body: smuggled }],
    })
    assert.equal(hidden, 'type: task')
  })

  it('is refused at encode, rather than written and quarantined on the way back', () => {
    const item = new Gen(1).workItem({ id: 'carrier-one', description: smuggled })
    const encoded = encodeItem(item)
    assert.equal(encoded.ok, false)
    assert.equal(encoded.ok ? '' : encoded.error.rule, 'S1')
    assert.match(encoded.ok ? '' : encoded.error.message, /would be read back as a second record's heading/)
  })

  it('covers the indented heading the column-0 bound never saw', () => {
    const hidden = hiddenRecordBoundary({
      id: 'carrier-one',
      title: 'Carrier',
      fields,
      sections: [{ name: 'Description', body: '  ## alpha-two: a smuggled title\n\ntype: task\nstate: draft\nfiled_at: 2026-01-01T00:00:00Z\nversion: 1' }],
    })
    assert.equal(hidden, '  ## alpha-two: a smuggled title')
  })

  it('leaves an ordinary body alone', () => {
    assert.equal(hiddenRecordBoundary({
      id: 'alpha-one', title: 'Alpha', fields,
      sections: [{ name: 'Description', body: '## A heading\n\nnote: this is prose, with no field block under it' }],
    }), undefined)
  })
})
