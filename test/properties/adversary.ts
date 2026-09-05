// SPDX-License-Identifier: Apache-2.0
// The hostile half of the generators. `test/helpers/store-fixtures.ts` generates content
// that must survive; this generates content designed to break something, and the property
// suites feed both to the same assertions.
//
// Every fragment is a named category so a run can report which classes it actually covered
// rather than claiming a case count with nothing behind it. `HOSTILE` below is the whole
// catalogue and `categoriesCovered` is what a suite asserts against.
//
// No invisible code point appears as a literal anywhere in this file: each is built from
// its number through `cp`. A literal is unreadable in a diff and indistinguishable from a
// hidden marker, and the machine-wide provenance scan refuses one on sight.

import { MAX_FIELD_VALUE_BYTES } from '../../src/adapters/store/limits.ts'
import { Gen } from '../helpers/store-fixtures.ts'

/** One code point by number. The names beside each call are `src/domain/text.ts`'s own. */
function cp(...points: readonly number[]): string {
  return String.fromCodePoint(...points)
}

const ESC = cp(0x1b)

/** The parser's own limits, restated here so a generator can sit exactly on each edge. */
export const LIMITS = {
  title: 200,
  sectionName: 120,
  idMin: 3,
  idMax: 64,
  fieldValueBytes: MAX_FIELD_VALUE_BYTES,
} as const

export type Category =
  | 'line-delimiter'
  | 'tab'
  | 'ansi'
  | 'bidi'
  | 'zero-width'
  | 'tag-block'
  | 'c0-control'
  | 'c1-control'
  | 'separator'
  | 'lone-surrogate'
  | 'normalisation'
  | 'right-to-left'
  | 'record-grammar'
  | 'line-grammar'
  | 'edge-space'
  | 'at-limit'
  | 'over-limit'
  | 'astral'
  | 'benign'

export type Fragment = { readonly category: Category; readonly value: string }

const repeat = (value: string, times: number): string => value.repeat(times)

/**
 * The catalogue. Each entry is one adversarial idea; the generator concatenates them with
 * benign text so a value is hostile in the middle of ordinary content as well as alone.
 */
