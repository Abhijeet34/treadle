// SPDX-License-Identifier: Apache-2.0
// The id-generator seam's two implementations. The sequential one is what makes a golden
// result object and a `--dry-run` diff byte-stable across runs; the random one is what ships.

import { randomBytes } from 'node:crypto'
import type { IdGenerator } from '../application/ports/ids.ts'

/** Six base-36 characters: 2.2 billion values, and short enough to read back over a phone. */
function suffix(): string {
  return [...randomBytes(6)].map((byte) => (byte % 36).toString(36)).join('')
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
