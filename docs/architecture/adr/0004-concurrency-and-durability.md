# ADR-0004: One advisory lock with a heartbeat, exclusive-create atomic writes, and per-record compare-and-set

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** DR4 of the system design record, under decision D2

## Context

The concurrency this tool guarantees is several processes plus a human editor on one machine, with no lost writes and no wedging on a dead holder.
Sharing between machines is git on the committed files, not a shared store.

The reference implementation ran a fixed 2.5 second acquisition budget and refused three of twelve serialised 300 millisecond writers.
Turning contention into a refusal is the specific failure being designed out.

## Decision

### The lock

`<workspace>/.lock` is created with `O_CREAT | O_EXCL` holding `{pid, host, since, nonce}`.
The holder refreshes the file's mtime every 200 ms.
A waiter loops: try the exclusive create; on `EEXIST` read the token and its mtime; reclaim when the pid is provably gone or the heartbeat is older than 5 seconds; otherwise sleep 5 to 25 ms with jitter and retry.

There is no acquisition budget.
A waiter waits for as long as the holder is alive and heartbeating, and the only things that end a wait are the holder finishing, the holder dying, or its heartbeat stopping.
`onWaiting` fires once after a second so a caller can print a note; a caller that explicitly wants a bound passes `timeoutMs` and gets `LOCK_TIMEOUT` (`S11`) naming the holder.

Two rules that a wrong guess cannot undo.

- **`EPERM` from `kill(pid, 0)` means alive**, not dead. Only `ESRCH` is proof of death, and a pid is only judged at all when the token's host matches this one.
- **Liveness alone is not enough.** A process paused in a debugger answers `kill(pid, 0)` forever, while its heartbeat timer, which runs on the event loop, stops with it. The stale-heartbeat rule reclaims from a wedged holder in 5 seconds and never from a working one, because the critical section is milliseconds and no hook runs inside it.

The unlink that reclaims is guarded by re-reading the token and comparing it byte for byte, so a lock that changed hands between the judgement and the unlink is never stolen from its new holder.

### Measured, with separate processes

`test/store/lock.test.ts` runs real child processes, because the guarantee is about processes and an in-process race would prove nothing.

| Scenario | Result |
|---|---|
| 24 separate processes each doing a read-modify-write on one record | 24 of 24 reported success, 24 of 24 persisted, version 1 to 25, 24 events, 2.21 s, no lock or temp file left |
| 12 processes each holding the lock for 300 ms | 12 of 12 acquired, 0 refused, 4.17 s, longest wait past 300 ms so they genuinely serialised |
| Holder killed with SIGKILL while holding | next acquirer reclaimed on proof of death in under 1 s |
| Live pid whose token mtime is 60 s old | reclaimed as a stale heartbeat, and the token that replaced it is a different nonce |
| Token naming pid 1, which answers `EPERM`, with a fresh mtime | not reclaimed; `LOCK_TIMEOUT` at the caller's bound and the token unchanged |
| 12 processes each transitioning a distinct item through `bin/treadle.js`, released together on a workspace whose index was deleted | 1 crash and 1 write not applied in 120 transitions with the busy timeout armed second, 0 in 240 with it armed first |

Persisted writes over reported writes is 24 of 24.

### The index is the third thing processes contend on, and it waits too

The lock serialises writers and compare-and-set catches what it does not, and both were measured from the start.
The derived index is the third, and it was not: every command opens it before it takes the lock, because DR2's freshness check has to run before any answer.

`pragma busy_timeout` is therefore the first statement issued on a connection, ahead of `pragma journal_mode = wal`.
The ordering is the whole rule.
Switching a database that is not yet in WAL takes an exclusive lock, and every run that creates the index passes through that state, so a timeout armed after the switch has nothing to wait with and the switch raises `SQLITE_BUSY` on the first contended open.
That is not a rare shape: `.index/` is gitignored, so every fresh clone and every deliberate deletion of the cache puts a workspace back into it.

`test/cli/index-contention.test.ts` holds it deterministically rather than by repetition.
A child process creates the index in the default journal mode and holds a write lock on it for a stated interval, which is the same state the window produces, and the command under test is then run through the published entry point in its own process.

### Atomic write, and finding F9

Each written file goes to a temp file in the same directory, is fsynced, and is renamed over the target.
The durability boundary is unchanged from DR4: no `F_FULLFSYNC` and no directory fsync, so a power loss inside the last write may lose that write and can never leave a torn file.

The temp name is where the design was wrong.
It was `<file>.tmp.<pid>`, derivable from the target path and a process id, and DR4 stated the exclusive create for the lock and not for the temp file.
A co-tenant who can write the workspace directory pre-places that name as a symlink to a file the victim can write, and the write follows it.

Here the suffix is 96 bits from `node:crypto` and the open is `wx`, which is `O_CREAT | O_EXCL` and fails on anything already at the path including a dangling symlink.
`openExclusive` is one function with two callers, the temp file and the lock, so the control cannot be present in one and absent in the other.
The temp name is also hidden and stays in the target's own directory, so a store scan skips it and the rename never crosses a filesystem.

