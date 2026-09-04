// SPDX-License-Identifier: Apache-2.0
// One error shape for the whole domain layer, and a Result so a refusal is a value
// rather than a thrown exception. The code set is the one the output contract maps to an
// exit status; the rule id is what an error names so a caller can look it up instead of
// reading the sentence. docs/DOMAIN.md carries the rule table.

export const DOMAIN_ERROR_CODES = ['VALIDATION', 'GUARD_REFUSED', 'INTEGRITY'] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

export type DomainError = {
  readonly code: DomainErrorCode
  /** A rule id from the closed set in docs/DOMAIN.md, for example `G2`, `T1`, `V4`. */
  readonly rule?: string
  /** One sentence naming the entity and the observed value, never a restatement of the code. */
  readonly message: string
  readonly entities: readonly string[]
  readonly details?: Readonly<Record<string, string | number>>
}

export type Success<T> = { readonly ok: true; readonly value: T }
export type Failure = { readonly ok: false; readonly error: DomainError }
export type Result<T> = Success<T> | Failure

export function ok<T>(value: T): Success<T> {
  return { ok: true, value }
}

export function fail(
  code: DomainErrorCode,
  rule: string,
  message: string,
  entities: readonly string[],
  details?: Readonly<Record<string, string | number>>,
): Failure {
  return { ok: false, error: details === undefined
    ? { code, rule, message, entities }
    : { code, rule, message, entities, details } }
}
