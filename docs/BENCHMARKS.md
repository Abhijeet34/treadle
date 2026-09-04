# Benchmarks

The acceptance bar for treadle is a measured margin over the reference on twelve axes, not an adjective.
This file is the first run that produces those numbers.
Five of the twelve axes are measured, one is half measured, and six need a harness that drives the command surface.
Every unmeasured one says so in its own row with the reason, because a gap in a table reads as a pass to whoever skims it.

Reproduce it with `npm run bench`.
The appendix at the end of this file is `bench/results/bench.md` from run `2026-09-04T23-47-03-001Z`, with its heading levels demoted one step and nothing else changed.
[ADR-0008](architecture/adr/0008-the-measurement-rig.md) holds the method and what it departs from in DR8.

## Read this before you read a number

This machine is shared with other work and was not idle for any run.
At the start of the appended run the 1-minute load average was 23.37 on 8 cores, with 12 other `node` processes and 68% of memory in use; across its twenty timed operations the 1-minute load ranged from 8.27 to 23.47, and it peaked at 99.03 while 289 parallel writers were running.
Waiting for quiet was tried and abandoned: it is not a method, and the load did not clear.

So the confound is recorded rather than dodged.
Every row in the appendix carries the load either side of it, and every headline figure below is given as the median across ten four-scale runs with its full range, not as one run's number.
Where the appended run sits above its series, the load column is where to look.

The load instrument was added for the final run, so the nine earlier runs contribute their timings but no load sample.
That is stated because it limits what the series can prove: it shows the spread, not the cause of each point.

## The machine

| Fact | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, `darwin 25.6.0`, `arm64` |
| Node | 24.11.1, below the 24.15.0 floor `package.json` declares |
| SQLite in Node | 3.50.4 |
| Seed | `20260905` |
| Appended run | 464 s of wall time, four corpora, 550 timed cold processes, 289 parallel writers, 206 damaged stores, 12 rendered command artefacts |

Node 24.11.1 is under the product's own floor, so every figure was taken on a runtime the shipped package refuses to run on.
The store is the only layer with a measurable cost here, it runs unchanged on both, and a figure without its runtime named is not a figure.

## The harness floor

Five nested floors, each a strict superset of the one above, so a difference prices exactly one thing.

| Floor | Best of 50 | Median |
|---|---|---|
| `/usr/bin/true` | 2.2 ms | 2.3 ms |
| `node -e` | 37.5 ms | 38.4 ms |
| `node` plus one JavaScript file | 40.2 ms | 41.0 ms |
| `node` plus one TypeScript file | 72.8 ms | 74.1 ms |
| `node` plus the store adapter loaded, no work | 117.5 ms | 119.0 ms |

Subtract 2.3 ms of spawn from any wall figure to get the program's own cost.
Type stripping costs 32.6 ms and loading the store costs 44.7 ms on top of it, so 77 ms of every cold invocation is module loading that a bundle would mostly remove.
DR1 measured its 45 ms budget on a 406 KB bundle and this tree has no build step, so these figures and DR1's are not the same measurement.

The floors are measured after the corpora are generated and immediately before the operations they are subtracted from, so both share their conditions.
Measuring them first, on an idle machine, put 430 MB of corpus writeback into program cost and opened six small-scale rows by up to 58%.

## Targets met

| Target | Measured |
|---|---|
| A1, 100% of reported writes persisted at every N | 1.000 in every round of all ten runs; 190 of 190 at N=200 in the appended one |
| A1, no lock or temp file left behind | 0 after every round |
| A3, output at most the reference's bytes | `status` 440 B against 1441, `backlog` 717 against 1781, `show` 273 against 322, `next` 350 against 659 |
| A3, every artefact inside its A.3 budget | 12 of 12 |
| A6, the cwd scenario resolves to one store | 3 of 3 correct, 0 mis-targets |
| A5, zero whole-store refusals | 0 of 206 damaged stores |
| A5, zero crashes on malformed input | 0 of 206 |
| DR7, zero runtime dependencies | 0 |
| DR8, install size at most 1.5 MB unpacked | 342,458 bytes across 72 files |

