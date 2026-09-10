// SPDX-License-Identifier: Apache-2.0
// DR4's store-wide advisory lock: exclusive create, a heartbeat while held, and reclaim on
// proof of death or a stopped heartbeat.
//
// The reference's mistake, designed out: it ran a fixed 2.5 second acquisition budget and
// refused three of twelve serialised 300 millisecond writers. There is no total budget here.
// A waiter waits for as long as the lock keeps changing hands; the things that end a wait are
// the holder finishing, the holder dying, its heartbeat stopping, or - `holderTimeoutMs` -
// one holder keeping it that long without ever letting go. `timeoutMs`, a bound on the whole
// wait, exists for a caller that explicitly wants one and is absent by default.
//
// The distinction is what keeps the reference's failure out. A total budget refuses honest
// contention, which resolves itself: twelve serialised 300 ms writers spend 4.17 seconds
// waiting and every one of them should be served. A per-holder budget refuses only a lock
// that has not moved, which does not resolve itself: measured on this store, a live holder
// heartbeating every 500 ms held a second command silent past 20 seconds with nothing
// printed and no bound to reach. A critical section here is milliseconds, so a holder past
// the budget is stuck rather than busy, and saying so beats waiting forever.
//
// What counts as contention is an errno, and POSIX and Windows disagree about which one. POSIX
// answers an exclusive create over a file that exists with EEXIST. Windows answers
// ERROR_ACCESS_DENIED while the target is delete-pending, which is the state a lock file is in
// from the moment its holder's unlink is issued until the last handle on it closes, and libuv
// maps that to EPERM. So a Windows waiter meets EPERM where a POSIX waiter meets EEXIST, for
// the same situation. ADR-0036 carries the two sources and the measurement.
//
// EPERM cannot simply be retried: a read-only mount and a denied ACL answer it too, and
// retrying those waits forever on a store that will never hold a lock. The discriminator is
// the directory rather than the lock file: delete-pending ends when the last handle closes,
// so whether the file is still there when a question about it is answered is a race with no
// lower bound, and a directory's answer is not a race at all.
//
// Liveness alone is not enough, which is why the heartbeat exists: a process paused in a
// debugger answers `kill(pid, 0)` forever, while its heartbeat timer, which runs on the
// event loop, stops with it. `EPERM` from `kill` means alive and outside our reach, never
// dead; treating it as death is how a store reclaims a lock somebody is holding.
//
// A reclaim has a second half. The paused holder resumes one day, and from its own point of
// view it still holds the lock: it wrote a shard from a parse it took before the pause and
// overwrote the reclaimer's write, measured as one lost update in 117 (`Ctrl-Z` for six
// seconds is enough). So the handle knows when it has been reclaimed, from either side: a
// gap between two heartbeats longer than the stale window means a waiter was entitled to
// take it, whether or not one did, and a token on disk that is not ours means one did. A
// write asks `held()` before every byte it commits, and a lost lock is a refusal rather
// than a write.

import { hostname } from 'node:os'
import { readFile, stat, unlink, utimes } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import { storeFail, storeOk, type StoreResult } from '../../application/ports/store.ts'
import { openExclusive, tempNameFor } from './atomic.ts'

const HEARTBEAT_MS = 200
const STALE_MS = 5_000
const RETRY_MIN_MS = 5
const RETRY_MAX_MS = 25
const NOTE_AFTER_MS = 1_000

export type LockToken = {
  readonly pid: number
  readonly host: string
  readonly since: string
  /** Distinguishes two holders that reuse one pid, so a reclaim can never steal a lock. */
  readonly nonce: string
}

export type LockHandle = {
  readonly token: LockToken
  /**
   * Whether this process still holds the lock. False once a heartbeat gap exceeded the
   * stale window, or once the file carries another holder's token; both are final.
   */
  held(): Promise<boolean>
  release(): Promise<void>
}

export type AcquireOptions = {
  /** Absent means no budget over the whole wait, which is the default and the point. */
  readonly timeoutMs?: number
  /**
   * How long one unchanging holder may hold the lock before a waiter refuses. Absent means
   * without bound; the token's bytes are the identity, so a lock that changes hands resets
   * this and serialised writers are never refused by it.
   */
  readonly holderTimeoutMs?: number
  /** Called once, after a second of waiting, with the holder a caller may want to report. */
  readonly onWaiting?: (token: LockToken | undefined, waitedMs: number) => void
  readonly heartbeatMs?: number
  readonly staleMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** ESRCH is death. EPERM is a live process this process may not signal. */
export function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function parseToken(text: string): LockToken | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (typeof raw['pid'] !== 'number' || typeof raw['host'] !== 'string') return undefined
    if (typeof raw['since'] !== 'string' || typeof raw['nonce'] !== 'string') return undefined
    return { pid: raw['pid'], host: raw['host'], since: raw['since'], nonce: raw['nonce'] }
  } catch {
    return undefined
  }
}

