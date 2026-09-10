# ADR-0036: EPERM from an exclusive create is contention when the directory takes a file, and a refusal when it does not

**Status:** Accepted
**Date:** 2026-09-10
**Overtakes in part:** [ADR-0004](0004-concurrency-and-durability.md), whose waiter loop reads "on `EEXIST` read the token"; `EEXIST` is no longer the only errno that means another process holds the lock

## Context

`windows-2025` failed `.github/workflows/cross-platform.yml` three times on 2026-09-10, on two commits that touched only workflow files, against two earlier runs of the same job that passed.
Each failure was one test out of 2160, always the same errno at the same point, and the victim varied between the two concurrency suites in `test/store/lock.test.ts`.

```text
✖ failing tests:
test at test\store\lock.test.ts:85:3
✖ refuses none of them, because there is no acquisition budget (3866.8023ms)
  stdout: `{"ok":false,"code":"STORE_UNAVAILABLE","message":"the lock C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\treadling-store-KhWkn5\\.lock could not be created: EPERM: operation not permitted, open 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\treadling-store-KhWkn5\\.lock'"}`
```

| Run | Job | Commit | Test | Contenders |
|---|---|---|---|---|
| 34460562673 | 102817138788 | c8b9806 | `lock.test.ts:39` | 24 writers |
| 34460562673 | 102818988730 | c8b9806 | `lock.test.ts:85` | 12 holders |
| 34461762879 | 102820997932 | c33362b | `lock.test.ts:39` | 24 writers |

So the store refused a write on a store that was in use and perfectly writable.
`S11` `STORE_UNAVAILABLE` is the refusal for a lock that cannot be created at all, and the waiter reached it because the acquisition loop treated `EEXIST` as the only errno that means somebody else holds the lock.

### Why Windows answers a different errno for the same situation

Two sources, both read rather than reasoned about.

Microsoft's `DeleteFile` remarks say what state a file being deleted is in, and what an open against it answers:

> The **DeleteFile** function marks a file for deletion on close. Therefore, the file deletion does not occur until the last handle to the file is closed. Subsequent calls to CreateFile to open the file fail with **ERROR_ACCESS_DENIED**.

libuv says what Node makes of that error, in `uv_translate_sys_error` in `src/win/error.c`:

```c
    case ERROR_ACCESS_DENIED:               return UV_EPERM;
```

