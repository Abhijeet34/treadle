# Benchmarks

The acceptance bar for treadle is a measured margin over the reference on twelve axes, not an adjective.
This file is the first run that produces those numbers.
Four of the twelve axes are measured today, one is half measured, and seven are not measurable until the command layer exists.
Every unmeasured one says so in its own row with the reason, because a gap in a table reads as a pass to whoever skims it.

Reproduce it with `npm run bench`.
The appendix at the end of this file is `bench/results/bench.md` from run `2026-09-04T22-56-35-450Z`, with its heading levels demoted one step and nothing else changed.
[ADR-0008](architecture/adr/0008-the-measurement-rig.md) holds the method and what it departs from in DR8.

## The machine

| Fact | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, `darwin 25.6.0`, `arm64` |
| Node | 24.11.1, below the 24.15.0 floor `package.json` declares |
| SQLite in Node | 3.50.4 |
| Seed | `20260905` |
| Run | 308 s of wall time, four corpora, 550 timed cold processes, 289 parallel writers, 206 damaged stores |

Node 24.11.1 is under the product's own floor, and every figure below was therefore taken on a runtime the shipped package refuses to run on.
That is stated rather than worked around: the store is the only layer built, it runs unchanged on both, and a figure without its runtime named is not a figure.

## The harness floor

Five nested floors, each a strict superset of the one above, so a difference prices exactly one thing.

| Floor | Best of 50 | Median |
|---|---|---|
| `/usr/bin/true` | 2.2 ms | 2.3 ms |
| `node -e` | 37.4 ms | 37.8 ms |
| `node` plus one JavaScript file | 40.0 ms | 40.4 ms |
| `node` plus one TypeScript file | 72.5 ms | 73.3 ms |
| `node` plus the store adapter loaded, no work | 117.0 ms | 118.5 ms |

Subtract 2.3 ms of spawn from any wall figure to get the program's own cost.
Type stripping costs 32.4 ms and loading the store costs 44.5 ms on top of it, so 77 ms of every cold invocation below is module loading that a bundle would mostly remove.
DR1 measured its 45 ms budget on a 406 KB bundle, and this tree has no build step, so these figures and DR1's are not the same measurement.

## Targets met

| Target | Measured |
|---|---|
| A1, 100% of reported writes persisted at every N | 1.000 in every round of all eight runs that measured it; 200 of 200 at N=200 in this one |
| A1, no lock or temp file left behind | 0 after every round |
| A6, the cwd scenario resolves to one store | 3 of 3 correct, 0 mis-targets |
| A5, zero whole-store refusals | 0 of 206 damaged stores |
| A5, zero crashes on malformed input | 0 of 206 |
| DR7, zero runtime dependencies | 0 |
| DR8, install size at most 1.5 MB unpacked | 19,568 bytes across 5 files |
| DR8, every per-operation timing limit | 20 of 20 inside a 35% tolerance |

The reference's own A1 result was 100% at 5, 24 and 60, and 200 was never run against it.
Treadle holds 100% at all four, and 200 parallel writers from separate processes serialise through one lock in 58 to 78 seconds with zero refusals.

Of 35 budgets: 27 pass, 0 fail, 6 open miss, 2 pending.

## Targets missed

| Target | Budget | Measured | Over by |
|---|---|---|---|
| A4, create below 150 ms at 50k, startup excluded | 150 ms | 336.3 ms p95, 304.3 ms median | 2.0x at the median |
| A4, read below 150 ms at 50k, startup excluded | 150 ms | 153.7 ms p95, 147.7 ms median | at the target, not under it |
| A5, zero silent drops | 0 | 1 of 206 | one case |
| DR8, peak RSS on a read at 50k | 100 MiB | 181.7 MiB | 1.82x |
| DR8, peak RSS on a mutation at 50k | 120 MiB | 216.1 MiB | 1.80x |
| DR8, first index build at 50k | 6,000 ms | 12,040 ms | 2.01x |
| DR8, re-index after a hand edit of the largest shard | 50 ms | 253.8 ms | 5.1x |
| DR8, index size against the text it indexes | 1.0x | 2.06x | 2.06x |

