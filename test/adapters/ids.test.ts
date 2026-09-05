// SPDX-License-Identifier: Apache-2.0
// The random suffix has to be uniform over its alphabet, and the way to get that wrong is
// cheap and invisible: `byte % 36` over a random byte, which CodeQL flagged here as
// `js/biased-cryptographic-random`. 256 = 7 x 36 + 4, so four characters get eight of the
// 256 byte values and the other thirty-two get seven, a 14.3% lift on those four.
//
// A chi-squared test over the observed character frequencies is what separates the two
// implementations, because the bias is far too small to see in a spot check and far too
// large to survive a statistic taken over enough characters.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { randomIds, sequentialIds } from '../../src/adapters/ids.ts'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const SUFFIX_LENGTH = 6

/** 100,000 ids is 600,000 characters, and takes about a second. */
const SAMPLE_IDS = 100_000

/**
 * The null distribution has 35 degrees of freedom, so a uniform generator scores 35 on
 * average with a standard deviation of 8.4; 120 is ten deviations out and P(X > 120) is
 * about 1e-11, which is the flake budget. The biased implementation scores about 1,207 at
 * this sample size, because its expected statistic is 35 + 600,000 x 0.001953. The gap
 * between 120 and 1,207 is what makes this test decide rather than hint.
 */
const CHI_SQUARED_CEILING = 120

function chiSquaredOverCharacters(mint: () => string): { statistic: number, characters: number } {
  const counts = new Map<string, number>(ALPHABET.split('').map((character) => [character, 0]))
  for (let index = 0; index < SAMPLE_IDS; index += 1) {
    for (const character of mint().slice(1)) {
      counts.set(character, (counts.get(character) ?? 0) + 1)
    }
  }
  const characters = SAMPLE_IDS * SUFFIX_LENGTH
  const expected = characters / ALPHABET.length
  let statistic = 0
  for (const count of counts.values()) {
    statistic += ((count - expected) ** 2) / expected
  }
  return { statistic, characters }
}

describe('the random id suffix is uniform over its alphabet', () => {
  it(`scores under ${CHI_SQUARED_CEILING} on a chi-squared test over ${SAMPLE_IDS * SUFFIX_LENGTH} characters`, (t) => {
    const { statistic, characters } = chiSquaredOverCharacters(randomIds.txn)
    t.diagnostic(`chi-squared ${statistic.toFixed(1)} over ${characters} characters, 35 degrees of freedom, ceiling ${CHI_SQUARED_CEILING}`)
    assert.ok(
      statistic < CHI_SQUARED_CEILING,
      `chi-squared ${statistic.toFixed(1)} over ${characters} characters exceeds ${CHI_SQUARED_CEILING}: the suffix alphabet is not uniform`,
    )
  })

  it('mints the shape the store and the event log expect, from both generators', () => {
    for (let index = 0; index < 1_000; index += 1) {
      assert.match(randomIds.txn(), /^t[0-9a-z]{6}$/)
      assert.match(randomIds.event(), /^e[0-9a-z]{6}$/)
    }
    const sequential = sequentialIds()
    assert.equal(sequential.txn(), 't0001')
    assert.equal(sequential.event(), 'e0001')
    assert.equal(sequential.txn(), 't0002')
  })
})
