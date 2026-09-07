// SPDX-License-Identifier: Apache-2.0
// Why a test does not run on this platform, in one place, so a skip carries a reason a reader
// can check rather than a bare `process.platform` comparison scattered through the suites.
//
// None of these names a gap in the tool. Each names a filesystem or process primitive whose
// semantics Windows does not have, in a test whose whole subject is that primitive. Measured
// on windows-2025 in cross-platform run 34110894767: of 62 failures, 30 were a CRLF checkout
// (now `.gitattributes`), one was a real defect (the index handle a failed open left behind),
// and the rest were tests asserting POSIX semantics on a platform that has none.
//
// A skip is the last resort here, not the first. Where the invariant can be expressed in what
// Windows does have, it is: `dropIndex` in `store-fixtures.ts` deletes between two opens
// rather than under a live handle, and the path assertions compare through `node:path` rather
// than against a literal separator.

const WINDOWS = process.platform === 'win32'

/**
 * `chmod` on Windows sets one read-only flag and nothing else; `stat().mode` reads back 0o666
 * or 0o444 whatever was asked for, and a directory's write bit cannot be cleared at all. A
 * test that tightens a mode and reads it back, or that makes a directory unwritable to reach
 * an `EACCES` path, is measuring a POSIX primitive.
 */
export const POSIX_MODES: string | false = WINDOWS
  ? 'Windows has no POSIX mode bits: chmod sets a read-only flag and stat reads back 0o666'
  : false

/**
 * `SIGSTOP` and `SIGCONT` do not exist on Windows, and a signal to a process the caller does
 * not own answers differently, so a test that pauses a writer inside its critical section or
 * reads `EPERM` as proof of life has nothing to run.
 */
export const POSIX_SIGNALS: string | false = WINDOWS
  ? 'Windows has no SIGSTOP or SIGCONT, and no EPERM from a signal to a live process'
  : false

/**
 * Windows resolves a symbolic link before `O_CREAT | O_EXCL` decides, so an open at a dangling
 * link creates the link's target instead of failing `EEXIST`. F9's first defence, a temp name
 * of 96 random bits, is what carries the finding there; the exclusive open is the belt, and
 * the belt is POSIX's.
 */
export const POSIX_SYMLINKS: string | false = WINDOWS
  ? 'Windows follows a dangling symlink through an exclusive create rather than failing EEXIST'
  : false