Read at 50k is the one worth reading carefully.
Its median has sat between 147.2 and 149.0 ms across nine runs, a spread of 1.2%, so the median is under the target.
Its p95 crossed 150 ms in six of those nine, ranging from 149.4 to 169.7 ms.
Read is at the target rather than under it, and a claim that it passes would rest on which run got quoted.

Create misses on both statistics and misses wide: its median is 304.1 to 315.5 ms across the same nine runs.
The mechanism is visible in the corpus table: a create appends one record to the largest shard, which holds 2,176 records in 1.09 MB, and the whole shard is rewritten and re-indexed.

Five of these are DR8 budgets that the landed store has never met, and DR8's numbers came from throwaway spikes that no longer exist rather than from this code.
They are recorded as open misses: printed with their number, not failing a build for standing still.
A budget nobody has ever met is a finding, not a regression.

## Two defects the rig found

**A record heading renamed out of the grammar is dropped in silence.**
Rewriting `# wi-000026: ...` as `## wi-000026: ...` in a shard removes that record from every query and produces no finding.
Reproduced by hand outside the harness: `items: 420 findings: 0` before the edit, `items: 419 findings: []` after.
This is the reference's own headline failure, present in treadle, and it is the single silent drop in the A5 corpus.
The heading is still in the file, which is what separates it from an edit that deletes a record outright: the harness counts those apart, and correcting that distinction moved the measured count from 4 to 1.

**A parallel writer can die with an uncaught `database is locked`.**

```text
Error: database is locked
    at #open (src/adapters/store/index-cache.ts:85:8)
    at IndexCache.fingerprints (src/adapters/store/index-cache.ts:94)
```

`src/adapters/store/index-cache.ts:85` runs `pragma journal_mode = wal`, which takes an exclusive lock, and `pragma busy_timeout = 5000` is not set until line 87.
The pragma therefore has no timeout in effect and throws instead of waiting.

It is intermittent and load-dependent.
Across the eight runs that measured axis A1 the count was 0, 3, 5, 5, 6, 14, 15 and 31 out of 289 writers, and the run in this report is the one that saw none.
Reporting this run's zero as the result would be picking the run that fits.

No write was lost in any of them: a process that crashes reports no success, so the durability ratio cannot see it, which is why the harness counts crashes separately from the ratio.

Both defects belong to the store rather than to this rig, and neither was fixed here.
A benchmark that quietly repaired what it measured would be measuring something else.

## What is not measured, and what unblocks it

Seven axes and one budget need the command layer, which is being built in parallel and has no file under `src/cli` in this tree.

| Axis | What it needs |
|---|---|
| A2 question coverage | commands to score against the 25-question set |
| A3 token cost | a command that writes to stdout; the accounting instrument is built and is demonstrated below on store artefacts |
| A7 audit answerability | the transition and explain commands |
| A8 lifecycle enforcement | a command's refusal and its printed guard id, though `src/domain/state-machine.ts` holds the rule table today |
| A10 type validation | a creation command's refusal, though `src/domain/fields.ts` refuses these today |
| A11 harness neutrality | a feature set to run and an adapter generator |
| A12 output contract | verbs, and a schema under `schemas/` |
| DR8 output budgets | the same artefacts as A3 |

A9 metric coverage needs the metrics layer, which no landed commit begins.
A6 is half measured: the cwd scenario is a store resolution and is measured, while the config-in-parent and environment-override scenarios and the printed store identity are all command-layer behaviour.

The DR8 bundle-size budget is `pending` for a different reason: there is no build step, so there is no bundle to weigh.

## How stable a figure here is

