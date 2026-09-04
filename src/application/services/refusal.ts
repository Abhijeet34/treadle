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
  INTEGRITY: 'STORE_UNAVAILABLE',
  CONFLICT: 'CONFLICT',
  SCHEMA_NEWER: 'STORE_UNAVAILABLE',
  SCHEMA_OLDER: 'STORE_UNAVAILABLE',
  LOCK_TIMEOUT: 'STORE_UNAVAILABLE',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
}

function fixesFor(code: ResultCode, error: StoreError): readonly string[] {
  const entity = error.entities[0]
  if (code === 'CONFLICT' && entity !== undefined) return [`treadle show ${entity}`]
  if (code === 'STORE_UNAVAILABLE') return ['treadle init', 'treadle status']
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
