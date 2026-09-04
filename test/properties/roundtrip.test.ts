// SPDX-License-Identifier: Apache-2.0
// Accuracy as a property rather than a list of cases: `renderFile(parseFile(x))` reproduces
// `x` byte for byte over generated documents whose content is chosen to break the parser.
//
// `test/store/grammar.test.ts` already holds this over content that is meant to survive.
// This is the same claim over content that is not: the delimiters of the tool's own two
// grammars, bidi and zero-width code points, ANSI, lone surrogates, normalisation pairs,
// null bytes, and titles sitting on and one past every declared limit. A hostile document
// mostly quarantines, and the round trip has to be exact anyway, because a file the tool
// has not mutated is never re-rendered.
//
// The one departure from byte-for-byte is stated rather than hidden: DR3 rule 6 normalises
// CRLF on the next write, so the fixed point of a CRLF file is its LF form.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decodeItem,
  encodeItem,
  parseFile,
  parseRecordSource,
  renderFile,
  renderHeader,
  renderRecord,
  type Section,
} from '../../src/adapters/store/index.ts'
import { Adversary, missingCategories } from './adversary.ts'

const DOCUMENTS = 2_000
const RECORDS = 2_000
const ITEMS = 1_000

const FIELD_KEYS = ['type', 'state', 'filed_at', 'priority', 'assignee', 'unknown_key', '_x']
const SECTION_NAMES = ['Description', 'Outcome', 'Findings', 'Notes']

type Spec = {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
}

/**
 * A record spec whose every free position may carry an adversarial value. Half the specs
 * draw only from the categories the safe-text class permits, so the suite exercises the
 * bytes that reach storage as well as the ones that are turned away at the door.
 */
function aHostileSpec(adversary: Adversary): Spec {
  const gen = adversary.gen
  const legal = gen.chance(0.5)
  const content = (): string => (legal ? adversary.survivable() : adversary.value())

  const fields = new Map<string, string>()
  for (let i = 0; i < gen.int(0, 5); i += 1) {
    const key = !legal && gen.chance(0.15) ? adversary.value() : gen.pick(FIELD_KEYS)
    fields.set(key, gen.chance(0.6) ? content() : adversary.benign())
  }
  const sections: Section[] = []
  const used = new Set<string>()
  for (let i = 0; i < gen.int(0, 2); i += 1) {
    const name = !legal && gen.chance(0.2) ? adversary.value() : gen.pick(SECTION_NAMES)
    if (used.has(name)) continue
    used.add(name)
    sections.push({ name, body: gen.chance(0.6) ? content() : adversary.benign(1, 60) })
  }
  return {
    id: !legal && gen.chance(0.2) ? adversary.value() : gen.slug(),
    title: gen.chance(0.7) ? content() : adversary.benign(1, 80),
    fields,
    sections,
  }
}

/** Segments, counted the way the parser counts them: a line starting `# ` opens one. */
function headingCount(text: string, from: number): number {
  return text.split('\n').slice(from).filter((line) => line.startsWith('# ')).length
}

