// SPDX-License-Identifier: Apache-2.0
// Exit status, computed from the result object's `code` field by one table, on every verb,
// with no per-command flag surface (R3). A caller that branches on status therefore never
// has to know which command it ran.
//
// The table itself lives in `src/application/result.ts`, beside the codes it is keyed by, so
// that `--contract` can print it: the renderer is an adapter and may not reach this layer,
// and a second copy of the table there is a copy that can drift from the status the process
// actually returns. This file is where the command layer reads it from.

import { EXIT_OF, type ResultObject } from '../application/result.ts'

export { EXIT_INTERRUPTED, EXIT_OF } from '../application/result.ts'

export function exitFor(result: ResultObject): number {
  return EXIT_OF[result.code]
}
