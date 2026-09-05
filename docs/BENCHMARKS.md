# Benchmarks

The acceptance bar for treadle is a measured margin over the reference on twelve axes, not an adjective.
This file is the first run that produces those numbers.
Four of the twelve axes are measured, one is half measured, and seven are not measured: six need a harness that drives the command surface and one needs a metrics layer that does not exist yet.
Every unmeasured one says so in its own row with the reason, because a gap in a table reads as a pass to whoever skims it.

**One thing in this file has changed since it was written.**
Every "there is no bundle" and "the bundle-size budget has nothing to weigh" below was true of the tree that produced these figures, and is no longer.
[ADR-0009](architecture/adr/0009-release-and-supply-chain.md) added the build step: `dist/treadle.js` is 173,891 bytes against DR8's 512,000 limit, so the last pending budget in the appendix is a `PASS` on the next run rather than a `NOT MEASURED`.
The timing figures are untouched by that, because the timed children still launch from TypeScript source; that gap is the one the floors table prices, and closing it is what would make these numbers comparable with DR1's.
The appendix is left exactly as the run produced it, because a measured record that is edited afterwards is not one.

Reproduce it with `npm run bench`.
The appendix at the end of this file is `bench/results/bench.md` from run `2026-09-05T01-11-11-759Z`, with its heading levels demoted one step and nothing else changed.
[ADR-0008](architecture/adr/0008-the-measurement-rig.md) holds the method and what it departs from in DR8.

## Read this before you read a number

This machine is shared with other work and was not idle for any run.
At the start of the appended run the 1-minute load average was 66.16 on 8 cores, with 15 other `node` processes and 66% of memory in use; across its twenty timed operations the 1-minute load ranged from 14.35 to 35.95, and it peaked at 86.26 while 289 parallel writers were running.
Waiting for quiet was tried and abandoned: it is not a method, and the load did not clear.

So the confound is recorded rather than dodged.
Every row in the appendix carries the load either side of it, and every headline figure below is given as the median across ten four-scale runs with its full range, not as one run's number.
Where the appended run sits above its series, the load column is where to look.

Two limits on what the series can prove, both stated because they bound it.
The load instrument was added late, so most of the ten runs contribute timings without a load sample: the series shows the spread, not the cause of each point.
And the ten-run series was measured before #4 landed, while the appended run is the only four-scale run on the tree that carries it, so a series figure and an appendix figure are not measurements of the same store.

## The machine

| Fact | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, `darwin 25.6.0`, `arm64` |
| Node | 24.11.1, below the 24.15.0 floor `package.json` declares |
| SQLite in Node | 3.50.4 |
| Seed | `20260905` |
| Appended run | 442 s of wall time, four corpora, 550 timed cold processes, 289 parallel writers, 206 damaged stores, 12 rendered command artefacts |

Node 24.11.1 is under the product's own floor, so every figure was taken on a runtime the shipped package refuses to run on.
The store is the only layer with a measurable cost here, it runs unchanged on both, and a figure without its runtime named is not a figure.

## The harness floor

Five nested floors, each a strict superset of the one above, so a difference prices exactly one thing.

| Floor | Best of 50 | Median |
|---|---|---|
| `/usr/bin/true` | 2.2 ms | 2.3 ms |
| `node -e` | 37.5 ms | 38.5 ms |
| `node` plus one JavaScript file | 40.3 ms | 41.1 ms |
| `node` plus one TypeScript file | 73.2 ms | 74.3 ms |
| `node` plus the store adapter loaded, no work | 117.1 ms | 118.7 ms |

Subtract 2.3 ms of spawn from any wall figure to get the program's own cost.
Type stripping costs 32.9 ms and loading the store costs 44.0 ms on top of it, so 77 ms of every cold invocation is module loading that a bundle would mostly remove.
DR1 measured its 45 ms budget on a 406 KB bundle and this tree has no build step, so these figures and DR1's are not the same measurement.

The floors are measured after the corpora are generated and immediately before the operations they are subtracted from, so both share their conditions.
Measuring them first, on an idle machine, put 430 MB of corpus writeback into program cost and opened six small-scale rows by up to 58%.

## Targets met