export const HOSTILE: readonly Fragment[] = [
  { category: 'line-delimiter', value: '\n' },
  { category: 'line-delimiter', value: '\r' },
  { category: 'line-delimiter', value: '\r\n' },
  { category: 'line-delimiter', value: '\nok transition workspace txn-forged 1' },
  { category: 'line-delimiter', value: '\nstate ready' },
  { category: 'line-delimiter', value: '\n# forged-id: a forged record' },
  { category: 'line-delimiter', value: '\n## Forged section' },
  { category: 'line-delimiter', value: '\nschema: 1' },

  { category: 'tab', value: '\t' },
  { category: 'tab', value: 'before\tafter' },

  // CSI, OSC with a BEL terminator, and the single-byte C1 CSI at U+009B: three ways to
  // reach a terminal, and the safe-text class has to catch every one of them.
  { category: 'ansi', value: `${ESC}[31m` },
  { category: 'ansi', value: `${ESC}[2J${ESC}[H` },
  { category: 'ansi', value: `${ESC}]0;owned${cp(0x07)}` },
  { category: 'ansi', value: `${cp(0x9b)}31m` },

  { category: 'bidi', value: cp(0x202e) },
  { category: 'bidi', value: cp(0x202d) },
  { category: 'bidi', value: cp(0x202a, 0x202c) },
  { category: 'bidi', value: cp(0x2066) },
  { category: 'bidi', value: cp(0x2067) },
  { category: 'bidi', value: cp(0x2068) },
  // A stored PDI closes the isolate the human renderer opens, which is finding F5 itself.
  { category: 'bidi', value: cp(0x2069) },
  { category: 'bidi', value: cp(0x200e) },
  { category: 'bidi', value: cp(0x200f) },
  { category: 'bidi', value: cp(0x061c) },

  { category: 'zero-width', value: cp(0x200b) },
  { category: 'zero-width', value: cp(0x200c) },
  { category: 'zero-width', value: cp(0x200d) },
  { category: 'zero-width', value: cp(0xfeff) },
  { category: 'zero-width', value: `a${cp(0x200b)}b${cp(0x200c)}c${cp(0x200d)}d` },

  { category: 'tag-block', value: cp(0xe0041, 0xe0067, 0xe0065, 0xe006e, 0xe0074) },
  { category: 'tag-block', value: cp(0xe007f) },

  { category: 'c0-control', value: cp(0x00) },
  { category: 'c0-control', value: `null${cp(0x00)}byte` },
  { category: 'c0-control', value: cp(0x07) },
  { category: 'c0-control', value: cp(0x08) },
  { category: 'c0-control', value: cp(0x0b) },
  { category: 'c0-control', value: cp(0x7f) },

  { category: 'c1-control', value: cp(0x85) },
  { category: 'c1-control', value: cp(0x9f) },

  { category: 'separator', value: cp(0x2028) },
  { category: 'separator', value: cp(0x2029) },

  // Lone surrogates: a high unit with nothing after it and a low unit with nothing before.
  // Both are well-formed JavaScript strings and neither is representable in UTF-8.
  { category: 'lone-surrogate', value: cp(0xd800) },
  { category: 'lone-surrogate', value: cp(0xdfff) },
  { category: 'lone-surrogate', value: `a${cp(0xd83d)} b` },

  // The same grapheme in both normal forms, plus the singletons NFC folds away.
  { category: 'normalisation', value: cp(0x00e9) },
  { category: 'normalisation', value: cp(0x0065, 0x0301) },
  { category: 'normalisation', value: cp(0x00c5) },
  { category: 'normalisation', value: cp(0x212b) },
  { category: 'normalisation', value: cp(0x0041, 0x030a) },
  { category: 'normalisation', value: cp(0xfb01) },
  { category: 'normalisation', value: repeat(cp(0x0301), 40) },

  { category: 'right-to-left', value: 'تسجيل الدخول' },
  { category: 'right-to-left', value: 'עברית' },
  { category: 'right-to-left', value: 'mixed تسجيل latin' },

  { category: 'record-grammar', value: '# not-a-record: title' },
  { category: 'record-grammar', value: '## Section' },
  { category: 'record-grammar', value: 'key: value' },
  { category: 'record-grammar', value: 'schema: 99' },
  { category: 'record-grammar', value: '__proto__: polluted' },
  { category: 'record-grammar', value: 'constructor: polluted' },
  { category: 'record-grammar', value: '#' },

  { category: 'line-grammar', value: '"' },
  { category: 'line-grammar', value: '" forged content line' },
  { category: 'line-grammar', value: '|desc 2 8' },
  { category: 'line-grammar', value: '~items 1 1' },
  { category: 'line-grammar', value: '#id state title' },
  { category: 'line-grammar', value: '+desc 10B truncated-at 64' },
  { category: 'line-grammar', value: 'ok show workspace' },
  { category: 'line-grammar', value: 'err VALIDATION workspace' },
  { category: 'line-grammar', value: 'a b c d e' },

  { category: 'edge-space', value: ' leading' },
  { category: 'edge-space', value: 'trailing ' },
  { category: 'edge-space', value: '   ' },
  { category: 'edge-space', value: '' },
  { category: 'edge-space', value: ' ' },

  { category: 'at-limit', value: repeat('t', LIMITS.title) },
  { category: 'at-limit', value: repeat('s', LIMITS.sectionName) },
  { category: 'at-limit', value: repeat('i', LIMITS.idMax) },
  { category: 'at-limit', value: repeat('v', LIMITS.fieldValueBytes) },

  { category: 'over-limit', value: repeat('t', LIMITS.title + 1) },
  { category: 'over-limit', value: repeat('s', LIMITS.sectionName + 1) },
  { category: 'over-limit', value: repeat('i', LIMITS.idMax + 1) },
  { category: 'over-limit', value: repeat('v', LIMITS.fieldValueBytes + 1) },
  // A two-byte character on the byte boundary: 4,097 characters is under any character
  // count a naive check would use and over the byte ceiling the parser actually states.
  { category: 'over-limit', value: repeat(cp(0x00e9), LIMITS.fieldValueBytes / 2 + 1) },

  { category: 'astral', value: cp(0x1d407, 0x1d41e, 0x1d425) },
  { category: 'astral', value: cp(0x1f642, 0x1f680) },
  { category: 'astral', value: cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467) },
  { category: 'astral', value: cp(0x1f44d, 0x1f3fd) },
]