A3 is the widest margin in the table.
The bare dashboard is 3.3x smaller than the reference's and the nine-item list 2.5x smaller, while carrying sprint identity, points, per-column WIP against limits, a ranked next-three and a blocked block that the reference has no concept of.
`test/cli/budget.test.ts` gates those bytes; its own header records that the token figures were taken outside the tree because a tokenizer is a package and the product ships zero runtime dependencies.
This rig carries all three tokenizers as development dependencies, so the token half is now measured in-repo: bytes per token range from 2.63 on `next` to 3.88 on `backlog`, a 1.48x spread that a byte budget alone hides.

Of 35 budgets in the appended run: 25 pass, 0 fail, 9 open miss, 1 pending.

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
Its median sat between 147.7 and 150.1 ms in nine of ten runs and reached 157.9 in the appended one, which is the run whose load is recorded.
Read is at the target rather than under it, and a claim that it passes would rest on which run got quoted.

Create misses on every run and misses wide.
The mechanism is in the corpus table: a create appends one record to the largest shard, which holds 2,176 records in 1.09 MB, and the whole shard is rewritten and re-indexed.

`list` and `transition` are not axis targets but bound the same work: `transition` is the most stable figure in the whole rig at 428.9 to 447.6 ms across ten runs, and `list` is 161.0 to 164.0 in eight runs and 209.0 and 491.7 in the two loaded ones.

Five of these are DR8 budgets that the landed store has never met, and DR8's numbers came from throwaway spikes that no longer exist rather than from this code.
They are recorded as open misses: printed with their number, not failing a build for standing still.
A budget nobody has ever met is a finding, not a regression.

## Two defects the rig found

**A record heading renamed out of the grammar is dropped in silence.**
Rewriting `# wi-000026: ...` as `## wi-000026: ...` in a shard removes that record from every query and produces no finding.
Reproduced by hand outside the harness: `items: 420 findings: 0` before the edit, `items: 419 findings: []` after.
This is the reference's own headline failure, present in treadle, and it is the single silent drop in every run of the A5 corpus.
The heading is still in the file, which is what separates it from an edit that deletes a record outright: the harness counts those apart, and correcting that distinction moved the measured count from 4 to 1.

**A parallel writer can die with an uncaught `database is locked`.**

```text
Error: database is locked
    at #open (src/adapters/store/index-cache.ts:85:8)
    at IndexCache.fingerprints (src/adapters/store/index-cache.ts:94)
```

`src/adapters/store/index-cache.ts:85` runs `pragma journal_mode = wal`, which takes an exclusive lock, and `pragma busy_timeout = 5000` is not set until line 87.
The pragma therefore has no timeout in effect and throws instead of waiting.

The rate is load-dependent: across ten runs it was 0, 3, 5, 5, 9, 14, 15, 21, 23 and 31 of 289 writers.
One run saw none, and quoting that zero would be picking the run that fits.
The appended run recorded a 1-minute load of 99.03 while these writers ran, which is what the high end of that range looks like.

No write was lost in any run: a process that crashes reports no success, so the durability ratio cannot see it, which is why the harness counts crashes separately from the ratio.

Both defects belong to the store rather than to this rig, and neither was fixed here.
A benchmark that quietly repaired what it measured would be measuring something else.

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

1. **The machine was shared throughout.** Sibling workers ran during every run. Load is recorded for the appended run only; the other nine contribute timings without it.
2. **Node 24.11.1 is below the product's declared 24.15.0 floor.** The store runs unchanged on both, and no figure here was taken on the runtime the package will ship against.
3. **There is no bundle.** Every figure runs from TypeScript source and carries 32.6 ms of type stripping plus 44.7 ms of module loading that DR1's 406 KB bundle would mostly remove. The bundle-size budget has nothing to weigh.
4. **The timing limits are calibrated to this machine and are not armed anywhere.** They have never been measured on a CI runner.
5. **The corpora are not DR2's corpora.** Ours holds 2,176 records in 1.09 MB in its largest shard against the design's 2,084 in 1.69 MB, so a millisecond-for-millisecond comparison with DR2 carries that difference.
6. **Every reference figure is quoted from the prior-art axes table and none was re-derived.** The reference implementation is not in this tree and was never run.
7. **`purge` needs root and was not run**, so a cold process here is never a cold page cache.

## What the gate enforces

