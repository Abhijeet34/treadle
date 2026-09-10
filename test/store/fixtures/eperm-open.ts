// SPDX-License-Identifier: Apache-2.0
// Makes an exclusive create answer EPERM, which is what Windows answers where POSIX answers
// EEXIST and is the only reason this file exists: the occurrence is Windows-only, the
// behaviour under that errno is not, and a lock this safety-critical earns a test that fails
// on demand rather than one that fails on a runner three times out of five.
//
// It is both halves of one substitution. `resolve` runs in the loader thread and points
// `lock.ts`'s import of `./atomic.ts` at this file; `openExclusive` is what `lock.ts` then
// calls. The redirect is scoped to that one importer, so every other user of `atomic.ts` -
// `writeFileAtomic` included - keeps the real one.
//
// TREADLE_EPERM says which situation to model:
//   pending:<n>  the lock path answers EPERM for the next <n> creates, the directory
//                accepts every other name. Windows, a lock file being released.
//   refusing     every create in the directory answers EPERM. A read-only mount, a denied
//                ACL: nothing here will ever hold a lock.

import type { FileHandle } from 'node:fs/promises'

import { openExclusive as real } from '../../../src/adapters/store/atomic.ts'

// The redirect replaces `atomic.ts` whole for `lock.ts`, so everything else it imports from
// there has to come back out of here unchanged.
export { tempNameFor } from '../../../src/adapters/store/atomic.ts'

type Resolved = { url: string; shortCircuit?: boolean; format?: string }
type Next = (specifier: string, context: { parentURL?: string }) => Resolved | Promise<Resolved>

export function resolve(
  specifier: string, context: { parentURL?: string }, next: Next,
): Resolved | Promise<Resolved> {
  if (specifier.endsWith('/atomic.ts') && context.parentURL?.endsWith('/lock.ts') === true) {
    return { url: import.meta.url, shortCircuit: true }
  }
  return next(specifier, context)
}

const [situation, budget] = (process.env['TREADLE_EPERM'] ?? '').split(':')
let remaining = Number(budget ?? 0)

/** The errno and message Node raises on Windows, verbatim from the transcript. */
function eperm(target: string): NodeJS.ErrnoException {
  const error = new Error(`EPERM: operation not permitted, open '${target}'`) as NodeJS.ErrnoException
  error.code = 'EPERM'
  error.errno = -1
  error.syscall = 'open'
  error.path = target
  return error
}

export function openExclusive(target: string, mode: number): Promise<FileHandle> {
  if (situation === 'refusing') return Promise.reject(eperm(target))
  if (situation === 'pending' && target.endsWith('.lock') && remaining > 0) {
    remaining -= 1
    return Promise.reject(eperm(target))
  }
  return real(target, mode)
}
