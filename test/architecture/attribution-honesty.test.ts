// SPDX-License-Identifier: Apache-2.0
// What a recorded actor proves, held in place wherever a reader meets one.
//
// The honest sentence existed only as a comment in src/application/services/doctor.ts, beside
// the audit that notices a record disagreeing with the log that recorded its value. Then a
// mutation naming nobody was refused, which is a real property and also the thing most likely
// to be misread: no event is unattributable, so the name on one looks checked. Nothing checks
// it. It is declared by whoever ran the command, and what is unforgeable is the signed commit
// carrying the file.
//
// A statement nothing holds is a statement one edit away from being gone, which is how it came
// to live in a source comment in the first place. This is the holding.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** AGENTS.md is hard-wrapped and DOMAIN.md is one sentence per line, so a claim spans a
 *  newline in one file and not in another; the match is over the sentence, not the layout. */
function prose(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ')
}

/** The three claims together, because any one alone reads as a different statement. */
const CLAIMS: readonly (readonly [string, RegExp])[] = [
  ['it is declared rather than checked', /declared by whoever ran the command/],
  ['the tool verifies nothing', /verifies no identity/],
  ['what does prove authorship', /signed commit/],
]

describe('every surface that meets a reader says what a recorded actor proves', () => {
  for (const file of ['README.md', 'AGENTS.md', 'docs/DOMAIN.md']) {
    const text = prose(file)
    for (const [claim, pattern] of CLAIMS) {
      it(`${file} says ${claim}`, () => {
        assert.ok(pattern.test(text), `${file} does not say ${claim}: ${String(pattern)}`)
      })
    }
  }

  it('states the refusal for a nameless mutation with the wrong reading it invites', () => {
    for (const file of ['README.md', 'AGENTS.md', 'docs/DOMAIN.md']) {
      const text = prose(file)
      assert.ok(/refus/.test(text), `${file} does not say a nameless mutation is refused`)
      assert.ok(
        /stronger than it is|look checked|be misread/.test(text),
        `${file} states the refusal without the reading it invites`,
      )
    }
  })
})