Ten four-scale runs were taken to answer this, because a benchmark whose own repeatability is unknown cannot report a regression.

- The worst run-to-run drift of any operation's program cost is **19.9%** across the three runs where the machine was quiet, on `list` at 1,000 items: 87.5, 87.4 and 104.7 ms.
- The **p95 moved 68.9%** between two identical runs. The gate therefore reads the median and reports the p95 without gating on it.
- The in-process median was measured as an alternative and drifts 17.8% on the same case, so the variance is the machine rather than the statistic.
- Fixed costs are taken from the best of fifty rather than the median. Across five runs the best-of-N type-stripping cost spread 0.11 ms while the median-based one spread 14.7 ms, because one run's floor phase ran under load.
- At the largest scale, where the work dominates the noise, the read median spread 1.2% and the create median 3.7% over nine runs.

The tolerance is 35%, which clears the measured 19.9% by 1.76x.
Runs discarded from these figures are named in the reason above rather than dropped quietly.
A tolerance nobody measured is a guess with a percent sign on it.

## What the gate enforces

`npm run bench:gate` fails on what transfers between machines: durability under parallel writers, whole-store refusals and crashes on malformed input, the runtime dependency count and the install size.

It does not fail on the per-operation timing limits.
They were derived on this Apple M2 and have never been measured on a GitHub runner, so a red build there would be evidence about the runner.
`bench/budgets.json` carries `timing.enforced: false` with that sentence, the rows still print with their numbers, and arming them means re-deriving on the runner with `--write-budgets` once the runner's own drift has been measured.

## The run

## treadle benchmark run 2026-09-04T22-56-35-450Z

Started 2026-09-04T22:56:35.450Z, finished 2026-09-04T23:01:43.267Z, 307.8 s of wall time.
Generated by `npm run bench`. Every figure below was measured in that run; nothing is carried over, interpolated or estimated.

### Machine and runtime

| Fact | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, darwin 25.6.0 (arm64) |
| Node | 24.11.1 (V8 13.6.233.10-node.28) |
| SQLite in Node | 3.50.4 |
| Declared floor | 24.15.0; this runtime **is below it**, so every figure here was taken under a runtime the package refuses |
| Seed | 20260905 |

### What the harness itself costs

Each row is a strict superset of the one above it, so a difference prices exactly one thing.
The spawn floor is subtracted from every net column below; the node floor is what the CI gate compares against.

| Floor | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| spawn floor (/usr/bin/true) | 50 | 0 | 3.3 | 2.2 | 2.3 | 2.5 | 2.7 | 50/50 | n/a | NOT MEASURED | NOT MEASURED |
| node floor (node -e) | 50 | 51 | 38.3 | 37.4 | 37.8 | 45.1 | 51.1 | 50/50 | 42.8 | NOT MEASURED | NOT MEASURED |
| node + one JavaScript file | 50 | 51 | 41.1 | 40.0 | 40.4 | 41.6 | 44.5 | 50/50 | 39.3 | 0.0 | 44.8 |
| node + one TypeScript file (type stripping) | 50 | 51 | 72.9 | 72.5 | 73.3 | 73.8 | 74.0 | 50/50 | 71.5 | 0.0 | 68.8 |
| node + the store adapter loaded, no work done | 50 | 51 | 135.9 | 117.0 | 118.5 | 120.1 | 120.9 | 50/50 | 117.8 | 0.0 | 95.2 |

Type stripping costs 32.4 ms and loading the store adapter costs 44.5 ms on top of it, both taken from the best of N: they are fixed costs, and the cleanest launch of the fifty is the closest thing to an uncontaminated reading of one.
DR1 measured its budget on a 406 KB bundle. This tree has no build step, so every figure below runs from TypeScript source and carries both of those costs.

### Corpora

Written through the landed store, not synthesised as files. Item counts are read back from the store after generation.

