// SPDX-License-Identifier: Apache-2.0
// The id-generator seam's two implementations. The sequential one is what makes a golden
// result object and a `--dry-run` diff byte-stable across runs; the random one is what ships.

import { randomBytes } from 'node:crypto'
import type { IdGenerator } from '../application/ports/ids.ts'

/**
 * The largest multiple of 36 below 256. A byte at or above it is discarded rather than
 * folded, because 256 = 7 x 36 + 4 and folding gives four characters eight chances each
 * against the other thirty-two's seven. One byte in 64 is discarded, so a six-character
 * suffix costs 1.10 draws of six bytes on average.
 */
const UNBIASED_CEILING = 252

/**
 * Six base-36 characters, each equally likely: 36^6 = 2,176,782,336 values, and short
 * enough to read back over a phone.
 */
function suffix(): string {
  const chars: string[] = []
  while (chars.length < 6) {
    for (const byte of randomBytes(6)) {
      if (byte >= UNBIASED_CEILING) continue
      chars.push((byte % 36).toString(36))
      if (chars.length === 6) break
    }
  }
  return chars.join('')
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