| Target | Measured |
|---|---|
| A1, 100% of reported writes persisted at every N | 1.000 in every round of all fifteen runs; 200 of 200 at N=200 in the appended one |
| A1, no writer crashed rather than refusing | 0, after #4; see below |
| A1, no lock or temp file left behind | 0 after every round |
| A3, output at most the reference's bytes | `status` 440 B against 1441, `backlog` 717 against 1781, `show` 273 against 322, `next` 350 against 659 |
| A3, every artefact inside its A.3 budget | 12 of 12 |
| A6, the cwd scenario resolves to one store | 3 of 3 correct, 0 mis-targets |
| A5, zero whole-store refusals | 0 of 206 damaged stores |
| A5, zero crashes on malformed input | 0 of 206 |
| DR7, zero runtime dependencies | 0 |
| DR8, install size at most 1.5 MB unpacked | 351,419 bytes across 72 files |

A3 is the widest margin in the table.
The bare dashboard is 3.3x smaller than the reference's and the nine-item list 2.5x smaller, while carrying sprint identity, points, per-column WIP against limits, a ranked next-three and a blocked block that the reference has no concept of.
`test/cli/budget.test.ts` gates those bytes; its own header records that the token figures were taken outside the tree because a tokenizer is a package and the product ships zero runtime dependencies.
This rig carries all three tokenizers as development dependencies, so the token half is now measured in-repo: bytes per token range from 2.63 on `next` to 3.88 on `backlog`, a 1.48x spread that a byte budget alone hides.

Of 35 budgets in the appended run: 26 pass, 0 fail, 8 open miss, 1 pending.

## Targets missed

Figures are the median across ten runs, with the range, because one run's number on a loaded machine is not the claim.

| Target | Budget | Median of ten runs | Range | Over by |
|---|---|---|---|---|
| A4, create below 150 ms at 50k, startup excluded | 150 ms | 311.1 ms | 304.3 to 417.2 | 2.07x |
| A4, read below 150 ms at 50k, startup excluded | 150 ms | 148.6 ms | 147.7 to 157.9 | at the target, not under it |
| A5, zero silent drops | 0 | 1 of 206 | 1 in every run | one case |
| DR8, peak RSS on a read at 50k | 100 MiB | 182.0 MiB | | 1.82x |
| DR8, peak RSS on a mutation at 50k | 120 MiB | 216.6 MiB | | 1.81x |
| DR8, first index build at 50k | 6,000 ms | 11,074 ms | 10,578 to 25,920 | 1.85x |
| DR8, re-index after a hand edit of the largest shard | 50 ms | 261.8 ms | 253.8 to 889.7 | 5.2x |
| DR8, index size against the text it indexes | 1.0x | 2.06x | 2.06x in every run | 2.06x |

Read at 50k is the one worth reading carefully.
Its median sat between 147.7 and 150.1 ms in nine of the ten pre-#4 runs and reached 157.9 in the tenth.
Read is at the target rather than under it, and a claim that it passes would rest on which run got quoted.
The appended run's read median of 315.4 ms is not a read figure: it was taken at a 1-minute load of 25.25 and is the clearest single illustration in this document of why the load column exists.

Create misses on every run and misses wide.
The mechanism is in the corpus table: a create appends one record to the largest shard, which holds 2,176 records in 1.09 MB, and the whole shard is rewritten and re-indexed.

`list` and `transition` are not axis targets but bound the same work: `transition` is the most stable figure in the whole rig at 428.9 to 447.6 ms across ten runs, and `list` is 161.0 to 164.0 in eight runs and 209.0 and 491.7 in the two loaded ones.

Five of these are DR8 budgets that the landed store has never met, and DR8's numbers came from throwaway spikes that no longer exist rather than from this code.
They are recorded as open misses: printed with their number, not failing a build for standing still.
A budget nobody has ever met is a finding, not a regression.

## The two defects the rig found, and what happened to them

**Closed: a parallel writer could die with an uncaught `database is locked`.**

The rig found this at axis A1 and reported it as an open miss rather than fixing it.

```text
Error: database is locked
    at #open (src/adapters/store/index-cache.ts:85:8)
    at IndexCache.fingerprints (src/adapters/store/index-cache.ts:94)
```

`pragma journal_mode = wal` takes an exclusive lock and `pragma busy_timeout = 5000` was not set until three statements later, so the switch had no timeout in effect and threw instead of waiting.
Before the fix the rate was load-dependent and ran 0, 3, 5, 5, 9, 14, 15, 21, 23 and 31 of 289 writers across ten runs; only one of those ten was clean, so a single clean run would have proved nothing.

