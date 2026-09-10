// SPDX-License-Identifier: Apache-2.0
// Two floors, because they answer different questions.
//
// `engines.node` in package.json is the supported floor: 24.15.0. It is a support statement
// rather than a capability claim: nothing here needs an API newer than 24.0. It is what
// `.nvmrc` pins, what the first CI leg runs, and what the runtime `@types/node` is held not
// to outrun (test/architecture/supply-chain.test.ts).
//
// The hard floor is what running this repository from its TypeScript sources needs, which
// the test suite and the benchmark rig both do: type stripping without a flag, from 24.0.0.
// The shipped bundle is plain JavaScript and needs nothing newer than
// `module.enableCompileCache`, which arrived in 22.1.0 and is called optionally, so no
// measurement supports a hard floor lower than this one and none is claimed.
//
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

export type RuntimeCheck = { readonly ok: true }
  | { readonly ok: false; readonly cause: string; readonly fix: readonly string[] }

export function checkRuntime(version: string): RuntimeCheck {
  if (!isBelow(version, HARD_FLOOR)) return { ok: true }
  return {
    ok: false,
    cause: `treadling needs Node ${HARD_FLOOR} or newer and this is ${version}; the supported floor is ${DECLARED_FLOOR}`,
    // The refusal is `STORE_UNAVAILABLE` like the store's own, and it used to be the one in
    // that class carrying no `fix` at all. Both floors are compiled in, so the line is built
    // from bounded values; which installer to use is the reader's, and naming one would be a
    // line most readers cannot run.
    fix: [`install Node ${DECLARED_FLOOR} or newer, then re-run the command`],
  }
}