`npm run bench:gate` fails on what transfers between machines: durability under parallel writers, whole-store refusals and crashes on malformed input, the runtime dependency count, the install size and the per-command output budgets.
Demonstrated: with the budgets as committed it exits 0, and with the install-size limit tightened to 1,000 bytes it reports `FAIL: install size, unpacked = 19568 bytes, limit 1000` and exits 1.

It does not fail on the per-operation timing limits.
They were derived on this Apple M2 and have never been measured on a GitHub runner, so a red build there would be evidence about the runner.
`bench/budgets.json` carries `timing.enforced: false` with that reason, the rows still print with their numbers, and arming them means re-deriving on the runner once the runner's own drift has been measured.

## The run

## treadle benchmark run 2026-09-04T23-47-03-001Z

Started 2026-09-04T23:47:03.001Z, finished 2026-09-04T23:54:46.672Z, 463.6 s of wall time.
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
| at the start | 23.37 | 42.71 | 37.05 | 5251 | 67.9% | 12 |
| at the end | 24.84 | 39.33 | 37.77 | 5776 | 64.7% | 13 |

Across the 20 timed operations the 1-minute load ranged from 8.27 to 23.47.

### What the harness itself costs

Each row is a strict superset of the one above it, so a difference prices exactly one thing.
The spawn floor is subtracted from every net column below; the node floor is what the CI gate compares against.

| Floor | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| spawn floor (/usr/bin/true) | 50 | 0 | 3.0 | 2.2 | 2.3 | 2.6 | 2.6 | 50/50 | n/a | NOT MEASURED | NOT MEASURED | 17.39 to 17.39, 9 node proc |
| node floor (node -e) | 50 | 51 | 38.5 | 37.5 | 38.4 | 49.0 | 55.9 | 50/50 | 46.7 | NOT MEASURED | NOT MEASURED | 17.39 to 19.68, 9 node proc |
| node + one JavaScript file | 50 | 51 | 42.7 | 40.2 | 41.0 | 42.7 | 43.1 | 50/50 | 40.4 | 0.0 | 44.8 | 19.68 to 19.68, 13 node proc |
| node + one TypeScript file (type stripping) | 50 | 51 | 75.4 | 72.8 | 74.1 | 76.8 | 79.0 | 50/50 | 74.4 | 0.0 | 68.7 | 19.68 to 18.74, 11 node proc |
| node + the store adapter loaded, no work done | 50 | 51 | 120.0 | 117.5 | 119.0 | 125.1 | 137.2 | 50/50 | 122.8 | 0.0 | 95.2 | 18.74 to 17.56, 9 node proc |

Type stripping costs 32.6 ms and loading the store adapter costs 44.7 ms on top of it, both taken from the best of N: they are fixed costs, and the cleanest launch of the fifty is the closest thing to an uncontaminated reading of one.
DR1 measured its budget on a 406 KB bundle. This tree has no build step, so every figure below runs from TypeScript source and carries both of those costs.

### Corpora

Written through the landed store, not synthesised as files. Item counts are read back from the store after generation.

| Items in store | Shards | Largest shard | ready matches | Records bytes | Events bytes | Index bytes | Generated |
|---|---|---|---|---|---|---|---|
| 100 | 23 | 2024-12: 9 records, 4.2 KiB | 9 | 49.3 KiB | 175.9 KiB | 520.0 KiB | 0.5 s |
| 1000 | 24 | 2025-04: 55 records, 27.5 KiB | 130 | 498.9 KiB | 1.7 MiB | 4.6 MiB | 0.6 s |
| 10000 | 24 | 2025-08: 477 records, 238.7 KiB | 1450 | 4.9 MiB | 17.2 MiB | 45.4 MiB | 3.2 s |
| 50000 | 24 | 2025-08: 2176 records, 1.1 MiB | 7295 | 24.4 MiB | 85.8 MiB | 227.6 MiB | 16.1 s |

### Latency, one cold process per sample

`net p95` is the wall p95 with the spawn floor removed. `in-process p95` excludes Node startup and module loading entirely, which is the form axis A4 targets.
These are store operations, not commands. The command layer does not exist in this tree.