`EPERM`, not `EACCES`.
Two details of libuv's own implementation put the lock file in that state rather than some other one.
`fs__open` opens with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` to match Unix semantics, which is what allows a delete to be set while other processes still hold the file open.
`fs__unlink_rmdir` asks for a POSIX delete first and falls back to `FileDispositionInformation` with `DeleteFile = TRUE`, which is the delete-on-close the remark above describes.

A lock file being released is therefore delete-pending for as long as any contender still has it open for a read, and the waiter that tries its exclusive create inside that window meets `EPERM` where a POSIX waiter would have met `EEXIST`.
That matches every observed detail: the errno arrives from `open`, under twelve-way and twenty-four-way contention, on the lock path, intermittently.
Read against libuv 1.51.0, the version Node 24 bundles.

## Decision

### `EPERM` is retried when the directory will take a file, and refused when it will not

The waiter loop's guard was `code !== 'EEXIST'` and is now

```ts
if (code !== 'EEXIST' && !(code === 'EPERM' && await directoryTakesAFile(path))) {
```

`directoryTakesAFile` exclusively creates one name beside the lock and removes it.
The name is `tempNameFor`'s, so it is 96 random bits from `node:crypto` and nothing contends for it: its outcome is a fact about the directory and about nothing else.
The probe costs one create and one unlink, and only on the `EPERM` path.

Both outcomes keep a behaviour the product already had.
A directory that takes the probe is a store under contention, and contention has never been a refusal here.
A directory that refuses the probe is a read-only mount or a denied ACL, and `S11` saying so immediately is the honest answer rather than a wait on nothing.

### The errno is injected at the call site, so the behaviour is tested on every platform

The occurrence is Windows-only and the behaviour is not.
`test/store/fixtures/eperm-open.ts` registers a module `resolve` hook that points `lock.ts`'s import of `./atomic.ts` at itself, and substitutes `openExclusive`; every other user of `atomic.ts` keeps the real one.
`test/store/fixtures/eperm.ts` runs one acquisition in a child process under that substitution, because the hook has to be registered before `lock.ts` is loaded and the test runner has already loaded it.

Two situations, two tests, both running on all three platforms.

| `TREADLING_EPERM` | What it models | Asserted |
|---|---|---|
| `pending:12` | the lock path answers `EPERM` for twelve creates, every other name is accepted | acquired, and after at least 60 ms, so the retries happened |
| `refusing` | every create in the directory answers `EPERM` | `STORE_UNAVAILABLE` `S11`, inside the caller's bound rather than at it |

Measured on this tree, 20 runs per line, one process per run:

| | Before the change | After |
|---|---|---|
| `waits out a lock file whose holder is letting it go` | 20 failures in 20 runs | 0 in 20 |
| `refuses a directory that will accept no file at all` | 0 failures in 20 runs | 0 in 20 |

The second line is the point of having two tests: the failure was cheap to make disappear and the refusal was what a careless fix would have taken with it.

On real runners, six `workflow_dispatch` runs of `.github/workflows/cross-platform.yml` against commit 1c5aee6: 6 runs, 0 failures, every `windows-2025` job green, against a fault that had failed three hand-fired runs of that job in a row.
One green board proves nothing about an intermittent fault, which is why the count is the claim rather than the colour.
The two tests ran on `windows-2025` itself rather than being skipped there, and the diagnostic line from run 34465277333 reads `twelve EPERMs on the lock path were waited out in 326 ms`.
That job reported 2164 tests, 2147 pass, 0 fail, 17 skipped, against 2160, 2142, 1 and 17 on the failing job this record opens with.

## Alternatives considered

**Add `EPERM` to the retry branch.**
Refused, and this is the decision the record exists for.
`EPERM` is also what a read-only mount and a denied ACL answer, and an unconditional retry has no budget to end it: `timeoutMs` is absent by default, so the tool would hang silently where it used to refuse in milliseconds.
A rare intermittent failure traded for a silent hang is a worse tool.

**Ask whether the lock file exists, and retry when it does.**
Refused on the mechanism above.
Delete-pending ends when the last handle closes. At the instant of the `EPERM` the file exists; whether it still exists a few microseconds later, when the question is answered, is a race whose window is another process's remaining read and has no lower bound. Lose that race and a waiter which had met real contention is told its store is unusable.
That converts a Windows-only intermittent failure into a rarer Windows-only intermittent failure, which is the shape of defect that costs the most to find twice.
The first row of the measurement table is that case: no lock file exists at any point in it, and the acquisition is still owed.

**Branch on `process.platform === 'win32'`.**
Refused twice over.
The discriminator should be about the situation and not the operating system, and a platform branch would put the behaviour beyond the reach of a test on the platform the suite actually runs on most.

**Report the `EPERM` and let the caller retry.**
Refused: `S11` is documented as a store that cannot be used, and a caller that has to know which errnos are worth retrying is the lock's job moved outward.

## Consequences

- The lock's acquisition loop makes one extra syscall pair, on the `EPERM` path only. `EEXIST` contention, which is every POSIX wait, is untouched.
- A waiter now writes a file under the store, which `sweepTempFiles` previously documented as something only a lock holder does. The probe is removed in a `finally`, and a later lock holder's sweep removes one a process died beside; `atomic.ts` records that it is the other writer.
- The reclaim path is unchanged. The lost-write fence and its regression test (`refuses the write of a writer paused past the window, so the reclaimer's write is never overwritten`) are untouched and still pass.
- One class of `EPERM` is still retried rather than refused: one that is permanent and about the lock path itself, such as a file carrying the immutable flag. It is indistinguishable from a holder that never lets go, and `holderTimeoutMs` is the answer this design already has for that.
- Not addressed here, and reported separately: the lost-write regression above is one of the tests `test/helpers/platform.ts` skips on Windows for want of `SIGSTOP`, so the fence has no Windows coverage at all. The three transcripts each show 17 skipped tests.

## Departures from the design record

DR4 wrote the waiter as "on `EEXIST`", which was right about the situation and wrong about how many errnos name it.
The lesson is the one this record's title carries: an errno is a platform's word for a situation, and a lock that reads one errno as the situation is portable only by accident.