| Items in store | Shards | Largest shard | ready matches | Records bytes | Events bytes | Index bytes | Generated |
|---|---|---|---|---|---|---|---|
| 100 | 23 | 2024-12: 9 records, 4.2 KiB | 9 | 49.3 KiB | 175.9 KiB | 520.0 KiB | 0.4 s |
| 1000 | 24 | 2025-04: 55 records, 27.5 KiB | 130 | 498.9 KiB | 1.7 MiB | 4.6 MiB | 0.6 s |
| 10000 | 24 | 2025-08: 477 records, 238.7 KiB | 1450 | 4.9 MiB | 17.2 MiB | 45.4 MiB | 3.2 s |
| 50000 | 24 | 2025-08: 2176 records, 1.1 MiB | 7295 | 24.4 MiB | 85.8 MiB | 227.6 MiB | 16.2 s |

### Latency, one cold process per sample

`net p95` is the wall p95 with the spawn floor removed. `in-process p95` excludes Node startup and module loading entirely, which is the form axis A4 targets.
These are store operations, not commands. The command layer does not exist in this tree.

#### 100 items, 23 shards, largest shard 9 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 118.8 | 116.3 | 117.8 | 121.7 | 122.2 | 30/30 | 119.4 | 4.5 | 96.2 |
| get | 30 | 31 | 119.5 | 117.8 | 118.8 | 121.7 | 133.5 | 30/30 | 119.3 | 7.7 | 97.4 |
| list | 30 | 31 | 118.6 | 118.6 | 120.0 | 121.4 | 122.3 | 30/30 | 119.1 | 8.5 | 98.6 |
| create | 30 | 31 | 140.7 | 139.3 | 143.5 | 157.5 | 169.0 | 30/30 | 155.2 | 33.6 | 100.2 |
| transition | 30 | 31 | 146.3 | 143.0 | 146.6 | 148.7 | 149.1 | 30/30 | 146.3 | 36.7 | 101.4 |

First index build with the index deleted: 55 ms. Re-index after a hand edit of the largest shard: 14 ms. Both in-process, one sample each.

#### 1000 items, 24 shards, largest shard 55 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 116.8 | 116.3 | 117.2 | 119.3 | 120.3 | 30/30 | 117.0 | 3.9 | 95.7 |
| get | 30 | 31 | 122.7 | 121.8 | 122.6 | 123.6 | 128.6 | 30/30 | 121.3 | 11.4 | 100.1 |
| list | 30 | 31 | 125.0 | 124.4 | 125.3 | 129.8 | 130.2 | 30/30 | 127.5 | 15.2 | 100.9 |
| create | 30 | 31 | 143.6 | 148.5 | 151.8 | 154.1 | 154.2 | 30/30 | 151.8 | 42.5 | 103.0 |
| transition | 30 | 31 | 158.1 | 153.5 | 156.2 | 159.8 | 160.9 | 30/30 | 157.5 | 47.5 | 103.5 |

First index build with the index deleted: 202 ms. Re-index after a hand edit of the largest shard: 21.5 ms. Both in-process, one sample each.

#### 10000 items, 24 shards, largest shard 477 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 116.3 | 114.9 | 117.0 | 118.7 | 119.0 | 30/30 | 116.4 | 3.7 | 96.0 |
| get | 30 | 31 | 148.0 | 145.2 | 147.5 | 154.3 | 157.9 | 30/30 | 152.0 | 37.3 | 118.3 |
| list | 30 | 31 | 150.5 | 150.4 | 152.5 | 156.1 | 157.6 | 30/30 | 153.7 | 41.6 | 118.4 |
| create | 30 | 31 | 176.6 | 203.2 | 206.7 | 208.9 | 212.3 | 30/30 | 206.6 | 93.4 | 124.4 |
| transition | 30 | 31 | 233.4 | 228.9 | 235.9 | 241.9 | 245.4 | 30/30 | 239.5 | 125.0 | 135.1 |