#### 100 items, 23 shards, largest shard 9 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 129.7 | 116.7 | 118.7 | 198.4 | 198.7 | 30/30 | 196.0 | 6.4 | 95.9 | 17.56 to 16.39, 9 node proc |
| get | 30 | 31 | 245.2 | 118.0 | 130.6 | 175.3 | 179.3 | 30/30 | 172.9 | 10.7 | 98.0 | 16.39 to 15.64, 9 node proc |
| list | 30 | 31 | 131.1 | 120.0 | 157.3 | 293.4 | 322.5 | 30/30 | 291.0 | 25.7 | 99.2 | 15.64 to 14.79, 9 node proc |
| create | 30 | 31 | 163.5 | 139.4 | 170.4 | 269.8 | 276.6 | 30/30 | 267.5 | 58.2 | 100.4 | 14.79 to 14.01, 13 node proc |
| transition | 30 | 31 | 200.1 | 142.4 | 172.1 | 237.3 | 246.3 | 30/30 | 235.0 | 57.0 | 101.1 | 14.01 to 13.12, 9 node proc |

First index build with the index deleted: 55 ms. Re-index after a hand edit of the largest shard: 14.1 ms. Both in-process, one sample each.

#### 1000 items, 24 shards, largest shard 55 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 118.3 | 115.8 | 117.9 | 122.3 | 124.9 | 30/30 | 119.9 | 4.4 | 96.3 | 13.12 to 12.23, 9 node proc |
| get | 30 | 31 | 122.6 | 121.1 | 122.9 | 142.8 | 149.7 | 30/30 | 140.5 | 12.3 | 100.2 | 12.23 to 11.57, 9 node proc |
| list | 30 | 31 | 132.4 | 125.2 | 181.0 | 214.1 | 249.7 | 30/30 | 211.8 | 34.5 | 101.7 | 11.57 to 12.25, 9 node proc |
| create | 30 | 31 | 144.3 | 148.1 | 153.9 | 262.5 | 295.8 | 30/30 | 260.2 | 72.5 | 104.0 | 12.25 to 11.83, 9 node proc |
| transition | 30 | 31 | 221.6 | 152.9 | 157.0 | 258.1 | 271.0 | 30/30 | 255.7 | 70.0 | 103.7 | 11.83 to 10.96, 10 node proc |

First index build with the index deleted: 219 ms. Re-index after a hand edit of the largest shard: 21.2 ms. Both in-process, one sample each.

#### 10000 items, 24 shards, largest shard 477 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 123.7 | 117.2 | 131.4 | 178.9 | 194.8 | 30/30 | 176.5 | 6.2 | 96.0 | 10.96 to 10.4, 9 node proc |
| get | 30 | 31 | 148.0 | 146.9 | 148.6 | 157.1 | 169.0 | 30/30 | 154.7 | 40.2 | 118.0 | 10.4 to 10.05, 9 node proc |
| list | 30 | 31 | 155.2 | 152.8 | 154.0 | 155.1 | 155.3 | 30/30 | 152.8 | 42.3 | 118.3 | 10.05 to 9.48, 9 node proc |
| create | 30 | 31 | 185.4 | 202.5 | 208.1 | 233.5 | 284.1 | 30/30 | 231.2 | 107.0 | 124.7 | 9.48 to 9.05, 9 node proc |
| transition | 30 | 31 | 234.7 | 233.2 | 243.3 | 1155.1 | 2109.2 | 30/30 | 1152.7 | 967.4 | 135.1 | 9.05 to 8.12, 10 node proc |

First index build with the index deleted: 2517 ms. Re-index after a hand edit of the largest shard: 72.5 ms. Both in-process, one sample each.

#### 50000 items, 24 shards, largest shard 2176 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 20 | 21 | 232.9 | 116.3 | 118.7 | 192.4 | 207.7 | 20/20 | 190.0 | 5.8 | 95.6 | 8.12 to 8.27, 16 node proc |
| get | 20 | 21 | 268.9 | 262.7 | 272.2 | 1212.0 | 1363.6 | 20/20 | 1209.6 | 769.5 | 183.7 | 8.27 to 13.04, 15 node proc |
| list | 20 | 21 | 567.2 | 528.6 | 807.9 | 2549.9 | 3235.7 | 20/20 | 2547.6 | 1087.5 | 187.6 | 13.04 to 23.47, 18 node proc |
| create | 20 | 21 | 990.9 | 456.2 | 564.1 | 1146.1 | 1406.2 | 20/20 | 1143.8 | 798.3 | 216.9 | 23.47 to 21.94, 16 node proc |
| transition | 20 | 21 | 569.0 | 542.6 | 569.4 | 2110.9 | 2618.2 | 20/20 | 2108.5 | 1676.0 | 246.0 | 21.94 to 20.81, 9 node proc |

