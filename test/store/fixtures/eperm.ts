// SPDX-License-Identifier: Apache-2.0
// A separate process, because the substitution in `eperm-open.ts` has to be registered before
// `lock.ts` is loaded and the test runner has already loaded it.
//
// Usage: TREADLING_EPERM=pending:<n>|refusing node eperm.ts <lock path>

import { register } from 'node:module'

register(new URL('./eperm-open.ts', import.meta.url))

const { acquireLock } = await import('../../../src/adapters/store/lock.ts')

const started = Date.now()
const result = await acquireLock(process.argv[2] as string, { timeoutMs: 4_000 })
process.stdout.write(JSON.stringify(
  result.ok
    ? { ok: true, waited: Date.now() - started }
    : { ok: false, code: result.error.code, rule: result.error.rule, message: result.error.message, waited: Date.now() - started },
))
if (result.ok) await result.value.release()
