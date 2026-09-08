# ADR-0030: The derived index goes, a read parses the files, and an unreadable store says so

**Status:** Accepted
**Date:** 2026-09-08
**Implements:** the captain's decision `replace-the-index-with-a-plain-read`, on the measurement in `treadle-apparatus-weight-audit-w4`
**Supersedes:** [ADR-0020](history/0020-a-finding-is-decided-by-a-whole-read.md), whose whole subject is a partial re-index of a file
**Overtakes in part:** [ADR-0002](0002-storage-layout.md)'s derived index, [ADR-0014](0014-the-view-is-a-projection.md)'s index columns as the place a scan field lives, [ADR-0004](0004-concurrency-and-durability.md)'s index-contention ordering and journal path, [ADR-0006](0006-the-store-seam.md)'s description of `ShardedStore` as reading through the index, and [ADR-0029](0029-the-record-is-the-product-and-the-agile-surface-is-not.md)'s recap of the layout as still carrying one

## Context

ADR-0002 put a SQLite index in front of the month shards and said in its own header that it is
never authoritative. Everything after it was built on that: `S3` decided a cross-shard
duplicate through a primary key, `S14` decided a repeated event id through another, `S11` and
`S13` refused when the index was busy or unopenable, the hierarchy verdict was cached in a
`meta` row with a durable dirty marker, and `doctor` opened the store with `rederive` because a
cache that disagreed with the files had locked a workspace with no printed way back.

The audit `treadle-apparatus-weight-audit-w4` weighed what that bought against what it cost,
on the fleet's own backlog of 347 records written through the CLI. A read through the warm
index cost 24 ms above the bundle floor; parsing all 347 records cost 41 to 49 ms. The index
bought 20 to 25 ms a read, inside the run-to-run noise of its own p90.

For that it charged 1,214 lines, a quarter of `src/adapters/store/`, an index file 2.2 times
the size of the text it indexed, and the only defect this tool has ever shipped that bricked a
workspace: PR #41, a reader indexing an append beside a writer, one false `S14` per line, every
command refusing at exit 7 until the file was deleted by hand. At 10,000 records `doctor` was
slower with a warm 39 MB index (5.3 s) than with none (4.1 s), because `rederive` re-parsed
everything and then rewrote rows into the larger file.

A second defect was found on the same read path and is answered here rather than separately.
`EACCES` on the items directory was served as a workspace holding zero items, at exit 0, by
`status`, `doctor`, `backlog` and `show`; an unreadable shard escaped as exit 1 `INTERNAL`
with a raw path and no rule id; an unreadable events directory answered `history` with "no
recorded change" at exit 0. A silent empty answer over records that exist is the worst thing a
record store can do.

## Decision

**Every read parses the record files. The index, its five rules, its directory and the paths
that served it are removed, and an errno on a path the store must read is a refusal that names
the path.**

| Removed | What it was | What answers now |
|---|---|---|
| `src/adapters/store/index-cache.ts`, 795 lines | the SQLite cache, its schema, its format version, its quarantine-by-deletion and its busy retry | `#read` in `sharded-store.ts` parses `workspace.md` and every month shard |
| `#refresh`, `#refreshIndex`, `#refreshPass`, `#indexEventFile`, `#prefixUnchanged`, `#recheckHierarchy`, `#hierarchyCycle`, `#parsedUnderLock`, `rowOf`, `summaryOf`, the `rederive` option | the freshness pass, the per-file delta, the cached hierarchy verdict and the row shape | one parse per command, held only while a stat per file says the bytes have not moved |
| `S11` and `S13` on the index, with `delete .index and retry` | the index busy, and the index unopenable | nothing; there is nothing to be busy. `S11` is still the lock's, `S13` is still the store's errno |
| `S14` | two events in the store share an id | nothing. See "What this costs" |
| `.index/`, and its `.gitignore` line | the cache directory, which also held the journal | the journal moves to `.txn/`, ignored for the reason the lock is |
| `firstIndexBuildMs`, `reindexAfterHandEditMs`, `indexToTextRatio` in `bench/budgets.json` | three budgets over an artefact that no longer exists | nothing to budget |
| eleven test files, of which five went whole | the index's own suite, its contention fixture and the append race | the behaviour each protected is a property of the files, held where it is decided |

Two rules stay and are simpler for it. `S3` is now the first shard in name order serving a
record and every later copy quarantined, decided on each read, so a clash cannot outlive the
file it was decided against and the `against` column that made that true is gone. `S12` is
`findParentCycle` over the parent edges the read just built, 10.3 ms at 10,000 records against
the meta row, the dirty marker and the repair walk that used to carry it.

