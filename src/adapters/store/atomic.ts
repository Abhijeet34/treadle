// SPDX-License-Identifier: Apache-2.0
// DR4's durability boundary, with threat-model finding F9 fixed rather than recorded.
//
// The design's temp name was `<file>.tmp.<pid>`, which is guessable from the target path
// and a process id, and DR4 stated exclusive creation for the lock and not for the temp
// file. A co-tenant who can write the workspace directory can pre-place that name as a
// symlink and the write follows it. Here the suffix is 96 bits from `node:crypto` and the
// open is `wx`, so a pre-placed path is a create failure and never a redirected write.
//
// The boundary itself is unchanged from DR4: fsync then rename, no `F_FULLFSYNC` and no
// directory fsync, so a power loss inside the last write may lose that write and can never
// leave a torn file.

import { randomBytes } from 'node:crypto'
import { open, readdir, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

/** Project data, not secret (F9's own reading): the exclusive create is the control. */
export const FILE_MODE = 0o644
export const DIR_MODE = 0o755

/** The window a crashed writer's temp file survives before the next lock holder sweeps it. */
export const TEMP_SWEEP_MS = 60 * 60 * 1000

const TEMP_MARK = '.tmp.'

export function isTempName(name: string): boolean {
  return name.startsWith('.') && name.includes(TEMP_MARK)
}

/** Unpredictable by construction: 12 random bytes, not a pid. Hidden so a scan skips it. */
export function tempNameFor(target: string): string {
  const dir = path.dirname(target)
  const base = path.basename(target)
  return path.join(dir, `.${base}${TEMP_MARK}${randomBytes(12).toString('hex')}`)
}

/**
 * The F9 control itself, in one place because both the temp file and the lock depend on it.
 * `wx` is `O_CREAT | O_EXCL`, which fails on anything already at the path including a
 * dangling symlink, so a pre-placed name is an EEXIST error and never a redirected write.
 */
export function openExclusive(target: string, mode: number): Promise<FileHandle> {
  return open(target, 'wx', mode)
}

/**
 * Writes by exclusive-create, fsync and rename. The temp file is created 0o600 so its
 * contents are never briefly world-readable, and takes the target's own mode if the target
 * exists, so a workspace that tightened its permissions keeps them.
 *
 * `beforeCommit` runs after the fsync and before the rename, which is the commit. The
 * store asks the lock there: the fsync is milliseconds and the rename microseconds, so a
 * check ahead of the whole write left a window a paused holder was measured landing in.
 */
export async function writeFileAtomic(
  target: string, contents: string, beforeCommit?: () => Promise<void>,
): Promise<void> {
  const temp = tempNameFor(target)
  const mode = await modeOf(target)
  const handle = await openExclusive(temp, 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.chmod(mode)
  } finally {
    await handle.close()
  }
  try {
    if (beforeCommit !== undefined) await beforeCommit()
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

async function modeOf(target: string): Promise<number> {
  try {
    return (await stat(target)).mode & 0o777
  } catch {
    return FILE_MODE
  }
}

/**
 * Appends to the event log and fsyncs. An append under the store lock is not a rewrite, so
 * temp-and-rename would cost O(file) to add O(line); the durability boundary is the same
 * fsync, and DR2's index tail rule depends on the prefix bytes staying put.
 */
export async function appendAndSync(target: string, contents: string): Promise<void> {
  const handle = await open(target, 'a', FILE_MODE)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** DR4: the next lock holder removes a temp file a crashed writer left behind. */
export async function sweepTempFiles(dir: string, olderThanMs = TEMP_SWEEP_MS): Promise<number> {
  let removed = 0
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - olderThanMs
  for (const name of names) {
    if (!isTempName(name)) continue
    const full = path.join(dir, name)
    try {
      if ((await stat(full)).mtimeMs < cutoff) {
        await unlink(full)
        removed += 1
      }
    } catch {
      continue
    }
  }
  return removed
}