[#4](https://github.com/Abhijeet34/treadle/pull/4) closed it independently, arming the timeout before the switch and then retrying the lock promotion that SQLite refuses to wait on at all.
Re-measured here against the tree that carries it: **0 crashes in 1,445 writers across five runs**, every round reporting 200 of 200 at N=200 with no refusals, at 1-minute loads from 3.13 to 116.12, which is heavier contention than any of the runs that produced the crash.
The budget is now armed, so a return of it fails the build rather than printing as an open miss.

**Still open: a record heading renamed out of the grammar is dropped in silence.**

Rewriting `# wi-000026: ...` as `## wi-000026: ...` in a shard removes that record from every query and produces no finding.
Reproduced by hand outside the harness: `items: 420 findings: 0` before the edit, `items: 419 findings: []` after.
It is the reference's own headline failure, present in treadle, and it is the single silent drop in every run of the A5 corpus including the one appended here.

The heading is still in the file, which is what separates it from an edit that deletes a record outright: the harness counts those apart, and correcting that distinction moved the measured count from 4 to 1.

Neither defect was fixed by this branch.
A benchmark that quietly repairs what it measures is measuring something else, and the value of that rule is visible in the first one: the rig found it, another worker fixed it, and the rig then verified the fix without either side taking the other's word for it.

## What is not measured, and what unblocks it

The command surface landed in #3 while this rig was being built, which is what let A3 move into the measured set.
Six axes still need a harness that drives that surface rather than one artefact rendered from it.

| Axis | What it needs |
|---|---|
| A2 question coverage | the 25 questions put to the command surface one at a time and scored full, partial or none |
| A7 audit answerability | 50 items driven through 200 random legal transitions, each chain read back |
| A8 lifecycle enforcement | every ordered state pair attempted at the surface and the printed guard id read; `src/domain/state-machine.ts` holds the rule table today |
| A10 type validation | one invalid creation per rule at the surface; `src/domain/fields.ts` refuses these today |
| A11 harness neutrality | the full feature set run with no harness present and the files it wrote counted, plus an adapter generator to score |
| A12 output contract | every verb on both its success and its failure path; `schemas/` carries eleven schemas since #3 |

A9 metric coverage needs the metrics layer, which no landed commit begins.
A6 is half measured: the cwd scenario is a store resolution and is measured, while the config-in-parent and environment-override scenarios and the printed store identity are command-layer behaviour.
The DR8 bundle-size budget is `pending` for a different reason: there is no build step, so there is no bundle to weigh.

## How stable a figure here is

Ten four-scale runs, because a benchmark whose own repeatability is unknown cannot report a regression.

- The worst run-to-run drift of any operation's program cost was **19.9%** across three runs taken before the load instrument existed, on `list` at 1,000 items: 87.5, 87.4 and 104.7 ms.
- The **p95 moved 68.9%** between two identical runs. The gate therefore reads the median and reports the p95 without gating on it.
- The in-process median was measured as an alternative and drifts 17.8% on the same case, so the variance is the machine rather than the statistic.
- Fixed costs are taken from the best of fifty rather than the median. Across five runs the best-of-N type-stripping cost spread 0.11 ms while the median-based one spread 14.7 ms.
- At 50k, where the work dominates, `transition` spread 4.4% and `get` 6.9% across all ten runs, including the loaded ones.

The tolerance is 35%, which clears the measured 19.9% by 1.76x.
It is not enough on a machine at a load of 99, and the appended run has two timing rows open because of it.
That is the gate reporting the machine rather than the code, which is exactly why the timing rows are not armed.

## Confounds that could not be eliminated

Stated plainly, because each one bounds what these numbers support.

1. **The machine was shared throughout.** Sibling workers ran during every run, and the appended run started at a 1-minute load of 66.16 on 8 cores. Load is recorded for the later runs only; the earlier ones contribute timings without it.
2. **The ten-run series predates #4.** It measures the store before the busy-timeout fix, while the appended run measures the store after it. Axis A1 was re-measured on the new tree; the A4 timings were not re-measured ten times, so a series figure and an appendix figure are not the same store.
3. **Node 24.11.1 is below the product's declared 24.15.0 floor.** The store runs unchanged on both, and no figure here was taken on the runtime the package will ship against.
4. **There is no bundle.** Every figure runs from TypeScript source and carries 32.6 ms of type stripping plus 44.7 ms of module loading that DR1's 406 KB bundle would mostly remove. The bundle-size budget has nothing to weigh.
5. **The timing limits are calibrated to this machine and are not armed anywhere.** They have never been measured on a CI runner.
6. **The corpora are not DR2's corpora.** Ours holds 2,176 records in 1.09 MB in its largest shard against the design's 2,084 in 1.69 MB, so a millisecond-for-millisecond comparison with DR2 carries that difference.
7. **Every reference figure is quoted from the prior-art axes table and none was re-derived.** The reference implementation is not in this tree and was never run.
8. **`purge` needs root and was not run**, so a cold process here is never a cold page cache.

## What the gate enforces

`npm run bench:gate` fails on what transfers between machines: durability under parallel writers, whole-store refusals and crashes on malformed input, the runtime dependency count, the install size and the per-command output budgets.
Demonstrated: with the budgets as committed it exits 0, and with the install-size limit tightened to 1,000 bytes it reports `FAIL: install size, unpacked = 19568 bytes, limit 1000` and exits 1.

It does not fail on the per-operation timing limits.
They were derived on this Apple M2 and have never been measured on a GitHub runner, so a red build there would be evidence about the runner.
`bench/budgets.json` carries `timing.enforced: false` with that reason, the rows still print with their numbers, and arming them means re-deriving on the runner once the runner's own drift has been measured.

## The run

## treadle benchmark run 2026-09-05T01-11-11-759Z

Started 2026-09-05T01:11:11.759Z, finished 2026-09-05T01:18:33.535Z, 441.7 s of wall time.
Generated by `npm run bench`. Every figure below was measured in that run; nothing is carried over, interpolated or estimated.

### Machine and runtime

| Fact | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, darwin 25.6.0 (arm64) |
| Node | 24.11.1 (V8 13.6.233.10-node.28) |
| SQLite in Node | 3.50.4 |
| Declared floor | 24.15.0; this runtime **is below it**, so every figure here was taken under a runtime the package refuses |
| Seed | 20260905 |

This machine is shared with other work and was not idle for this run.
Rather than wait for quiet, every row below carries the load either side of it, so a figure above its series can be judged against what the machine was doing.

| Machine state | 1m load | 5m | 15m | free MiB | memory used | node processes |
|---|---|---|---|---|---|---|
| at the start | 66.16 | 88.95 | 77.29 | 5645 | 65.5% | 15 |
| at the end | 16.33 | 49.38 | 61.79 | 4873 | 70.3% | 17 |

Across the 20 timed operations the 1-minute load ranged from 14.35 to 35.95.

### What the harness itself costs

Each row is a strict superset of the one above it, so a difference prices exactly one thing.
The spawn floor is subtracted from every net column below; the node floor is what the CI gate compares against.

| Floor | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| spawn floor (/usr/bin/true) | 50 | 0 | 3.3 | 2.2 | 2.3 | 2.5 | 2.6 | 50/50 | n/a | NOT MEASURED | NOT MEASURED | 45.14 to 45.14, 10 node proc |
| node floor (node -e) | 50 | 51 | 38.6 | 37.5 | 38.0 | 38.9 | 39.7 | 50/50 | 36.6 | NOT MEASURED | NOT MEASURED | 45.14 to 41.85, 10 node proc |
| node + one JavaScript file | 50 | 51 | 42.1 | 40.3 | 40.7 | 41.3 | 41.6 | 50/50 | 38.9 | 0.0 | 44.8 | 41.85 to 41.85, 10 node proc |
| node + one TypeScript file (type stripping) | 50 | 51 | 73.8 | 73.2 | 73.9 | 89.3 | 96.8 | 50/50 | 87.0 | 0.0 | 68.8 | 41.85 to 38.74, 10 node proc |
| node + the store adapter loaded, no work done | 50 | 51 | 139.7 | 117.1 | 120.1 | 150.4 | 183.4 | 50/50 | 148.1 | 0.0 | 95.4 | 38.74 to 35.95, 10 node proc |

Type stripping costs 32.9 ms and loading the store adapter costs 44.0 ms on top of it, both taken from the best of N: they are fixed costs, and the cleanest launch of the fifty is the closest thing to an uncontaminated reading of one.
DR1 measured its budget on a 406 KB bundle. This tree has no build step, so every figure below runs from TypeScript source and carries both of those costs.

### Corpora

Written through the landed store, not synthesised as files. Item counts are read back from the store after generation.

| Items in store | Shards | Largest shard | ready matches | Records bytes | Events bytes | Index bytes | Generated |
|---|---|---|---|---|---|---|---|
| 100 | 23 | 2024-12: 9 records, 4.2 KiB | 9 | 49.3 KiB | 175.9 KiB | 520.0 KiB | 0.4 s |
| 1000 | 24 | 2025-04: 55 records, 27.5 KiB | 130 | 498.9 KiB | 1.7 MiB | 4.6 MiB | 0.6 s |
| 10000 | 24 | 2025-08: 477 records, 238.7 KiB | 1450 | 4.9 MiB | 17.2 MiB | 45.4 MiB | 3.3 s |
| 50000 | 24 | 2025-08: 2176 records, 1.1 MiB | 7295 | 24.4 MiB | 85.8 MiB | 227.6 MiB | 16.2 s |

### Latency, one cold process per sample

`net p95` is the wall p95 with the spawn floor removed. `in-process p95` excludes Node startup and module loading entirely, which is the form axis A4 targets.
These are store operations, not commands. The command layer does not exist in this tree.

#### 100 items, 23 shards, largest shard 9 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 117.9 | 116.9 | 119.1 | 138.5 | 174.1 | 30/30 | 136.2 | 4.5 | 96.2 | 35.95 to 33.23, 10 node proc |
| get | 30 | 31 | 162.9 | 118.0 | 135.3 | 187.7 | 190.4 | 30/30 | 185.4 | 12.8 | 99.2 | 33.23 to 30.73, 10 node proc |
| list | 30 | 31 | 120.6 | 119.5 | 130.9 | 197.8 | 324.7 | 30/30 | 195.5 | 15.1 | 98.5 | 30.73 to 28.75, 10 node proc |
| create | 30 | 31 | 202.6 | 142.3 | 190.7 | 225.6 | 241.5 | 30/30 | 223.3 | 53.5 | 100.6 | 28.75 to 27.25, 10 node proc |
| transition | 30 | 31 | 149.0 | 142.2 | 146.3 | 165.6 | 169.9 | 30/30 | 163.3 | 39.3 | 101.6 | 27.25 to 25.55, 11 node proc |

First index build with the index deleted: 55 ms. Re-index after a hand edit of the largest shard: 14.2 ms. Both in-process, one sample each.

#### 1000 items, 24 shards, largest shard 55 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 118.1 | 117.0 | 119.8 | 170.8 | 256.8 | 30/30 | 168.5 | 5.8 | 96.6 | 25.55 to 23.66, 10 node proc |
| get | 30 | 31 | 122.1 | 121.7 | 168.0 | 243.0 | 246.9 | 30/30 | 240.7 | 24.7 | 101.0 | 23.66 to 21.85, 10 node proc |
| list | 30 | 31 | 192.3 | 128.2 | 226.0 | 380.2 | 489.6 | 30/30 | 377.9 | 122.9 | 101.0 | 21.85 to 20.98, 10 node proc |
| create | 30 | 31 | 226.8 | 148.1 | 172.4 | 339.7 | 362.3 | 30/30 | 337.4 | 115.2 | 103.2 | 20.98 to 19.78, 10 node proc |
| transition | 30 | 31 | 158.8 | 155.3 | 161.0 | 339.9 | 410.4 | 30/30 | 337.5 | 126.8 | 104.1 | 18.35 to 19.29, 10 node proc |

First index build with the index deleted: 225 ms. Re-index after a hand edit of the largest shard: 24.7 ms. Both in-process, one sample each.

#### 10000 items, 24 shards, largest shard 477 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 118.1 | 116.8 | 118.4 | 121.2 | 123.7 | 30/30 | 118.9 | 4.2 | 95.5 | 19.29 to 17.9, 10 node proc |
| get | 30 | 31 | 156.8 | 148.2 | 153.4 | 173.9 | 211.2 | 30/30 | 171.5 | 42.2 | 118.1 | 17.9 to 16.95, 10 node proc |
| list | 30 | 31 | 177.6 | 152.3 | 155.0 | 176.5 | 178.8 | 30/30 | 174.2 | 48.5 | 118.5 | 16.95 to 16.95, 10 node proc |
| create | 30 | 31 | 224.6 | 205.1 | 210.0 | 392.1 | 523.6 | 30/30 | 389.8 | 196.3 | 125.3 | 16.95 to 15.68, 10 node proc |
| transition | 30 | 31 | 244.9 | 233.8 | 237.3 | 252.0 | 267.0 | 30/30 | 249.7 | 134.8 | 134.8 | 15.68 to 14.35, 10 node proc |

First index build with the index deleted: 2372 ms. Re-index after a hand edit of the largest shard: 69.1 ms. Both in-process, one sample each.

#### 50000 items, 24 shards, largest shard 2176 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 20 | 21 | 139.7 | 139.7 | 186.1 | 244.2 | 262.1 | 20/20 | 241.9 | 11.1 | 96.6 | 14.35 to 13.44, 11 node proc |
| get | 20 | 21 | 425.8 | 433.8 | 521.2 | 1564.4 | 3417.4 | 20/20 | 1562.1 | 1246.7 | 183.3 | 13.44 to 25.25, 11 node proc |
| list | 20 | 21 | 1358.9 | 277.3 | 284.0 | 479.5 | 526.2 | 20/20 | 477.2 | 290.4 | 181.8 | 25.25 to 23.54, 30 node proc |
| create | 20 | 21 | 320.7 | 432.4 | 451.7 | 681.5 | 735.5 | 20/20 | 679.2 | 472.0 | 216.9 | 23.54 to 20.23, 11 node proc |
| transition | 20 | 21 | 580.3 | 550.8 | 567.4 | 600.8 | 604.0 | 20/20 | 598.5 | 455.1 | 245.2 | 20.23 to 17.39, 10 node proc |

First index build with the index deleted: 11462 ms. Re-index after a hand edit of the largest shard: 261.7 ms. Both in-process, one sample each.

### Byte and token accounting

| Tokenizer | Package | Version | Loaded |
|---|---|---|---|
| claude | `@anthropic-ai/tokenizer` | 0.0.4 | yes |
| o200k | `gpt-tokenizer` | 4.0.0 | yes |
| cl100k | `gpt-tokenizer` | 4.0.0 | yes |

| Artefact | Bytes | Lines | claude | o200k | cl100k | B/token claude | B/token o200k | B/token cl100k |
|---|---|---|---|---|---|---|---|---|
| one stored record, rendered by the grammar | 357 | 16 | 105 | 101 | 101 | 3.4 | 3.53 | 3.53 |
| nine stored records, the shape of the reference fixture | 4045 | 167 | 1164 | 1098 | 1111 | 3.48 | 3.68 | 3.64 |
| one event-log line | 180 | 1 | 70 | 67 | 67 | 2.57 | 2.69 | 2.69 |
| ten event-log lines, dense identifiers and instants | 1801 | 10 | 710 | 671 | 671 | 2.54 | 2.68 | 2.68 |

### Output budgets per command

Bytes are the gate and tokens are advisory, per DR8. The budgets are the interface specification's section A.3, adjusted upward by four bytes for every occurrence of the binary name, because A.3 was stated against a three-character name.
The reference column is quoted from the prior-art axes table and was never re-derived here.

| Artefact | Bytes | Budget | Within | claude | o200k | cl100k | B/token claude | Reference | Against reference |
|---|---|---|---|---|---|---|---|---|---|
| status | 440 | 1074 | yes | 142 | 152 | 151 | 3.1 | 1441 | 440 B against 1441 B, 0.31x |
| backlog | 717 | 964 | yes | 185 | 185 | 185 | 3.88 | 1781 | 717 B against 1781 B, 0.40x |
| backlog-empty | 120 | 140 | yes | 35 | 37 | 37 | 3.43 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| show | 273 | 310 | yes | 89 | 91 | 92 | 3.07 | 322 | 273 B against 322 B, 0.85x |
| next | 350 | 514 | yes | 133 | 129 | 129 | 2.63 | 659 | 350 B against 659 B, 0.53x |
| explain | 354 | 750 | yes | 125 | 126 | 125 | 2.83 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition | 131 | 230 | yes | 44 | 44 | 44 | 2.98 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-already | 100 | 110 | yes | 37 | 37 | 37 | 2.7 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-dry-run | 163 | 250 | yes | 53 | 53 | 53 | 3.08 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-preview | 233 | 254 | yes | 75 | 69 | 69 | 3.11 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| not-found | 156 | 164 | yes | 51 | 49 | 47 | 3.06 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| guard-refused | 231 | 278 | yes | 76 | 72 | 72 | 3.04 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |

### Package

| Fact | Value |
|---|---|
| Runtime dependencies | 0 |
| Development dependencies | 6 |
| Packed | 94.5 KiB |
| Unpacked | 343.2 KiB |
| Files in the package | 72 |
| Bundle | NOT MEASURED: there is no build step in this tree, so no bundle exists to weigh |

### The twelve comparison axes

| Axis | Verdict | Observed | Reference | Target | ops | samples | peak load 1m |
|---|---|---|---|---|---|---|---|
| A1 Write durability | MET | 5: 5/5, 24: 24/24, 60: 60/60, 200: 200/200; every reported write is on disk, zero refusals, zero lock or temp files left. Zero writers crashed | 100% at 5, 24, 60 on both builds (prior-art E1); 200 not run | 100% at every N, and zero silent mis-targets under the A6 scenarios | 289 | 4 | 86.26 |
| A2 Question coverage | NOT MEASURED | NOT MEASURED: the 25 questions have to be put to the command surface one at a time and scored full, partial or none; the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | 4 full, 6 partial, 15 none | 25 full | 0 | 0 | not sampled |
| A3 Token cost | MET | status 440 B against 1441 B, backlog 717 B against 1781 B, show 273 B against 322 B, next 350 B against 659 B; all 12 artefacts inside their A.3 budget | 1441, 1781, 322, 659 bytes (prior-art E10) | at most the same bytes for the same information, every extra byte attributable to a field the reference lacks | 12 | 12 | not sampled |
| A4 Latency at scale | MISSED | at 50000 items, startup excluded: read p95 1246.7 ms, create p95 472.0 ms | 89/90 ms at 100, 154/141 ms at 5k, startup 83 ms (prior-art E11) | below 150 ms at 50k for read and create, startup excluded and reported separately | 570 | 550 | not sampled |
| A5 Malformed-input robustness | MISSED | 206 damaged stores read: 86 refusal names the record, 117 absorbed, 1 refusal names the file only, 1 silent drop, 1 edit removed the record | heading rename: silent drop; bad metadata line: whole-store refusal; duplicate id: silent; self-edge: silent; cycle: accepted | zero silent drops, zero whole-store refusals, every refusal names the record | 206 | 206 | 86.26 |
| A6 Mis-target rate | PARTIAL | cwd scenario: 3 of 3 resolutions correct, 0 mis-targets. The identity half of the target, and the config and environment scenarios, are NOT MEASURED: they need the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | 1 of 3 scenarios writes elsewhere silently (prior-art E2) | 0 of 3; every write prints the store identity | 3 | 3 | 17.41 |
| A7 Audit answerability | NOT MEASURED | NOT MEASURED: this needs 50 items driven through 200 random legal transitions and each chain read back; the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | 0 of 50, the reference keeps no history | 50 of 50 | 0 | 0 | not sampled |
| A8 Lifecycle enforcement | NOT MEASURED | NOT MEASURED: src/domain/state-machine.ts holds the rule table and test/domain/state-machine.test.ts exercises it, but the axis scores every ordered state pair through the command surface and reads the printed guard id; the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | 0 refused of 6 illegal pairs tried (prior-art E8) | every illegal pair refused with a guard id | 0 | 0 | not sampled |
| A9 Metric coverage | NOT MEASURED | NOT MEASURED: no metric is implemented in this tree; nothing under src computes velocity, cycle time or a burndown series | 0 of 14 | 14 of 14, each matching the spreadsheet | 0 | 0 | not sampled |
| A10 Type validation | NOT MEASURED | NOT MEASURED: src/domain/fields.ts refuses these today and the domain suite covers them, but the axis scores one invalid creation per rule at the surface; the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | 0 of 11 refused, the reference has a single free-text kind | 11 of 11 | 0 | 0 | not sampled |
| A11 Harness neutrality | NOT MEASURED | NOT MEASURED: this needs the full feature set run with no harness present and the files it wrote counted, and there is no adapter generator to score; the store writes only inside the workspace directory, which is a property this rig does not yet assert | setup writes 4 files across 3 harnesses | 0 required; adapters optional and generated | 0 | 0 | not sampled |
| A12 Output contract | NOT MEASURED | NOT MEASURED: schemas/ carries eleven schemas since #3 and test/cli/schemas.test.ts validates against them, but the axis scores every verb on both its success and its failure path; the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | mutations only; reads refuse the flag with exit 2; errors on stdout (prior-art E9) | every verb, both paths | 0 | 0 | not sampled |

#### What each unfilled axis is waiting for

- **A1**: the mis-target half of this target is axis A6, which resolves a store from a working directory and needs the command layer
- **A2**: the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet
- **A6**: the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet
- **A7**: the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet
- **A8**: the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet
- **A9**: the metrics layer, which no landed commit begins
- **A10**: the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet
- **A11**: the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet
- **A12**: the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet

### DR8 budget gate

Timing limits are program cost at the median: the operation's wall median minus the runner's own `node -e` median, measured in the same job.
Tolerance 35% over the committed limit, because six four-scale runs on 2026-09-05 put the worst run-to-run drift of any operation's program cost at 19.9% across the three runs where the machine was quiet (list at 1,000 items, 87.5 / 87.4 / 104.7 ms); 35% clears that by 1.76x. The in-process median was measured as an alternative and drifts 17.8% on the same case, so the statistic is not what the variance comes from. A run taken under load drifts further and shows up as an open miss, which is the correct outcome for a gate nobody has armed yet. The p95 moved 68.9% between two runs, which is why the gate reads the median and reports the p95 without gating on it.
Limits derived from run 2026-09-04T23-39-28-387Z on 2026-09-04 (Apple M2, 8 cores, darwin 25.6.0, Node 24.11.1).
35 budgets: 26 pass, 0 fail, 8 open miss, 1 pending.
An open miss is a budget the product has never met. It is reported with its number and does not fail a build for standing still; a regression against a budget that was met does.

| Budget | Observed | Limit | Unit | Status | Note |
|---|---|---|---|---|---|
| cold start: the store layer loaded, above the runner's own node floor | 112.4 | 213 | ms | PASS | runner node floor measured in this job at 38.0 ms median |
| identity median at 100 items, above the node floor | 81.1 | 240.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 100 items, above the node floor | 97.3 | 232.3 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 100 items, above the node floor | 92.9 | 268.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 100 items, above the node floor | 152.8 | 255.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 100 items, above the node floor | 108.3 | 229.6 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 1000 items, above the node floor | 81.8 | 106.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 1000 items, above the node floor | 130.1 | 115.2 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 1000 items, above the node floor | 188 | 121 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 1000 items, above the node floor | 134.4 | 156.3 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 1000 items, above the node floor | 123 | 162.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 10000 items, above the node floor | 80.4 | 278.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 10000 items, above the node floor | 115.4 | 438.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 10000 items, above the node floor | 117 | 311.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 10000 items, above the node floor | 172.1 | 232.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 10000 items, above the node floor | 199.4 | 267.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 50000 items, above the node floor | 148.1 | 369.8 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 50000 items, above the node floor | 483.2 | 882.1 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 50000 items, above the node floor | 246 | 549.9 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 50000 items, above the node floor | 413.8 | 584.4 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 50000 items, above the node floor | 529.4 | 723.3 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| peak RSS, read at the largest scale (DR8, 100 MiB for a read at 50k) | 186128 | 102400 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a read at 50k peaks at about 182 MiB against DR8 100 MiB, measured twice |
| peak RSS, mutation at the largest scale (DR8, 120 MiB for a mutation at 50k) | 222144 | 122880 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a mutation at 50k peaks at about 212 MiB against DR8 120 MiB, measured twice |
| first index build at the largest scale (DR8, 6 s for 50k items and 500k events) | 11462 | 6000 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 11.1 s against DR8 6 s, and the figure is a wall time that a different runner would move on its own |
| re-index after a hand edit of the largest shard (DR8, 50 ms after a hand edit of the largest shard) | 261.7 | 50 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 257 ms against DR8 50 ms, and the figure is a wall time that a different runner would move on its own |
| index size as a multiple of the text it indexes (DR8, index at most 1.0x the text size) | 2.06 | 1 | x | OPEN MISS | 238637056 bytes of index over 115635217 bytes of records and events; open finding, not build-blocking: the landed index stores each record's and each event's source text, which the DR2 spike that measured 0.7x did not; the store owner has to decide whether the budget or the index changes |
| runtime dependencies (DR7, zero runtime dependencies) | 0 | 0 | packages | PASS |  |
| install size, unpacked (DR8, 1.5 MB unpacked) | 351419 | 1572864 | bytes | PASS | the `files` list has no dist/ yet, so this weighs the metadata only |
| bundle (DR8, 500 KB bundle) | NOT MEASURED: there is no build step in this tree, so no bundle exists to weigh | 512000 | bytes | PENDING |  |
| A1 write durability, worst of the parallel rounds (axis A1) | 1 | 1 | ratio | PASS | 5: 1, 24: 1, 60: 1, 200: 1 |
| A1 writers that crashed rather than reporting a refusal (axis A1) | 0 | 0 | writers | PASS |  |
| A5 silent drops (axis A5) | 1 | 0 | cases | OPEN MISS | open finding, not build-blocking: the store has never met this: a record heading renamed out of the grammar is dropped from every query with no finding |
| A5 whole-store refusals (axis A5) | 0 | 0 | cases | PASS |  |
| A5 crashes (axis A5) | 0 | 0 | cases | PASS |  |
| output size per command, bytes enforced and tokens advisory (interface A.3) | 0 | 0 | artefacts over budget | PASS | 12 artefacts measured |

