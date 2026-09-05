// SPDX-License-Identifier: Apache-2.0
// Exit status, computed from the result object's `code` field by one table, on every verb,
// with no per-command flag surface (R3). A caller that branches on status therefore never
// has to know which command it ran.

import type { ResultCode, ResultObject } from '../application/result.ts'

export const EXIT_OF: Readonly<Record<ResultCode, number>> = {
  OK: 0,
  INTERNAL: 1,
  VALIDATION: 2,
  GUARD_REFUSED: 3,
  CONFLICT: 4,
  NOT_FOUND: 5,
  STORE_UNAVAILABLE: 6,
  INTEGRITY: 7,
}

/** Interrupted by SIGINT, after the lock is released. */
export const EXIT_INTERRUPTED = 130

export function exitFor(result: ResultObject): number {
  return EXIT_OF[result.code]
}