Permissions: the temp file is created `0o600` so its contents are never briefly world-readable, then takes the target's own mode if the target exists and `0o644` otherwise, so a workspace that tightened its permissions keeps them.
The lock is `0o600`.
The store is project data and not secret, so the exclusive create is the control and the mode bits are hygiene.

A temp file older than an hour is removed by the next lock holder, which is what cleans up after a writer that was killed mid-write.

### Compare-and-set

Every record carries `version`, an integer the store owns.
A write names the version it believes (`ifVersion`), and the store assigns the next one; a caller cannot forge a version by writing one into the item.
Absent `ifVersion` asserts the item does not exist yet, which is what makes a create a create.

A mismatch is `CONFLICT` (`S10`) naming the version sent, the version stored, and, from the last event for that record, the actor, the instant and the transaction id of the write that moved it.
A mutation reads every file it touches under the lock, so the tool never writes from stale memory and never overwrites a hand edit it did not see.

### A duplicated id refuses the write

Two records sharing an id is an `S3` finding, and the index that records it is the same thing that refuses to serve both: its `items` table keys on the id, so the second copy fails to insert, is quarantined by name, and every read answers from one record.
That left the write path free to pick the first record in document order and move it, which is the reference implementation's own recorded risk reproduced here, and worse on a write than on a read because the caller is never told which copy it moved.

Both stores now read the finding before they write.
A write whose id carries an `S3` finding is `CONFLICT` (`S3`) naming the file and the line of the copy; the shard is left byte-identical, and every other id in it stays writable.
The overlay reads the base store's findings for the same reason it round-trips every record: a dry run must not approve what the real write refuses.

### The transaction journal

A transaction can touch several shards and the event log, and 2.17 rule 6 requires all-or-nothing.
The journal at `.index/txn/<txn>.json` lists every target path with its full new content, and is fsynced before the first rename.
A lock holder that finds a journal replays it before doing its own work.

Replay is idempotent in both halves: a record file is written with its full content, so writing it twice is writing it once, and an event append checks the file's tail for each event id and appends only the ids that are not already there.
`test/store/event-log.test.ts` plants a journal, runs two later transactions, and asserts the recovered record is served and the event log holds exactly one line.

## Alternatives considered

### A per-file lock ordered by path

Two writers on different shards could then proceed concurrently.
At the measured throughput, 24 writers in 2.21 seconds, nothing needs it, and it is the marked upgrade path rather than a thing to build now.

### An acquisition budget with a retry ceiling

This is what the reference did, and it is what refused three of twelve honest writers.
A budget converts contention, which resolves itself, into a refusal, which does not.

## Consequences

**Positive**

- Contention is never a refusal, and a dead or wedged holder never wedges the store.
- A stale write is a structured conflict that names who moved the record and when, so a caller can retry or show the user the collision.
- A pre-placed temp path is an `EEXIST` error rather than a redirected write.

**Negative**

- One store-wide lock serialises writers that touch unrelated shards. That is 9.2 ms of shard write per turn at the design's largest measured shard.
- The fsync costs about 3.5 ms per file against 0.34 ms without it. It is kept, because that is the whole durability claim.
- The journal lives under `.index/`, which a person may delete. A process that dies mid-transaction *and* has its index deleted before the next command loses the replay.

## Departures from the design record

- **The temp name is 96 random bits with an exclusive create.** DR4 wrote `<file>.tmp.<pid>` and stated the exclusive create only for the lock. This is finding F9 and it is a change to the design, not an implementation detail of it.
- **The lock token carries a nonce.** DR4 has `{pid, host, since}`. Two holders can reuse one pid across a reclaim, and the nonce is what lets the release compare byte for byte and the tests assert that a reclaim actually replaced the token rather than finding the same one.
- **The event log is appended, not written by temp-and-rename.** DR4's "each written file" would cost O(file) to add O(line), and ADR-0002's index tail rule depends on the prefix bytes staying put. The append is fsynced under the same lock, so the durability boundary is identical.
- **The waiting note is a callback, not a line on stderr.** The store writes to no stream; which stream a note goes to is the CLI's decision and the renderer's format.
- **A duplicated id refuses writes to that id, not every write in the workspace.** The domain model's H15 puts the refusal in `doctor` and stops the workspace until the duplicate is fixed. `doctor` is not built, and stopping unrelated work is a larger hammer than the ambiguity needs: a write to any other id names exactly one record and leaves both copies of the duplicated one untouched. The wider refusal lands with `doctor`, which is the command H15 actually names.
- **`--lock-timeout` is a store option rather than a flag.** The flag belongs to the CLI, which is not built. The option it maps to is here and is tested.

## What would reopen this

- A measured critical section above 1 second, which would put the 5 second staleness threshold too close to honest work.
- Windows, where `wx`, rename-over-existing and `kill(pid, 0)` semantics are unverified. The design puts that on a three-OS matrix before release.