First index build with the index deleted: 2020 ms. Re-index after a hand edit of the largest shard: 66 ms. Both in-process, one sample each.

#### 50000 items, 24 shards, largest shard 2176 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 20 | 21 | 116.3 | 115.7 | 116.7 | 118.7 | 118.7 | 20/20 | 116.4 | 3.7 | 95.8 |
| get | 20 | 21 | 261.2 | 260.5 | 261.5 | 268.9 | 275.3 | 20/20 | 266.6 | 153.7 | 182.6 |
| list | 20 | 21 | 276.1 | 273.8 | 275.3 | 278.9 | 279.2 | 20/20 | 276.6 | 162.9 | 181.7 |
| create | 20 | 21 | 317.4 | 429.6 | 433.3 | 464.3 | 464.6 | 20/20 | 462.0 | 336.3 | 216.1 |
| transition | 20 | 21 | 559.6 | 536.9 | 556.5 | 563.1 | 566.2 | 20/20 | 560.8 | 433.6 | 245.2 |

First index build with the index deleted: 12040 ms. Re-index after a hand edit of the largest shard: 253.8 ms. Both in-process, one sample each.

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

### Package

| Fact | Value |
|---|---|
| Runtime dependencies | 0 |
| Development dependencies | 6 |
| Packed | 7.4 KiB |
| Unpacked | 19.1 KiB |
| Files in the package | 5 |
| Bundle | NOT MEASURED: there is no build step in this tree, so no bundle exists to weigh |

### The twelve comparison axes

| Axis | Verdict | Observed | Reference | Target | ops | samples |
|---|---|---|---|---|---|---|
| A1 Write durability | MET | 5: 5/5, 24: 24/24, 60: 60/60, 200: 200/200; every reported write is on disk, zero refusals, zero lock or temp files left. Zero writers crashed | 100% at 5, 24, 60 on both builds (prior-art E1); 200 not run | 100% at every N, and zero silent mis-targets under the A6 scenarios | 289 | 4 |
| A2 Question coverage | NOT MEASURED | NOT MEASURED: there are no commands to score; blocked on the command layer, which is being built in parallel; nothing under src/cli exists in this tree | 4 full, 6 partial, 15 none | 25 full | 0 | 0 |
| A3 Token cost | NOT MEASURED | NOT MEASURED: no command writes to stdout yet, so there is no artefact to count; the accounting instrument is built and demonstrated on store artefacts in this report. Blocked on the command layer, which is being built in parallel; nothing under src/cli exists in this tree | 1441, 1781, 322, 659 bytes (prior-art E10) | at most the same bytes for the same information, every extra byte attributable to a field the reference lacks | 0 | 0 |
| A4 Latency at scale | MISSED | at 50000 items, startup excluded: read p95 153.7 ms, create p95 336.3 ms | 89/90 ms at 100, 154/141 ms at 5k, startup 83 ms (prior-art E11) | below 150 ms at 50k for read and create, startup excluded and reported separately | 570 | 550 |
| A5 Malformed-input robustness | MISSED | 206 damaged stores read: 86 refusal names the record, 117 absorbed, 1 refusal names the file only, 1 silent drop, 1 edit removed the record | heading rename: silent drop; bad metadata line: whole-store refusal; duplicate id: silent; self-edge: silent; cycle: accepted | zero silent drops, zero whole-store refusals, every refusal names the record | 206 | 206 |
| A6 Mis-target rate | PARTIAL | cwd scenario: 3 of 3 resolutions correct, 0 mis-targets. The identity half of the target, and the config and environment scenarios, are NOT MEASURED: they need the command layer, which is being built in parallel; nothing under src/cli exists in this tree | 1 of 3 scenarios writes elsewhere silently (prior-art E2) | 0 of 3; every write prints the store identity | 3 | 3 |
| A7 Audit answerability | NOT MEASURED | NOT MEASURED: driving an item through a legal transition is the transition command, and reading the chain back is the explain command; blocked on the command layer, which is being built in parallel; nothing under src/cli exists in this tree | 0 of 50, the reference keeps no history | 50 of 50 | 0 | 0 |
| A8 Lifecycle enforcement | NOT MEASURED | NOT MEASURED: src/domain/state-machine.ts holds the rule table and test/domain/state-machine.test.ts exercises it, but the axis scores a command's refusal and its printed guard id; blocked on the command layer, which is being built in parallel; nothing under src/cli exists in this tree | 0 refused of 6 illegal pairs tried (prior-art E8) | every illegal pair refused with a guard id | 0 | 0 |
| A9 Metric coverage | NOT MEASURED | NOT MEASURED: no metric is implemented in this tree; nothing under src computes velocity, cycle time or a burndown series | 0 of 14 | 14 of 14, each matching the spreadsheet | 0 | 0 |
| A10 Type validation | NOT MEASURED | NOT MEASURED: src/domain/fields.ts refuses these today and the domain suite covers them, but the axis scores what a creation command refuses at the surface; blocked on the command layer, which is being built in parallel; nothing under src/cli exists in this tree | 0 of 11 refused, the reference has a single free-text kind | 11 of 11 | 0 | 0 |
| A11 Harness neutrality | NOT MEASURED | NOT MEASURED: there is no feature set to run and no adapter generator; the store writes only inside the workspace directory, which is a property this rig does not yet assert | setup writes 4 files across 3 harnesses | 0 required; adapters optional and generated | 0 | 0 |
| A12 Output contract | NOT MEASURED | NOT MEASURED: there are no verbs and schemas/ carries no schema; blocked on the command layer, which is being built in parallel; nothing under src/cli exists in this tree | mutations only; reads refuse the flag with exit 2; errors on stdout (prior-art E9) | every verb, both paths | 0 | 0 |

