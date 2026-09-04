// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F6. The record field-key grammar is `[a-z_][a-z0-9_]*`, and
// `__proto__`, `constructor` and `prototype` all match it, so a committed file or a merge
// can hand the parser one of them as an ordinary-looking field name.
//
// Two controls, because either alone is one mistake away from failing. A record is a Map,
// which has no prototype chain to poison, and the three keys are refused by name on load
// so a later refactor to a plain object cannot silently reopen the hole.

import { fail, ok, type Failure, type Result } from './errors.ts'

/** DR3's key grammar. Bounded and linear: no nested quantifier, so it cannot backtrack. */
export const FIELD_KEY_PATTERN = /^[a-z_][a-z0-9_]*$/

export const FORBIDDEN_FIELD_KEYS = ['__proto__', 'constructor', 'prototype'] as const

export function isForbiddenFieldKey(key: string): boolean {
  return (FORBIDDEN_FIELD_KEYS as readonly string[]).includes(key)
}

function checkKey(key: string): Failure | undefined {
  if (isForbiddenFieldKey(key)) {
    return fail(
      'VALIDATION',
      'V2',
      `the field key ${key} is refused because it names a JavaScript prototype slot`,
      [key],
    )
  }
  if (!FIELD_KEY_PATTERN.test(key)) {
    return fail(
      'VALIDATION',
      'V1',
      `the field key ${key} does not match the record grammar ${FIELD_KEY_PATTERN.source}`,
      [key],
    )
  }
  return undefined
}

/**
 * The one door parsed input walks through into the domain core. Every caller that turns
 * a file into fields uses this rather than indexing an object by a key it just read.
 */
export function buildRecord(
  entries: Iterable<readonly [string, string]>,
): Result<ReadonlyMap<string, string>> {
  const record = new Map<string, string>()
  for (const [key, value] of entries) {
    const bad = checkKey(key)
    if (bad !== undefined) return bad
    if (record.has(key)) {
      return fail(
        'VALIDATION',
        'V3',
        `the field key ${key} appears twice in one record`,
        [key],
      )
    }
    record.set(key, value)
  }
  return ok(record)
}

/** The same check for a record that already exists, which is the load-time half of F6. */
export function validateFieldKeys(record: ReadonlyMap<string, string>): Result<undefined> {
  for (const key of record.keys()) {
    const bad = checkKey(key)
    if (bad !== undefined) return bad
  }
  return ok(undefined)
}