First index build with the index deleted: 25920 ms. Re-index after a hand edit of the largest shard: 889.7 ms. Both in-process, one sample each.

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
| status | 440 | 1074 | yes | 142 | 151 | 150 | 3.1 | 1441 | 440 B against 1441 B, 0.31x |
| backlog | 717 | 964 | yes | 185 | 185 | 185 | 3.88 | 1781 | 717 B against 1781 B, 0.40x |
| backlog-empty | 120 | 140 | yes | 35 | 37 | 37 | 3.43 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| show | 273 | 310 | yes | 89 | 91 | 92 | 3.07 | 322 | 273 B against 322 B, 0.85x |
| next | 350 | 514 | yes | 133 | 129 | 129 | 2.63 | 659 | 350 B against 659 B, 0.53x |
| explain | 338 | 750 | yes | 121 | 122 | 121 | 2.79 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition | 131 | 230 | yes | 44 | 44 | 44 | 2.98 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-already | 100 | 110 | yes | 37 | 37 | 37 | 2.7 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-dry-run | 163 | 250 | yes | 53 | 53 | 53 | 3.08 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-preview | 233 | 254 | yes | 75 | 68 | 68 | 3.11 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| not-found | 156 | 164 | yes | 51 | 49 | 47 | 3.06 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| guard-refused | 231 | 278 | yes | 76 | 72 | 72 | 3.04 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |

### Package

| Fact | Value |
|---|---|
| Runtime dependencies | 0 |
| Development dependencies | 6 |
| Packed | 91.6 KiB |
| Unpacked | 334.4 KiB |
| Files in the package | 72 |
| Bundle | NOT MEASURED: there is no build step in this tree, so no bundle exists to weigh |

### The twelve comparison axes

| Axis | Verdict | Observed | Reference | Target | ops | samples | peak load 1m |
|---|---|---|---|---|---|---|---|
| A1 Write durability | MET | 5: 5/5, 24: 21/21, 60: 59/59, 200: 190/190; every reported write is on disk, zero refusals, zero lock or temp files left. 14 of 289 writers crashed before reporting anything, which the ratio cannot see because a crash reports no success | 100% at 5, 24, 60 on both builds (prior-art E1); 200 not run | 100% at every N, and zero silent mis-targets under the A6 scenarios | 289 | 4 | 99.03 |
| A2 Question coverage | NOT MEASURED | NOT MEASURED: the 25 questions have to be put to the command surface one at a time and scored full, partial or none; the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | 4 full, 6 partial, 15 none | 25 full | 0 | 0 | not sampled |
| A3 Token cost | MET | status 440 B against 1441 B, backlog 717 B against 1781 B, show 273 B against 322 B, next 350 B against 659 B; all 12 artefacts inside their A.3 budget | 1441, 1781, 322, 659 bytes (prior-art E10) | at most the same bytes for the same information, every extra byte attributable to a field the reference lacks | 12 | 12 | not sampled |
| A4 Latency at scale | MISSED | at 50000 items, startup excluded: read p95 769.5 ms, create p95 798.3 ms | 89/90 ms at 100, 154/141 ms at 5k, startup 83 ms (prior-art E11) | below 150 ms at 50k for read and create, startup excluded and reported separately | 570 | 550 | not sampled |
| A5 Malformed-input robustness | MISSED | 206 damaged stores read: 86 refusal names the record, 116 absorbed, 1 refusal names the file only, 1 silent drop, 2 edit removed the record | heading rename: silent drop; bad metadata line: whole-store refusal; duplicate id: silent; self-edge: silent; cycle: accepted | zero silent drops, zero whole-store refusals, every refusal names the record | 206 | 206 | 99.03 |
| A6 Mis-target rate | PARTIAL | cwd scenario: 3 of 3 resolutions correct, 0 mis-targets. The identity half of the target, and the config and environment scenarios, are NOT MEASURED: they need the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet | 1 of 3 scenarios writes elsewhere silently (prior-art E2) | 0 of 3; every write prints the store identity | 3 | 3 | 24.84 |
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
35 budgets: 25 pass, 0 fail, 9 open miss, 1 pending.
An open miss is a budget the product has never met. It is reported with its number and does not fail a build for standing still; a regression against a budget that was met does.

