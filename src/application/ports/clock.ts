// SPDX-License-Identifier: Apache-2.0
// The clock seam (DR6). The domain takes an instant as an argument, so this is the one
// place a use case gets one from. Two implementations ship: the system clock, and a fixed
// clock that every golden result object and every `--dry-run` diff in the suite runs under.

import type { Instant } from '../../domain/index.ts'

export interface Clock {
  /** RFC 3339 in UTC, seconds precision, `Z` suffix (R12). */
  now(): Instant
}
