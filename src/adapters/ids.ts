// SPDX-License-Identifier: Apache-2.0
// The id-generator seam's two implementations. The sequential one is what makes a golden
// result object and a `--dry-run` diff byte-stable across runs; the random one is what ships.

import { randomInt } from 'node:crypto'
import type { IdGenerator } from '../application/ports/ids.ts'

/**
 * Six base-36 characters, each equally likely: 36^6 = 2,176,782,336 values, and short enough
 * to read back over a phone. `randomInt` rather than `byte % 36` over `randomBytes`, because
 * 256 = 7 x 36 + 4 and folding gives four of the characters eight byte values each against
 * the other thirty-two's seven, which is CodeQL's `js/biased-cryptographic-random`. The
 * runtime already rejection-samples for this, so the fix is to ask it rather than write one.
 */
function suffix(): string {
  return Array.from({ length: 6 }, () => randomInt(36).toString(36)).join('')
}

export const randomIds: IdGenerator = {
  txn: () => `t${suffix()}`,
  event: () => `e${suffix()}`,
}

export function sequentialIds(start = 1): IdGenerator {
  let txns = start
  let events = start
  return {
    txn: () => `t${String(txns++).padStart(4, '0')}`,
    event: () => `e${String(events++).padStart(4, '0')}`,
  }
}