#### What each unfilled axis is waiting for

- **A1**: the mis-target half of this target is axis A6, which resolves a store from a working directory and needs the command layer
- **A2**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree
- **A3**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree
- **A6**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree
- **A7**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree
- **A8**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree
- **A9**: the metrics layer, which no landed commit begins
- **A10**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree
- **A11**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree
- **A12**: the command layer, which is being built in parallel; nothing under src/cli exists in this tree

### DR8 budget gate

Timing limits are program cost at the median: the operation's wall median minus the runner's own `node -e` median, measured in the same job.
Tolerance 35% over the committed limit, because six four-scale runs on 2026-09-05 put the worst run-to-run drift of any operation's program cost at 19.9% across the three runs where the machine was quiet (list at 1,000 items, 87.5 / 87.4 / 104.7 ms); 35% clears that by 1.76x. The in-process median was measured as an alternative and drifts 17.8% on the same case, so the statistic is not what the variance comes from. A run taken under load drifts further and shows up as an open miss, which is the correct outcome for a gate nobody has armed yet. The p95 moved 68.9% between two runs, which is why the gate reads the median and reports the p95 without gating on it.
Limits derived from run 2026-09-04T22-26-45-723Z on 2026-09-04 (Apple M2, 8 cores, darwin 25.6.0, Node 24.11.1).
35 budgets: 27 pass, 0 fail, 6 open miss, 2 pending.
An open miss is a budget the product has never met. It is reported with its number and does not fail a build for standing still; a regression against a budget that was met does.