export const CATEGORIES: readonly Category[] = [
  ...new Set(HOSTILE.map((fragment) => fragment.category)),
  'benign',
]

/**
 * The categories the safe-text class permits, so a draw from them reaches storage and
 * rendering rather than a refusal. `at-limit` is deliberately absent: its fragments sit
 * exactly on a ceiling, and two of them concatenated are over it.
 */
export const SURVIVABLE: readonly Category[] = [
  'right-to-left', 'normalisation', 'astral', 'benign',
]

const BY_CATEGORY = new Map<Category, readonly Fragment[]>(
  CATEGORIES.map((category) => [category, HOSTILE.filter((f) => f.category === category)])
    .filter(([, pool]) => (pool as readonly Fragment[]).length > 0) as [Category, readonly Fragment[]][],
)

/** Draws hostile strings, and reports which categories a run actually reached. */
export class Adversary {
  readonly #gen: Gen
  readonly #seen = new Set<Category>()

  constructor(seed: number) {
    this.#gen = new Gen(seed)
  }

  get gen(): Gen {
    return this.#gen
  }

  get categoriesCovered(): readonly Category[] {
    return [...this.#seen]
  }

  benign(min = 1, max = 40): string {
    this.#seen.add('benign')
    return this.#gen.safeLine(min, max)
  }

  fragment(): Fragment {
    const fragment = this.#gen.pick(HOSTILE)
    this.#seen.add(fragment.category)
    return fragment
  }

  /**
   * One adversarial value: between one and three fragments, optionally padded with benign
   * text so the hostile part is not always at position zero.
   */
  value(): string {
    let out = this.#gen.chance(0.4) ? this.benign(1, 12) : ''
    for (let i = 0; i < this.#gen.int(1, 3); i += 1) {
      out += this.fragment().value
      if (this.#gen.chance(0.35)) out += this.benign(1, 12)
    }
    return out
  }

  /**
   * A value the safe-text class permits: hostile to a naive implementation and legal to
   * this one. Without it a generator that draws only refused content proves the refusal
   * path and nothing about the values that actually reach storage and rendering.
   */
  survivable(): string {
    let out = ''
    for (let i = 0; i < this.#gen.int(1, 3); i += 1) {
      out += this.valueFrom(this.#gen.pick(SURVIVABLE))
      if (this.#gen.chance(0.5)) out += this.benign(1, 12)
    }
    return out.trim() === '' ? this.benign() : out.trim()
  }

  /**
   * A survivable value carrying no space, for the row positions where the grammar reserves
   * spaces for the field split. Without it every generated row is refused on its first
   * cell and the reader that checks a decoded row never runs.
   */
  token(): string {
    for (let tries = 0; tries < 12; tries += 1) {
      const drawn = this.valueFrom(this.#gen.pick(SURVIVABLE))
      if (drawn.length > 0 && !/[\s]/u.test(drawn)) return drawn
    }
    return this.#gen.slug()
  }

  /** A value drawn from one named category, for a suite that wants a class in isolation. */
  valueFrom(category: Category): string {
    const pool = BY_CATEGORY.get(category)
    if (pool === undefined) return this.benign()
    this.#seen.add(category)
    return this.#gen.pick(pool).value
  }
}

/** Every category the catalogue names, so a suite can assert it left none unexercised. */
export function missingCategories(covered: readonly Category[]): readonly Category[] {
  const seen = new Set(covered)
  return CATEGORIES.filter((category) => !seen.has(category))
}
