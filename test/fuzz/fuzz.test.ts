// SPDX-License-Identifier: Apache-2.0
// A mutation fuzzer over the two components that read bytes somebody else wrote: the record
// parser and the escaper the renderer's guards are built from.
//
// The oracle is not "it produced the right answer", because a fuzzer has no expected answer.
// It is the contract each component states about itself, and there are four parts to it.
// `parseFile` returns a result and never throws, whatever it is handed. Every segment it
// reads is either served or quarantined with a rule and a line, never dropped. A record it
// served re-renders to the same bytes it came in as. And no input makes any of it superlinear,
// which is finding F8's ReDoS half: every regex in the parser and the escaper is written
// without a nested quantifier, and a per-input time bound is what proves it rather than says it.
//
// The corpus in `corpus/` is committed. A crash found here becomes a named regression test
// beside the security suites, and the failure message prints the input as base64 so the
// case can be lifted into one without re-running the fuzzer.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before } from 'node:test'

import { findUnsafeCharacter, isSafeText } from '../../src/domain/index.ts'
import { parseFile, parseRecordSource, renderRecord } from '../../src/adapters/store/index.ts'
import {
  RenderInvariant, guardCell, guardSingleLine, textBlock,
} from '../../src/adapters/render/grammar.ts'
import { Gen } from '../helpers/store-fixtures.ts'

const CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url))

/**
 * The gate's count, which every `npm test` pays for. `TREADLE_FUZZ_INPUTS` raises it for a
 * soak run without touching the gate: a fuzzer that is slow enough to be skipped is a
 * fuzzer nobody runs, and one that only ever runs at its floor never finds anything new.
 */
const INPUTS = Number(process.env['TREADLE_FUZZ_INPUTS'] ?? 250_000)

const PARSER_INPUTS = INPUTS
const ESCAPER_INPUTS = INPUTS

/** No parse of any input this suite generates may take longer than this (F8's ReDoS half). */
const TIME_BUDGET_MS = 250

type Corpus = { readonly documents: readonly string[]; readonly values: readonly string[] }

async function loadCorpus(): Promise<Corpus> {
  const documents: string[] = []
  let values: string[] = []
  for (const name of (await readdir(CORPUS)).sort()) {
    const text = await readFile(path.join(CORPUS, name), 'utf8')
    if (name.endsWith('.json')) values = JSON.parse(text) as string[]
    else documents.push(text)
  }
  assert.ok(documents.length > 0, 'the document corpus is empty')
  assert.ok(values.length > 0, 'the value corpus is empty')
  return { documents, values }
}

/** Interesting bytes to splice in: the delimiters of both grammars and the class edges. */
const SPLICE = [
  '\n', '\r', '\r\n', '\t', ' ', ':', ': ', '# ', '## ', '#', '"', '|', '~', '+', '__proto__',
  'schema: ', '-', String.fromCodePoint(0x00), String.fromCodePoint(0x202e),
  String.fromCodePoint(0x200d), String.fromCodePoint(0xd800), String.fromCodePoint(0x1b),
]