describe('a document round-trips byte for byte whatever is written into it', () => {
  it(`holds over ${DOCUMENTS} generated adversarial documents`, (t) => {
    const covered = new Set<string>()
    let quarantined = 0
    let served = 0

    for (let seed = 1; seed <= DOCUMENTS; seed += 1) {
      const adversary = new Adversary(seed + 900_000)
      const gen = adversary.gen
      let text = renderHeader(1)
      const headerLines = text.split('\n').length - 1
      if (gen.chance(0.25)) text += `${adversary.value()}\n\n`
      for (let i = 0; i < gen.int(0, 5); i += 1) text += renderRecord(aHostileSpec(adversary))

      const normalised = text.replaceAll('\r\n', '\n')
      const parsed = parseFile(text, 'items/2026-09.md')
      assert.ok(parsed.ok, `seed ${seed}: ${parsed.ok ? '' : parsed.error.message}`)
      assert.equal(parsed.value.crlf, text.includes('\r\n'), `seed ${seed}: CRLF was not reported`)
      assert.equal(
        renderFile(parsed.value), normalised,
        `seed ${seed} did not re-render byte for byte`,
      )
      assert.equal(
        parsed.value.records.length + parsed.value.quarantined.length,
        headingCount(normalised, headerLines),
        `seed ${seed}: a segment was neither served nor quarantined`,
      )
      for (const bad of parsed.value.quarantined) {
        assert.ok(bad.rule.length > 0 && bad.reason.length > 0, `seed ${seed}: an unnamed quarantine`)
        assert.ok(bad.line >= 1, `seed ${seed}: a quarantine with no line`)
      }
      quarantined += parsed.value.quarantined.length
      served += parsed.value.records.length
      for (const category of adversary.categoriesCovered) covered.add(category)
    }

    assert.deepEqual(missingCategories([...covered] as never), [], 'a hostile category went unused')
    t.diagnostic(`${DOCUMENTS} documents: ${served} records served, ${quarantined} quarantined`)
    t.diagnostic(`hostile categories exercised: ${covered.size}`)
  })
})

describe('a record that parses is a fixed point of parse and render', () => {
  it(`holds over ${RECORDS} generated adversarial records`, (t) => {
    let accepted = 0
    let refused = 0
    for (let seed = 1; seed <= RECORDS; seed += 1) {
      const spec = aHostileSpec(new Adversary(seed + 800_000))
      const first = renderRecord(spec)
      const parsed = parseRecordSource(first, 1)
      if (!parsed.ok) {
        assert.ok(parsed.rule.length > 0, `seed ${seed}: a refusal that names no rule`)
        refused += 1
        continue
      }
      accepted += 1
      assert.equal(renderRecord(parsed.record), renderRecord(parsed.record), `seed ${seed} is not stable`)
      const again = parseRecordSource(renderRecord(parsed.record), 1)
      assert.ok(again.ok, `seed ${seed}: a rendered record no longer parses`)
      assert.equal(renderRecord(again.record), renderRecord(parsed.record), `seed ${seed} is not a fixed point`)
    }
    t.diagnostic(`${RECORDS} records: ${accepted} accepted, ${refused} refused by a named rule`)
  })
})

describe('a work item either refuses at encode or survives the round trip exactly', () => {
  it(`holds over ${ITEMS} generated items carrying adversarial content`, (t) => {
    let survived = 0
    let refused = 0
    for (let seed = 1; seed <= ITEMS; seed += 1) {
      const adversary = new Adversary(seed + 700_000)
      const gen = adversary.gen
      const legal = gen.chance(0.5)
      const content = (): string => (legal ? adversary.survivable() : adversary.value())
      const item = gen.workItem({ title: content() })
      const hostile = { ...item, ...(gen.chance(0.5) ? { assignee: content() } : {}) }

      const encoded = encodeItem(hostile)
      if (!encoded.ok) {
        assert.ok(encoded.error.message.length > 0, `seed ${seed}: an encode refusal with no message`)
        refused += 1
        continue
      }
      const parsed = parseRecordSource(renderRecord(encoded.value), 1)
      if (!parsed.ok) {
        refused += 1
        continue
      }
      const decoded = decodeItem(parsed.record)
      if (!decoded.ok) {
        refused += 1
        continue
      }
      survived += 1
      assert.deepStrictEqual(
        { ...decoded.value }, { ...hostile },
        `seed ${seed}: an item the store accepted did not come back unchanged`,
      )
    }
    assert.ok(survived > 0, 'every generated item was refused, so the property proved nothing')
    assert.ok(refused > 0, 'no generated item was refused, so the adversary is not adversarial')
    t.diagnostic(`${ITEMS} items: ${survived} survived unchanged, ${refused} refused before storage`)
  })
})