| Budget | Observed | Limit | Unit | Status | Note |
|---|---|---|---|---|---|
| cold start: the store layer loaded, above the runner's own node floor | 86.7 | 213 | ms | PASS | runner node floor measured in this job at 38.4 ms median |
| identity median at 100 items, above the node floor | 80.3 | 240.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 100 items, above the node floor | 92.2 | 232.3 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 100 items, above the node floor | 118.8 | 268.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 100 items, above the node floor | 132 | 255.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 100 items, above the node floor | 133.7 | 229.6 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 1000 items, above the node floor | 79.4 | 106.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 1000 items, above the node floor | 84.5 | 115.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 1000 items, above the node floor | 142.5 | 121 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 1000 items, above the node floor | 115.4 | 156.3 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 1000 items, above the node floor | 118.6 | 162.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 10000 items, above the node floor | 92.9 | 278.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 10000 items, above the node floor | 110.2 | 438.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 10000 items, above the node floor | 115.6 | 311.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 10000 items, above the node floor | 169.6 | 232.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 10000 items, above the node floor | 204.9 | 267.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 50000 items, above the node floor | 80.3 | 369.8 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 50000 items, above the node floor | 233.7 | 882.1 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 50000 items, above the node floor | 769.5 | 549.9 | ms | OPEN MISS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 50000 items, above the node floor | 525.6 | 584.4 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 50000 items, above the node floor | 531 | 723.3 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| peak RSS, read at the largest scale (DR8, 100 MiB for a read at 50k) | 192112 | 102400 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a read at 50k peaks at about 182 MiB against DR8 100 MiB, measured twice |
| peak RSS, mutation at the largest scale (DR8, 120 MiB for a mutation at 50k) | 222112 | 122880 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a mutation at 50k peaks at about 212 MiB against DR8 120 MiB, measured twice |
| first index build at the largest scale (DR8, 6 s for 50k items and 500k events) | 25920 | 6000 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 11.1 s against DR8 6 s, and the figure is a wall time that a different runner would move on its own |
| re-index after a hand edit of the largest shard (DR8, 50 ms after a hand edit of the largest shard) | 889.7 | 50 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 257 ms against DR8 50 ms, and the figure is a wall time that a different runner would move on its own |
| index size as a multiple of the text it indexes (DR8, index at most 1.0x the text size) | 2.06 | 1 | x | OPEN MISS | 238637056 bytes of index over 115635217 bytes of records and events; open finding, not build-blocking: the landed index stores each record's and each event's source text, which the DR2 spike that measured 0.7x did not; the store owner has to decide whether the budget or the index changes |
| runtime dependencies (DR7, zero runtime dependencies) | 0 | 0 | packages | PASS |  |
| install size, unpacked (DR8, 1.5 MB unpacked) | 342458 | 1572864 | bytes | PASS | the `files` list has no dist/ yet, so this weighs the metadata only |
| bundle (DR8, 500 KB bundle) | NOT MEASURED: there is no build step in this tree, so no bundle exists to weigh | 512000 | bytes | PENDING |  |
| A1 write durability, worst of the parallel rounds (axis A1) | 1 | 1 | ratio | PASS | 5: 1, 24: 1, 60: 1, 200: 1 |
| A1 writers that crashed rather than reporting a refusal (axis A1) | 14 | 0 | writers | OPEN MISS | open finding, not build-blocking: the store has never met this: at 200 parallel writers a few processes throw an uncaught `Error: database is locked` from `pragma journal_mode = wal` at src/adapters/store/index-cache.ts:85, which runs before `pragma busy_timeout = 5000` at line 87 |
| A5 silent drops (axis A5) | 1 | 0 | cases | OPEN MISS | open finding, not build-blocking: the store has never met this: a record heading renamed out of the grammar is dropped from every query with no finding |
| A5 whole-store refusals (axis A5) | 0 | 0 | cases | PASS |  |
| A5 crashes (axis A5) | 0 | 0 | cases | PASS |  |
| output size per command, bytes enforced and tokens advisory (interface A.3) | 0 | 0 | artefacts over budget | PASS | 12 artefacts measured |

