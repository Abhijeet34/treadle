// SPDX-License-Identifier: Apache-2.0
// Two floors, because they answer different questions.
//
// `engines.node` in package.json is the supported floor: 24.15.0, where `node:sqlite`
// reaches Stability 1.2 and the index is on a supported API. The hard floor here is what the
// code cannot run at all below: type stripping and `node:sqlite` both arrive in 24.0.0.
// Between the two the tool runs and says nothing, because a warning on every invocation
// would reach stderr on every call and R9 keeps stderr for the error object.

export const DECLARED_FLOOR = '24.15.0'
export const HARD_FLOOR = '24.0.0'

function parts(version: string): readonly number[] {
  return version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function isBelow(version: string, floor: string): boolean {
  const left = parts(version)
  const right = parts(floor)
  for (let i = 0; i < 3; i += 1) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    if (a !== b) return a < b
  }
  return false
}

export type RuntimeCheck = { readonly ok: true } | { readonly ok: false; readonly cause: string }

export function checkRuntime(version: string): RuntimeCheck {
  if (!isBelow(version, HARD_FLOOR)) return { ok: true }
  return {
    ok: false,
    cause: `treadle needs Node ${HARD_FLOOR} or newer and this is ${version}; the supported floor is ${DECLARED_FLOOR}`,
  }
}
