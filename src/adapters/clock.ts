// SPDX-License-Identifier: Apache-2.0
// The clock seam's two implementations. The fixed clock is not a test double: every golden
// result object in the suite and every `--dry-run` diff is byte-stable because of it, and
// `--at` reads will run on it too.

import type { Clock } from '../application/ports/clock.ts'
import type { Instant } from '../domain/index.ts'

/** RFC 3339 in UTC to the second (R12); milliseconds carry no meaning any command reads. */
function toInstant(at: Date): Instant {
  return `${at.toISOString().slice(0, 19)}Z`
}

export const systemClock: Clock = {
  now(): Instant {
    return toInstant(new Date())
  },
}

export function fixedClock(at: Instant): Clock {
  return { now: () => at }
}