| Budget | Observed | Limit | Unit | Status | Note |
|---|---|---|---|---|---|
| cold start: the store layer loaded, above the runner's own node floor | 82.3 | 217.5 | ms | PASS | runner node floor measured in this job at 37.8 ms median |
| identity median at 100 items, above the node floor | 80 | 112.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 100 items, above the node floor | 81 | 232.1 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 100 items, above the node floor | 82.2 | 238.1 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 100 items, above the node floor | 105.7 | 198.6 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 100 items, above the node floor | 108.8 | 147.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 1000 items, above the node floor | 79.4 | 107.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 1000 items, above the node floor | 84.8 | 113.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 1000 items, above the node floor | 87.5 | 118.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 1000 items, above the node floor | 114 | 152.6 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 1000 items, above the node floor | 118.4 | 160.5 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 10000 items, above the node floor | 79.2 | 108.5 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 10000 items, above the node floor | 109.7 | 148.1 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 10000 items, above the node floor | 114.7 | 155.4 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 10000 items, above the node floor | 168.9 | 228.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 10000 items, above the node floor | 198.1 | 264.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 50000 items, above the node floor | 78.9 | 106.9 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 50000 items, above the node floor | 223.7 | 304.8 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 50000 items, above the node floor | 237.5 | 321.4 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 50000 items, above the node floor | 395.5 | 541.1 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 50000 items, above the node floor | 518.7 | 704.2 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| peak RSS, read at the largest scale (DR8, 100 MiB for a read at 50k) | 186064 | 102400 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a read at 50k peaks at about 182 MiB against DR8 100 MiB, measured twice |
| peak RSS, mutation at the largest scale (DR8, 120 MiB for a mutation at 50k) | 221328 | 122880 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a mutation at 50k peaks at about 212 MiB against DR8 120 MiB, measured twice |
| first index build at the largest scale (DR8, 6 s for 50k items and 500k events) | 12040 | 6000 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 11.1 s against DR8 6 s, and the figure is a wall time that a different runner would move on its own |
| re-index after a hand edit of the largest shard (DR8, 50 ms after a hand edit of the largest shard) | 253.8 | 50 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 257 ms against DR8 50 ms, and the figure is a wall time that a different runner would move on its own |
| index size as a multiple of the text it indexes (DR8, index at most 1.0x the text size) | 2.06 | 1 | x | OPEN MISS | 238637056 bytes of index over 115635217 bytes of records and events; open finding, not build-blocking: the landed index stores each record's and each event's source text, which the DR2 spike that measured 0.7x did not; the store owner has to decide whether the budget or the index changes |
| runtime dependencies (DR7, zero runtime dependencies) | 0 | 0 | packages | PASS |  |
| install size, unpacked (DR8, 1.5 MB unpacked) | 19568 | 1572864 | bytes | PASS | the `files` list has no dist/ yet, so this weighs the metadata only |
| bundle (DR8, 500 KB bundle) | NOT MEASURED: there is no build step in this tree, so no bundle exists to weigh | 512000 | bytes | PENDING |  |
| A1 write durability, worst of the parallel rounds (axis A1) | 1 | 1 | ratio | PASS | 5: 1, 24: 1, 60: 1, 200: 1 |
| A1 writers that crashed rather than reporting a refusal (axis A1) | 0 | 0 | writers | PASS | open finding, not build-blocking: the store has never met this: at 200 parallel writers a few processes throw an uncaught `Error: database is locked` from `pragma journal_mode = wal` at src/adapters/store/index-cache.ts:85, which runs before `pragma busy_timeout = 5000` at line 87 |
| A5 silent drops (axis A5) | 1 | 0 | cases | OPEN MISS | open finding, not build-blocking: the store has never met this: a record heading renamed out of the grammar is dropped from every query with no finding |
| A5 whole-store refusals (axis A5) | 0 | 0 | cases | PASS |  |
| A5 crashes (axis A5) | 0 | 0 | cases | PASS |  |
| output size per command, bytes and tokens | NOT MEASURED: no command writes to stdout yet, so there is no artefact to count; the accounting instrument is built and demonstrated on store artefacts in this report. Blocked on the command layer, which is being built in parallel; nothing under src/cli exists in this tree | the per-command budgets of the interface specification section A.3 | bytes | PENDING | the command layer, which is being built in parallel; nothing under src/cli exists in this tree |