**A read holds one parse and proves it with a stat.** `status` alone asks the store four
questions, and two stores open on one root have to see each other's writes, so `#read` keeps
the parse and a name, size and mtime per file, and reuses it only while every one of them is
unchanged. A file that moved costs the whole read again rather than that file's rows, which is
what the removal buys: there is no row to replace. `apply` discards the parse and reads inside
the lock, because a write within one mtime tick that leaves a file the same size is invisible
to a stat.

**The log is read only by a command that answers from it.** Scanning 100,000 event lines costs
826 ms at 10,000 records, more than parsing every record, and `status` has no use for it. So
`findings()` reports the records always and the log once something has read it, and
`history` and `explain` call `logIsWhole` after their read to earn the exit 7 a damaged log has
always earned. `doctor` asks for the findings again after its own pass over the log, and
reports them rather than refusing, because the refusal every other read prints names `doctor`
as the way back.

**An errno is `STORE_UNAVAILABLE` naming the path.** A directory listing, a shard read and an
event-file read all answer `EACCES`, `EPERM` and every other errno but `ENOENT` with `S13` and
the syscall that failed, which is what the write path has always done. `ENOENT` keeps its old
meaning at every one of them: a workspace with no `items` directory holds no records.

## Consequences

Read latency, whole-process wall clock, median and p90 in milliseconds, fifteen cold processes
per cell on one machine, before and after on the same tree. The floor, `treadle version`, is
71/72 in every run.

| Read | 347 before | 347 after | 3,000 before | 3,000 after | 10,000 before | 10,000 after |
|---|---|---|---|---|---|---|
| `backlog --limit 20` | 85/86 | 98/99 | 106/106 | 164/176 | 159/162 | 313/316 |
| `show <id>` | 89/90 | 100/103 | 108/111 | 162/165 | 159/160 | 311/320 |
| `status` | 91/93 | 100/100 | 109/111 | 163/167 | 163/166 | 317/328 |
| `next --limit 10` | 86/87 | 99/100 | 107/107 | 161/162 | 160/162 | 311/315 |
| `explain <id>` | 91/92 | 126/132 | 111/122 | 288/292 | 164/170 | 717/727 |
| `doctor` | 214/220 | 126/127 | 963/987 | 305/323 | 3687/31928 | 782/789 |

At 347 records a read costs 9 to 14 ms more. At 3,000, which is a year of the fleet's own
filing rate, it costs 54 ms more and lands at 163 ms. At 10,000 it costs about 240 ms above
the floor against about 90 ms through the index, which is better than the audit's projection of
380 ms; the audit ran on a busier machine and this is the same arithmetic, not a different one.

`doctor` is three to four times faster at every scale, and that is the whole of the index's
account settled: the one command that read everything was the one the cache could not serve.

The bundle is 341,178 bytes against 368,355, measured by `npm run build` on the same tree, and
that is 27,177 bytes of a product whose own budget is 768,000. `src/adapters/store/` is 3,109
lines against 3,956, 21.4 percent of it, and `src/` is 13,542 against 14,347. The diff against
the branch base is 931 insertions and 2,349 deletions across 53 files.

`scripts/check-tests-kept.ts` counts 1,227 test declarations at the merge base and 1,198 here:
36 removed, each declared by a `Removes-test` trailer, and 7 added. Five test files went whole
and every one of them had the index for its subject.

### What this costs, stated rather than absorbed

`explain` at 10,000 records is 717 ms against 164, because it reads the log and the log is
100,000 lines in the rig's corpus. The fleet's real backlog carries about one event per record
rather than ten, where the same read is a tenth of that scan. This is the one read that got
materially worse and it is the price of the log not being a table.

`S14` is gone and nothing replaces it. A repeated event id across two month files was found by
a primary key over the whole log; without a table there is nowhere to hold that set except in
memory during a scan, and the scan is the thing this record removes from every read. Both
copies of a repeated id are now served, in file and line order. `doctor` would be the place to
put it back, over the log it already reads whole, and no measurement asks for it yet.

A damaged event line no longer refuses `status` or `backlog`. It refuses `history`, `explain`
and `doctor`, which are the reads that answer from the log; a line the log cannot read hides an
event and not a record, and refusing every command over one was the same over-broad refusal
that PR #41 turned into a bricked workspace.

`engines.node` stays at 24.15.0 and its justification changes. It was the version where
`node:sqlite` reached Stability 1.2, which is a capability claim about a dependency this record
removes. It is now a support statement: 24.15.0 is what `.nvmrc` pins, what the first CI leg
runs, what every figure in docs/BENCHMARKS.md was measured on, and the runtime `@types/node` is
held not to outrun. Nothing in the shipped bundle needs a Node newer than 24.0.0.
