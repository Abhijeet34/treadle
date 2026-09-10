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

/** Every errno the store cannot act on: the path is unreachable, unwritable, or the disk is full. */
const FILESYSTEM = 'make the path named in cause readable and writable by this user, and check its filesystem for space'

/**
 * A store file that is damaged, gone, or past a ceiling. Records and the event log are files
 * this store commits, which is what makes git the remedy that always exists; no command here
 * splits a file, repairs a heading or writes one back.
 */
const RESTORE = 'the store file named in cause is damaged, missing or past a ceiling, and no command here repairs it; repair it by hand or restore it from git'

/**
 * The remedy for one way the store is unavailable, keyed by the rule the store raised.
 *
 * Every one of these was `treadling status` before, and `status` is a read: it never takes the
 * lock, it does not look in `.txn`, and it answered `ok findings 0` over a workspace that
 * refused every write. So a caller following the fix line looped while the remedy sat in the
 * `cause` sentence it was not told to act on. A line here is either runnable as written or
 * says in words what a person must do, and it is never a read that reports success.
 *
 * A filename cannot be spliced into one of these (A.6): a directory entry may hold a space, a
 * quote or a `;`, so `rm <that name>` would be a line that runs something other than what it
 * reads as. The `cause` names the file, and these lines point at it there.
 */
export function unavailableFixes(
  error: Pick<StoreError, 'code' | 'rule' | 'details'>,
): readonly string[] {
  // Only `version` runs whatever the store holds, so it is the one command that dates a file
  // at a schema this build does not write against the build that refused it.
  if (error.code === 'SCHEMA_NEWER' || error.code === 'SCHEMA_OLDER') return ['treadling version']
  if (error.code === 'LOCK_LOST') {
    return ['re-run the command; the cause says whether the transaction was journaled before the lock went']
  }
  if (error.rule === 'S11') {
    // A lock that timed out is waited on again; a lock that could not be created at all is an
    // errno, and shares its remedy with every other errno below.
    return error.code === 'LOCK_TIMEOUT'
      ? ['re-run the command; if the cause says the holder is stuck, end that process and delete the .lock file it names']
      : [FILESYSTEM]
  }
  if (error.rule === 'S13') {
    return error.details?.['journal'] === undefined
      ? [FILESYSTEM]
      : ['delete the .txn file named in cause; read it first, because the store will not discard it on a guess']
  }
  // `S1` is a file this tool did not write, or one that is not there at all; `S4`, `S6` and
  // `S7` are a file past a ceiling. No command here repairs any of the four, and all four are
  // files this store commits, so the one remedy that always exists is the copy in git.
  if (error.rule === 'S1' || error.rule === 'S4' || error.rule === 'S6' || error.rule === 'S7') {
    return [RESTORE]
  }
  return []
}

/**
 * Every store refusal here arrives after the workspace opened, so `treadling init` is never a
 * remedy: it answered `already` under a stuck lock and told a person to initialise what they
 * were standing in. That is why `unavailableFixes` never offers it, and why the open path in
 * `src/cli/main.ts`, which is the one place `init` is the answer, decides that case itself
 * before falling back here.
 */
function fixesFor(code: ResultCode, error: StoreError): readonly string[] {
  const entity = error.entities[0]
  if (code === 'CONFLICT' && entity !== undefined) return [`treadling show ${entity}`]
  if (code === 'STORE_UNAVAILABLE') return unavailableFixes(error)
  if (code === 'INTEGRITY') return ['treadling doctor']
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