/** Eight structural mutations, applied one to four at a time. */
function mutate(gen: Gen, input: string): string {
  let out = input
  for (let round = 0; round < gen.int(1, 4) && out.length < 1 << 18; round += 1) {
    const at = out.length === 0 ? 0 : gen.int(0, out.length - 1)
    switch (gen.int(0, 7)) {
      case 0: out = out.slice(0, at) + gen.pick(SPLICE) + out.slice(at); break
      case 1: out = out.slice(0, at) + out.slice(at + gen.int(1, 16)); break
      case 2: out = out.slice(0, at) + out.slice(at, at + gen.int(1, 64)) + out.slice(at); break
      case 3: out = out.slice(0, at) + String.fromCharCode(gen.int(0, 0xffff)) + out.slice(at); break
      case 4: out = out.slice(0, gen.int(0, out.length)); break
      case 5: out = out + out.slice(0, Math.min(out.length, 512)); break
      case 6: out = out.replaceAll('\n', gen.pick(['\n\n', '\r\n', '', '\n '])); break
      default: out = gen.pick(SPLICE) + out
    }
  }
  return out
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

describe('the record parser survives a mutation fuzzer', () => {
  let corpus: Corpus
  before(async () => { corpus = await loadCorpus() })

  it(`holds over ${PARSER_INPUTS.toLocaleString('en')} mutated inputs`, (t) => {
    let crashes = 0
    let parsed = 0
    let refused = 0
    let served = 0
    let quarantined = 0
    let slowest = 0

    const gen = new Gen(20_260_905)
    for (let i = 0; i < PARSER_INPUTS; i += 1) {
      const input = mutate(gen, gen.pick(corpus.documents))
      const started = performance.now()
      let outcome: ReturnType<typeof parseFile>
      try {
        outcome = parseFile(input, 'items/fuzz.md')
      } catch (error) {
        crashes += 1
        assert.fail(`parseFile threw ${String(error)} on base64 input ${base64(input)}`)
      }
      const elapsed = performance.now() - started
      slowest = Math.max(slowest, elapsed)
      assert.ok(elapsed < TIME_BUDGET_MS, `a parse took ${elapsed.toFixed(1)} ms on base64 input ${base64(input)}`)

      if (!outcome.ok) {
        refused += 1
        assert.ok(outcome.error.rule !== undefined, `a file refusal named no rule: ${base64(input)}`)
        continue
      }
      parsed += 1
      served += outcome.value.records.length
      quarantined += outcome.value.quarantined.length

      for (const bad of outcome.value.quarantined) {
        assert.ok(bad.rule.length > 0 && bad.reason.length > 0, `an unnamed quarantine: ${base64(input)}`)
      }
      for (const record of outcome.value.records) {
        // A served record's own bytes must re-parse to the same record, or the store would
        // hand back something it cannot write again.
        const again = parseRecordSource(record.source, record.line)
        assert.ok(again.ok, `a served record no longer parses: ${base64(record.source)}`)
        assert.equal(again.record.id, record.id)
        assert.equal(renderRecord(again.record), renderRecord(record), `render is not stable: ${base64(record.source)}`)
      }
    }

    assert.equal(crashes, 0)
    t.diagnostic(`${PARSER_INPUTS} inputs: ${parsed} parsed, ${refused} refused at file level, ${served} records served, ${quarantined} quarantined`)
    t.diagnostic(`crashes: 0; slowest single parse: ${slowest.toFixed(1)} ms against a ${TIME_BUDGET_MS} ms budget`)
  })
})

describe('the escaper survives a mutation fuzzer', () => {
  let corpus: Corpus
  before(async () => { corpus = await loadCorpus() })

  it(`holds over ${ESCAPER_INPUTS.toLocaleString('en')} mutated values`, (t) => {
    let refusedByClass = 0
    let refusedByGuard = 0
    let passed = 0
    let slowest = 0

    const gen = new Gen(20_260_906)
    for (let i = 0; i < ESCAPER_INPUTS; i += 1) {
      const value = mutate(gen, gen.pick(corpus.values))
      const started = performance.now()

      const unsafe = findUnsafeCharacter(value, gen.chance(0.5) ? 'line' : 'text')
      if (unsafe !== undefined) {
        refusedByClass += 1
        assert.ok(unsafe.label.startsWith('U+'), `a refusal that names no code point: ${base64(value)}`)
        assert.ok(unsafe.at >= 0 && unsafe.at < [...value].length, `a refusal at an impossible index: ${base64(value)}`)
      }
      assert.equal(isSafeText(value), findUnsafeCharacter(value) === undefined)

      // The guards are the belt to the class's brace: whatever the class said, a value that
      // would end its own line or split a row must be refused here and never rendered.
      try {
        guardSingleLine('k', value)
        passed += 1
        assert.equal(value.includes('\n'), false, `a newline passed the guard: ${base64(value)}`)
        assert.equal(value.includes('\r'), false, `a carriage return passed the guard: ${base64(value)}`)
      } catch (error) {
        refusedByGuard += 1
        assert.ok(error instanceof RenderInvariant, `the guard threw ${String(error)} on ${base64(value)}`)
      }
      try {
        guardCell('c', value)
        assert.equal(/[\n\r ]/.test(value), false, `a splitting cell passed the guard: ${base64(value)}`)
      } catch (error) {
        assert.ok(error instanceof RenderInvariant, `guardCell threw ${String(error)} on ${base64(value)}`)
      }

      // A counted block is the only shape a multi-line value may take, and its header has to
      // agree with what follows it however the value is composed.
      const block = textBlock('k', value)
      assert.equal(block.length - 1, value.split('\n').length, `the block count is wrong: ${base64(value)}`)
      const header = /^\|k (\d+) (\d+)$/.exec(block[0] as string)
      assert.ok(header !== null, `a block header that does not parse: ${base64(value)}`)
      assert.equal(Number(header[2]), Buffer.byteLength(value, 'utf8'))
      for (const line of block.slice(1)) {
        assert.ok(line === '"' || line.startsWith('" '), `an unmarked content line: ${base64(value)}`)
      }

      const elapsed = performance.now() - started
      slowest = Math.max(slowest, elapsed)
      assert.ok(elapsed < TIME_BUDGET_MS, `an escape took ${elapsed.toFixed(1)} ms on base64 input ${base64(value)}`)
    }

    t.diagnostic(`${ESCAPER_INPUTS} values: ${refusedByClass} refused by the safe-text class, ${refusedByGuard} refused by the line guard, ${passed} passed`)
    t.diagnostic(`crashes: 0; slowest single value: ${slowest.toFixed(1)} ms against a ${TIME_BUDGET_MS} ms budget`)
  })
})
