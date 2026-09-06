// SPDX-License-Identifier: Apache-2.0
// One store refusal to one error object. The store's own codes are wider than the contract's
// (DR5), so the mapping lives here rather than being repeated per command, and every
// remediation is built from bounded values: a validated id, a guard id from a closed set and
// a literal flag name. No user-supplied free text is ever spliced into a `fix` line (A.6).

import { errorResult, type Effect, type ResultCode, type ResultObject } from '../result.ts'
import type { StoreError } from '../ports/store.ts'

const CODE_OF: Readonly<Record<string, ResultCode>> = {
  VALIDATION: 'VALIDATION',
  GUARD_REFUSED: 'GUARD_REFUSED',
  INTEGRITY: 'INTEGRITY',
  CONFLICT: 'CONFLICT',
  SCHEMA_NEWER: 'STORE_UNAVAILABLE',
  SCHEMA_OLDER: 'STORE_UNAVAILABLE',
  LOCK_TIMEOUT: 'STORE_UNAVAILABLE',
  LOCK_LOST: 'STORE_UNAVAILABLE',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
}

/**
 * Every store refusal here arrives after the workspace opened, so `treadle init` is never a
 * remedy: it answered `already` under a stuck lock and told a person to initialise what they
 * were standing in. A file at a schema this tool does not write is dated against the tool by
 * `version`, which is the one command that runs whatever the store holds; a lock that timed
 * out or was lost is retried, and `status` is the read that says the store is back.
 */
function fixesFor(code: ResultCode, error: StoreError): readonly string[] {
  const entity = error.entities[0]
  if (code === 'CONFLICT' && entity !== undefined) return [`treadle show ${entity}`]
  if (error.code === 'SCHEMA_NEWER' || error.code === 'SCHEMA_OLDER') return ['treadle version']
  if (code === 'STORE_UNAVAILABLE') return ['treadle status']
  if (code === 'INTEGRITY') return ['treadle doctor']
  return []
}

export function storeRefusal(
  command: string, effect: Effect, error: StoreError, workspace: string | undefined,
): ResultObject {
  const code = CODE_OF[error.code] ?? 'INTERNAL'
  const input = {
    code: code as Exclude<ResultCode, 'OK'>,
    command,
    workspace: workspace ?? '-',
    effect,
    rule: error.rule,
    cause: error.message,
    fix: fixesFor(code, error),
  }
  const entity = error.entities[0]
  return errorResult(entity === undefined ? input : { ...input, entity })
}

/**
 * A cursor that names nothing in the list. It used to fall back to the first page, which a
 * caller paging through a list reads as the list starting again.
 */
export function unknownCursor(
  command: string, workspace: string, entity: string, cursor: string, first: string,
): ResultObject {
  return errorResult({
    code: 'VALIDATION', command, workspace, effect: 'read', rule: 'C1', entity,
    cause: `--cursor ${cursor} names nothing in this list; a page line carries the cursor to pass`,
    fix: [first],
  })
}