export async function acquireLock(
  path: string,
  options: AcquireOptions = {},
): Promise<StoreResult<LockHandle>> {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const staleMs = options.staleMs ?? STALE_MS
  const started = Date.now()
  let noted = false
  // The token's bytes, not its pid: a heartbeat only touches the mtime, so these are stable
  // while one holder holds and different the moment the lock changes hands.
  let holder: string | undefined
  let holderSince = started

  for (;;) {
    const token: LockToken = {
      pid: process.pid,
      host: hostname(),
      since: new Date().toISOString(),
      nonce: randomBytes(8).toString('hex'),
    }
    const body = JSON.stringify(token)

    try {
      const handle = await openExclusive(path, 0o600)
      try {
        await handle.writeFile(body, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      return storeOk(held(path, token, body, heartbeatMs, staleMs))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && !(code === 'EPERM' && await directoryTakesAFile(path))) {
        return storeFail('STORE_UNAVAILABLE', 'S11', `the lock ${path} could not be created: ${(error as Error).message}`, [path])
      }
    }

    const waited = Date.now() - started
    // One read of the token serves the three judgements below, so a waiter reads the file
    // once per attempt rather than once per question.
    const current = await readFile(path, 'utf8').catch(() => undefined)
    if (current !== holder) {
      holder = current
      holderSince = Date.now()
    }

    if (options.timeoutMs !== undefined && waited >= options.timeoutMs) {
      return notAcquired(path, parseToken(current ?? ''), `was not acquired within ${options.timeoutMs} ms`, waited)
    }
    if (!noted && waited >= NOTE_AFTER_MS && options.onWaiting !== undefined) {
      noted = true
      options.onWaiting(parseToken(current ?? ''), waited)
    }
    const holdingFor = Date.now() - holderSince
    if (options.holderTimeoutMs !== undefined && current !== undefined && holdingFor >= options.holderTimeoutMs) {
      return notAcquired(
        path, parseToken(current),
        `has not changed hands in ${holdingFor} ms, past the ${options.holderTimeoutMs} ms a holder is given; a transaction here takes milliseconds, so that holder is stuck rather than busy`,
        waited,
      )
    }

    await reclaimIfAbandoned(path, staleMs)
    await sleep(RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS)))
  }
}

/**
 * Whether the directory holding the lock will take a file at all, which is the question an
 * EPERM from the exclusive create leaves open. The name is the temp convention's 96 random
 * bits, so nothing contends for it and the answer is about the directory and nothing else; a
 * later lock holder's `sweepTempFiles` removes one a process died beside.
 */
async function directoryTakesAFile(lockPath: string): Promise<boolean> {
  const probe = tempNameFor(lockPath)
  try {
    await (await openExclusive(probe, 0o600)).close()
  } catch {
    return false
  } finally {
    await unlink(probe).catch(() => undefined)
  }
  return true
}

/** A wait that ended without the lock, naming the holder whenever the token can be read. */
function notAcquired(
  path: string, holder: LockToken | undefined, what: string, waited: number,
): StoreResult<never> {
  return storeFail(
    'LOCK_TIMEOUT', 'S11',
    holder === undefined
      ? `the lock ${path} ${what}`
      : `the lock ${path} is held by pid ${holder.pid} on ${holder.host} since ${holder.since}, and ${what}`,
    [path],
    { waitedMs: waited },
  )
}

/**
 * Removes a lock whose holder is provably gone or has stopped heartbeating. The unlink is
 * guarded by re-reading the token and comparing it byte for byte, so a lock that changed
 * hands between the judgement and the unlink is never stolen from its new holder.
 */
async function reclaimIfAbandoned(path: string, staleMs: number): Promise<void> {
  let before: string
  let mtimeMs: number
  try {
    before = await readFile(path, 'utf8')
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    return
  }
  const token = parseToken(before)
  const dead = token !== undefined && token.host === hostname() && processIsGone(token.pid)
  const silent = Date.now() - mtimeMs > staleMs
  if (!dead && !silent) return

  const after = await readFile(path, 'utf8').catch(() => undefined)
  if (after !== before) return
  await unlink(path).catch(() => undefined)
}

function held(
  path: string, token: LockToken, body: string, heartbeatMs: number, staleMs: number,
): LockHandle {
  let lastBeat = Date.now()
  let lost = false

  // A stall is judged against the same window a waiter judges it against, from this side:
  // if this process could not beat for `staleMs`, a waiter was entitled to reclaim, and
  // touching the file now would only make the reclaimer's token look fresh.
  const stalled = (): boolean => {
    if (!lost && Date.now() - lastBeat > staleMs) lost = true
    return lost
  }

  const beat = setInterval(() => {
    if (stalled()) { clearInterval(beat); return }
    lastBeat = Date.now()
    const now = new Date()
    void utimes(path, now, now).catch(() => undefined)
  }, heartbeatMs)
  beat.unref()

  let released = false
  return {
    token,
    async held(): Promise<boolean> {
      if (released || stalled()) return false
      const current = await readFile(path, 'utf8').catch(() => undefined)
      if (current !== body) lost = true
      return !lost
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      clearInterval(beat)
      const current = await readFile(path, 'utf8').catch(() => undefined)
      if (current === body) await unlink(path).catch(() => undefined)
    },
  }
}
