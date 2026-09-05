# Benchmarks

The acceptance bar for treadle is a measured margin over the reference on twelve axes, not an adjective.
Ten of the twelve are measured here.
Two are not, and each says so in its own row with the reason rather than as a gap, because a gap in a table reads as a pass to whoever skims it.

Six of the ten were filled in this run: A2, A6, A7, A8, A10 and A12.
All six needed a harness that drives the command surface rather than one artefact rendered from it, and that harness is `bench/axes/surface.ts`.
Four of the six meet their target, two miss it, and the two misses are reported with the mechanism behind each.

Reproduce it with `npm run bench`.
The appendix at the end of this file is `bench/results/bench.md` from run `2026-09-05T11-53-33-136Z`, with its heading levels demoted one step and nothing else changed.
[ADR-0008](architecture/adr/0008-the-measurement-rig.md) holds the method and what it departs from in DR8.

**One set of figures below is older than the appendix and is marked where it appears.**
The ten-run series in "Targets missed" was taken on 2026-09-04, before [#4](https://github.com/Abhijeet34/treadle/pull/4) and [#7](https://github.com/Abhijeet34/treadle/pull/7) landed, and none of it was re-taken.
It is kept because it is the only evidence this repository has of how far a figure on this machine drifts between runs, and a single run cannot replace it.
Everything else on this page was measured in the appended run.

## Read this before you read a number

This machine is shared with other work and was not idle for this run.
At the start of the appended run the 1-minute load average was 5.25 on 8 cores, with 53.2% of memory in use; across its twenty timed operations the 1-minute load ranged from 4.15 to 4.68, and it peaked at 55.11 while 289 parallel writers were running.
Waiting for quiet was tried and abandoned on earlier runs: it is not a method, and the load did not clear.

So the confound is recorded rather than dodged.
Every row in the appendix carries the load either side of it.
The appended run is the quietest four-scale run this rig has taken, which is why its timing rows sit below the ten-run series rather than above it, and the load column is where that is visible.

The six axes filled in this run are counts rather than timings.
A refusal either names a rule id or does not, and a record either landed in the intended store or did not, so the load column bounds how long those axes took and not what they measured.

## The machine

| Fact | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, `darwin 25.6.0`, `arm64` |
| Node | 24.11.1, below the 24.15.0 floor `package.json` declares |
| SQLite in Node | 3.50.4 |
| Seed | `20260905` |
| Appended run | 368 s of wall time, four corpora, 550 timed cold processes, 289 parallel writers, 206 damaged stores, 12 rendered command artefacts, 612 commands driven at the surface |

Node 24.11.1 is under the product's own floor, so every figure was taken on a runtime the shipped package refuses to run on.
The store is the only layer with a measurable cost here, it runs unchanged on both, and a figure without its runtime named is not a figure.

## The harness floor

Five nested floors, each a strict superset of the one above, so a difference prices exactly one thing.

| Floor | Best of 50 | Median |
|---|---|---|
| `/usr/bin/true` | 2.2 ms | 2.3 ms |
| `node -e` | 37.5 ms | 38.2 ms |
| `node` plus one JavaScript file | 40.3 ms | 41.8 ms |
| `node` plus one TypeScript file | 73.5 ms | 74.9 ms |
| `node` plus the store adapter loaded, no work | 118.3 ms | 120.3 ms |

Subtract 2.3 ms of spawn from any wall figure to get the program's own cost.
Type stripping costs 33.3 ms and loading the store costs 44.8 ms on top of it, so 78 ms of every cold invocation is module loading that a bundle would mostly remove.
The tree now builds one, weighed in the package table of the appendix, and `npm run build` prints that count against DR8's 512,000 limit and fails rather than warns if it goes over.
The timed children still launch from TypeScript source, so these figures and DR1's 45 ms budget on a 406 KB bundle are still not the same measurement.

The floors are measured after the corpora are generated and immediately before the operations they are subtracted from, so both share their conditions.
Measuring them first, on an idle machine, put 430 MB of corpus writeback into program cost and opened six small-scale rows by up to 58%.

## Targets met

| Target | Measured |
|---|---|
| A1, 100% of reported writes persisted at every N | 1.000 in every round; 200 of 200 at N=200, at a 1-minute load of 55.11 |
| A1, no writer crashed rather than refusing | 0 of 289, after #4 |
| A1, no lock or temp file left behind | 0 after every round |
| A3, output at most the reference's bytes | `status` 463 B against 1441, `backlog` 717 against 1781, `show` 273 against 322, `next` 380 against 659 |
| A3, every artefact inside its A.3 budget | 12 of 12 |
| A5, zero silent drops | 0 of 206 damaged stores, since #7; see below |
| A5, zero whole-store refusals | 0 of 206 |
| A5, zero crashes on malformed input | 0 of 206 |
| A6, zero mis-targets across all three scenarios | 0 of 10 writes with no explicit target, and 3 of 3 resolutions correct at the store seam |
| A6, every write prints the store identity | 10 of 10 writes that landed; the path is a separate finding below |
| A7, every item's state explained by its event chain | 50 of 50, over 250 events |
| A8, every illegal pair refused with a rule id | 22 of 22, naming `T1` and `T3` |
| A10, every invalid creation refused | 11 of 11, naming `C1`, `V4` and `V5`, with nothing created in any of the 11 |
| DR7, zero runtime dependencies | 0 |
| DR8, install size at most 1.5 MB unpacked | 284,611 bytes across 21 files |
| DR8, bundle at most 500 KB | 208,710 bytes |

A3 is the widest margin in the table.
The bare dashboard is 3.1x smaller than the reference's and the nine-item list 2.5x smaller, while carrying sprint identity, points, per-column WIP against limits, a ranked next-three and a blocked block that the reference has no concept of.
`test/cli/budget.test.ts` gates those bytes; its own header records that the token figures were taken outside the tree because a tokenizer is a package and the product ships zero runtime dependencies.
This rig carries all three tokenizers as development dependencies, so the token half is measured in-repo: bytes per token range from 2.44 on `next` to 3.88 on `backlog`, a 1.59x spread that a byte budget alone hides.

A6, A7, A8 and A10 are the four axes filled in this run that meet their target, and each beats the reference outright rather than narrowly.
The reference wrote to the wrong store in one scenario of three, kept no history at all, refused none of six illegal transitions and refused none of eleven invalid creations.

Of 35 budgets in the appended run: 28 pass, 0 fail, 7 open miss, 0 pending.

## Targets missed

Three of these are measured once in the appended run, at the command surface, and are counts rather than timings.

| Target | Reference | Measured | Miss |
|---|---|---|---|
| A2, every one of the 25 questions answerable with one command | 4 full, 6 partial, 15 none | 10 full, 7 partial, 8 none | 15 of 25 short of full |
| A12, every verb with a machine-readable object on both paths | mutations only, reads refuse the flag, errors on stdout | 25 of 26 invocations hold the contract, across 13 verbs | one invocation |
| A4, read and create below 150 ms at 50k, startup excluded | 89/90 ms at 100 items, 154/141 ms at 5k | read 154.0 ms, create 329.1 ms | 1.03x and 2.19x |

A2's eight unanswerable questions are 7, 8, 9, 10, 15, 19, 20 and 21, and every one of them needs an entity or a metric this tree does not implement: a sprint, an impediment, a board column, a relation, or a flow metric.
The per-question table is in the appendix under "A2, the 25 questions and how each was scored", with the command each question was put to and what a full answer would have to contain, so the scoring can be checked rather than trusted.
Seven more score partial: the answer is there for one named item but not for the workspace, or the set is one filter away but the window or the edge that would complete it is not stored.
Against the reference on the same list this is 2.5x as many questions answered whole, and 8 unanswerable against its 15.

A12's one miss is a defect in this product and is described below.

The remaining rows are the ten-run series, taken on 2026-09-04 on the tree before #4 and #7, and no figure in it was re-taken.
It is the only evidence here of run-to-run drift, so it is kept and marked rather than replaced by one quiet run.

| Target | Budget | Median of ten runs | Range | Over by |
|---|---|---|---|---|
| A4, create below 150 ms at 50k, startup excluded | 150 ms | 311.1 ms | 304.3 to 417.2 | 2.07x |
| A4, read below 150 ms at 50k, startup excluded | 150 ms | 148.6 ms | 147.7 to 157.9 | at the target, not under it |
| DR8, peak RSS on a read at 50k | 100 MiB | 182.0 MiB | | 1.82x |
| DR8, peak RSS on a mutation at 50k | 120 MiB | 216.6 MiB | | 1.81x |
| DR8, first index build at 50k | 6,000 ms | 11,074 ms | 10,578 to 25,920 | 1.85x |
| DR8, re-index after a hand edit of the largest shard | 50 ms | 261.8 ms | 253.8 to 889.7 | 5.2x |
| DR8, index size against the text it indexes | 1.0x | 2.06x | 2.06x in every run | 2.06x |

Read at 50k is the one worth reading carefully.
Its median sat between 147.7 and 150.1 ms in nine of the ten pre-#4 runs and reached 157.9 in the tenth, and the appended run's 154.0 ms p95 on the quietest machine this rig has seen sits in the same band.
Read is at the target rather than under it, and a claim that it passes would rest on which run got quoted.

Create misses on every run and misses wide.
The mechanism is in the corpus table: a create appends one record to the largest shard, which holds 2,176 records in 1.06 MiB, and the whole shard is rewritten and re-indexed.

`list` and `transition` are not axis targets but bound the same work: `transition` is the most stable figure in the whole rig at 428.9 to 447.6 ms across ten runs, and `list` is 161.0 to 164.0 in eight runs and 209.0 and 491.7 in the two loaded ones.

Five of the DR8 rows are budgets the landed store has never met, and DR8's numbers came from throwaway spikes that no longer exist rather than from this code.
They are recorded as open misses: printed with their number, not failing a build for standing still.
A budget nobody has ever met is a finding, not a regression.

## The three defects the rig found, and what happened to them

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
Re-measured against the tree that carries it: **0 crashes in 1,445 writers across five runs**, every round reporting 200 of 200 at N=200 with no refusals, at 1-minute loads from 3.13 to 116.12, which is heavier contention than any of the runs that produced the crash.
The appended run adds a sixth clean round set at a peak load of 55.11.
The budget is armed, so a return of it fails the build rather than printing as an open miss.

**Closed: a record heading renamed out of the grammar was dropped in silence.**

This page previously reported it as open, and that report is now out of date rather than wrong: it was true of the tree that produced the earlier appendix.
Rewriting `# wi-000026: ...` as `## wi-000026: ...` in a shard removed that record from every query and produced no finding, which is the reference's own headline failure present in treadle.

[#7](https://github.com/Abhijeet34/treadle/pull/7) closed it by resynchronising on a heading a hand edit reshaped, discriminated by a record's four mandatory field lines.
Measured here: the shaped heading-rename case reports `refusal names the record` with one finding, and the whole 206-store A5 corpus reports **0 silent drops**, where every run before #7 reported exactly one.
The budget is armed on the same reasoning #4's was, and `test/store/record-boundary.test.ts` holds the same property as a test, so the gate is the second line rather than the only one.

A5 is still `PARTIAL` rather than `MET` for the other half of its target: 1 of 206 damaged stores produced a refusal that names the file rather than the record, when a single byte was changed on line 1 and the file stopped being a record file this tool wrote.
That refusal is correct and loud; it is the granularity that misses.

**Still open: a refusal the parser raises ignores `--out json`.**

Axis A12 found this and reports it as a miss rather than fixing it.
`src/cli/main.ts:205` renders a parse-level refusal with `emit(env, result, {})`, an empty flag set, so the rendering the caller asked for is dropped and the default one is used instead.

```text
$ treadle version --fields id --out json
err VALIDATION -
rule C1
"cause --fields cannot apply to version, and ignoring it would answer a question you did not ask
```

Three parse-level refusals were probed and all three ignored the flag: a flag refused for a command, a flag refused for a different command, and an unknown command.
Every refusal raised past the parser renders as asked, which is why 25 of the 26 invocations hold and the failure is narrow rather than general.
It matters because the caller who most needs the machine-readable form is the one that got the invocation wrong.

No defect was fixed by this branch.
A benchmark that quietly repairs what it measures is measuring something else, and the value of that rule is visible in the first two: the rig found them, another worker fixed each, and the rig then verified both without either side taking the other's word for it.

## What is not measured, and what unblocks it

Two axes, and neither is blocked on a harness any more.

| Axis | Why it cannot be scored |
|---|---|
| A9 metric coverage | no metric is implemented in this tree; nothing under `src` computes velocity, cycle time or a burndown series, so there is nothing to score and a figure here would be a figure about a harness |
| A11 harness neutrality | half its target has nothing to score: no adapter generator exists, because [ADR-0012](architecture/adr/0012-the-extension-surface-that-does-not-ship.md) refuses A.8 rule 3 for v1 |

A11's other half, counting the files the full feature set writes outside the workspace, is reachable through the same harness the six new axes use.
It is not run here rather than reported half done, because A6 already measures the property that half exists to catch and a second partial row would add a number without adding a fact.

The six axes filled in this run are measured but not gated.
A7, A8 and A10 are deterministic pass-or-fail properties that transfer between machines, which is exactly what `bench:gate` exists for, so arming them is the obvious next step and needs a budget key each rather than more measurement.

## How the surface axes are driven

The driver is `src/cli/main.ts`'s own `run`, the function `bin/treadle.js` shims, with argv, the working directory, the environment and both streams passed in as arguments.
No process is spawned per invocation, because 612 spawns would have cost about 70 seconds of Node startup to measure behaviour that startup cannot change.

That is a claim, so it is checked rather than asserted.
Each of the six axes runs one of its own reads through the shipped `bin/treadle.js` in a real child process and compares the bytes: **5 of 5 cross-checks matched exactly**, on exit status, stdout and stderr, from 200 to 734 bytes each.
A6 is the sixth axis and needs no cross-check of its own, because every one of its rows is verified by reading both stores back rather than by reading what the command printed.

Each axis builds its own workspace by running `init` and `file`, so nothing is written by a fixture that a command could not have written.
Every axis reports the number of commands it drove: 37 for A2, 38 for A6, 303 for A7, 177 for A8, 25 for A10 and 32 for A12.
A count of zero is the tell that an axis reported a verdict over nothing.

## How stable a figure here is

Ten four-scale runs, because a benchmark whose own repeatability is unknown cannot report a regression.

- The worst run-to-run drift of any operation's program cost was **19.9%** across three runs taken before the load instrument existed, on `list` at 1,000 items: 87.5, 87.4 and 104.7 ms.
- The **p95 moved 68.9%** between two identical runs. The gate therefore reads the median and reports the p95 without gating on it.
- The in-process median was measured as an alternative and drifts 17.8% on the same case, so the variance is the machine rather than the statistic.
- Fixed costs are taken from the best of fifty rather than the median. Across five runs the best-of-N type-stripping cost spread 0.11 ms while the median-based one spread 14.7 ms.
- At 50k, where the work dominates, `transition` spread 4.4% and `get` 6.9% across all ten runs, including the loaded ones.

The tolerance is 35%, which clears the measured 19.9% by 1.76x.
The appended run still has two timing rows open, `create` and `transition` at 10,000 items, 7.6% and 8.9% over their limits on a machine at a load of 4.
That is the gate reporting the machine rather than the code, which is exactly why the timing rows are not armed.

The six surface axes have no such spread to report.
Each ran in three recorded four-scale runs during this task and returned the same verdict and the same counts in all three, which is what a deterministic corpus and a fixed rule table buy.

## Confounds that could not be eliminated

Stated plainly, because each one bounds what these numbers support.

1. **The machine was shared throughout.** Sibling workers ran during every run, and the appended run started at a 1-minute load of 5.25 on 8 cores. Load is recorded for the later runs only; the earlier ones contribute timings without it.
2. **The ten-run series predates #4 and #7.** It measures the store before the busy-timeout fix and before the heading resynchronisation, while the appended run measures the store after both. A series figure and an appendix figure are not measurements of the same store.
3. **Node 24.11.1 is below the product's declared 24.15.0 floor.** The store runs unchanged on both, and no figure here was taken on the runtime the package will ship against.
4. **The timed children run from TypeScript source, not from the bundle the package ships.** Every timed figure carries 33.3 ms of type stripping plus 44.8 ms of module loading that the bundle would mostly remove.
5. **The timing limits are calibrated to this machine and are not armed anywhere.** They have never been measured on a CI runner.
6. **The corpora are not DR2's corpora.** Ours holds 2,176 records in 1.06 MiB in its largest shard against the design's 2,084 in 1.69 MB, so a millisecond-for-millisecond comparison with DR2 carries that difference.
7. **Every reference figure is quoted from the prior-art axes table and none was re-derived.** The reference implementation is not in this tree and was never run.
8. **`purge` needs root and was not run**, so a cold process here is never a cold page cache.
9. **A2's three scores are a judgement, made once, by one worker.** The predicate behind each verdict is in `bench/axes/a2-questions.ts` and every row is published with its command, so the judgement can be disputed row by row rather than only in aggregate.
10. **A10's eleven rules are an enumeration this rig made.** The prior-art table names "11 rules" without numbering them, so five are taken from its own invalid-at-creation column and six from the field dictionary that column defers to; each row names the cell it came from.

## What the gate enforces

`npm run bench:gate` fails on what transfers between machines: durability under parallel writers, silent drops, whole-store refusals and crashes on malformed input, the runtime dependency count, the install size, the bundle size and the per-command output budgets.
Demonstrated: with the budgets as committed it exits 0, and with the install-size limit tightened to 1,000 bytes it reports `FAIL: install size, unpacked = 19568 bytes, limit 1000` and exits 1.

It does not fail on the per-operation timing limits.
They were derived on this Apple M2 and have never been measured on a GitHub runner, so a red build there would be evidence about the runner.
`bench/budgets.json` carries `timing.enforced: false` with that reason, the rows still print with their numbers, and arming them means re-deriving on the runner once the runner's own drift has been measured.

## The run

## treadle benchmark run 2026-09-05T11-53-33-136Z

Started 2026-09-05T11:53:33.136Z, finished 2026-09-05T11:59:41.357Z, 368.2 s of wall time.
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
| at the start | 5.25 | 15.07 | 12.6 | 7670 | 53.2% | 1 |
| at the end | 10.36 | 19.53 | 15.79 | 7770 | 52.6% | 2 |

Across the 20 timed operations the 1-minute load ranged from 4.15 to 4.68.

### What the harness itself costs

Each row is a strict superset of the one above it, so a difference prices exactly one thing.
The spawn floor is subtracted from every net column below; the node floor is what the CI gate compares against.

| Floor | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| spawn floor (/usr/bin/true) | 50 | 0 | 3.0 | 2.2 | 2.3 | 2.5 | 2.6 | 50/50 | n/a | NOT MEASURED | NOT MEASURED | 4.52 to 4.52, 2 node proc |
| node floor (node -e) | 50 | 51 | 38.4 | 37.5 | 38.2 | 39.4 | 41.5 | 50/50 | 37.0 | NOT MEASURED | NOT MEASURED | 4.52 to 4.56, 2 node proc |
| node + one JavaScript file | 50 | 51 | 42.0 | 40.3 | 41.8 | 43.5 | 46.0 | 50/50 | 41.1 | 0.0 | 44.8 | 4.56 to 4.56, 2 node proc |
| node + one TypeScript file (type stripping) | 50 | 51 | 79.3 | 73.5 | 74.9 | 78.6 | 80.4 | 50/50 | 76.3 | 0.0 | 68.6 | 4.56 to 4.44, 2 node proc |
| node + the store adapter loaded, no work done | 50 | 51 | 133.1 | 118.3 | 120.3 | 125.0 | 126.7 | 50/50 | 122.7 | 0.0 | 96.6 | 4.44 to 4.56, 2 node proc |

Type stripping costs 33.3 ms and loading the store adapter costs 44.8 ms on top of it, both taken from the best of N: they are fixed costs, and the cleanest launch of the fifty is the closest thing to an uncontaminated reading of one.
DR1 measured its budget on a 406 KB bundle. The tree now builds one, weighed in the package table above, but the timed children below still run from TypeScript source and carry both of those costs; bundling them is what would make these figures comparable with DR1's.

### Corpora

Written through the landed store, not synthesised as files. Item counts are read back from the store after generation.

| Items in store | Shards | Largest shard | ready matches | Records bytes | Events bytes | Index bytes | Generated |
|---|---|---|---|---|---|---|---|
| 100 | 23 | 2024-12: 9 records, 4.2 KiB | 9 | 49.3 KiB | 175.9 KiB | 520.0 KiB | 0.4 s |
| 1000 | 24 | 2025-04: 55 records, 27.5 KiB | 130 | 498.9 KiB | 1.7 MiB | 4.6 MiB | 0.6 s |
| 10000 | 24 | 2025-08: 477 records, 238.7 KiB | 1450 | 4.9 MiB | 17.2 MiB | 45.4 MiB | 3.7 s |
| 50000 | 24 | 2025-08: 2176 records, 1.1 MiB | 7295 | 24.4 MiB | 85.8 MiB | 227.6 MiB | 28.1 s |

### Latency, one cold process per sample

`net p95` is the wall p95 with the spawn floor removed. `in-process p95` excludes Node startup and module loading entirely, which is the form axis A4 targets.
These are store operations rather than commands: the timed children call the store directly so a millisecond is not mostly argument parsing. The command surface is measured by axes A2, A6, A7, A8, A10 and A12 below, which score behaviour rather than time.

#### 100 items, 23 shards, largest shard 9 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 119.7 | 118.0 | 121.2 | 126.1 | 132.3 | 30/30 | 123.7 | 4.6 | 97.0 | 4.56 to 4.68, 2 node proc |
| get | 30 | 31 | 121.1 | 120.2 | 121.4 | 127.7 | 130.4 | 30/30 | 125.4 | 8.3 | 99.0 | 4.68 to 4.38, 2 node proc |
| list | 30 | 31 | 125.5 | 120.8 | 122.0 | 130.9 | 133.5 | 30/30 | 128.6 | 8.9 | 99.2 | 4.38 to 4.38, 2 node proc |
| create | 30 | 31 | 144.5 | 141.4 | 143.8 | 149.2 | 151.8 | 30/30 | 146.9 | 33.6 | 100.9 | 4.38 to 4.59, 2 node proc |
| transition | 30 | 31 | 146.2 | 144.3 | 148.1 | 152.3 | 154.6 | 30/30 | 150.0 | 36.7 | 101.3 | 4.59 to 4.38, 2 node proc |

First index build with the index deleted: 55 ms. Re-index after a hand edit of the largest shard: 14.7 ms. Both in-process, one sample each.

#### 1000 items, 24 shards, largest shard 55 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 118.4 | 117.2 | 118.3 | 124.7 | 125.4 | 30/30 | 122.4 | 4.7 | 97.3 | 4.38 to 4.35, 2 node proc |
| get | 30 | 31 | 124.8 | 122.9 | 124.4 | 126.6 | 128.2 | 30/30 | 124.3 | 11.5 | 101.6 | 4.35 to 4.4, 2 node proc |
| list | 30 | 31 | 127.6 | 126.3 | 127.3 | 133.0 | 138.7 | 30/30 | 130.7 | 17.2 | 101.9 | 4.4 to 4.45, 2 node proc |
| create | 30 | 31 | 147.3 | 151.1 | 155.1 | 157.0 | 157.5 | 30/30 | 154.7 | 43.5 | 104.3 | 4.45 to 4.26, 2 node proc |
| transition | 30 | 31 | 159.0 | 158.8 | 161.0 | 168.5 | 169.1 | 30/30 | 166.2 | 50.2 | 104.2 | 4.26 to 4.23, 2 node proc |

First index build with the index deleted: 211 ms. Re-index after a hand edit of the largest shard: 22.3 ms. Both in-process, one sample each.

#### 10000 items, 24 shards, largest shard 477 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 117.2 | 116.9 | 120.6 | 125.7 | 126.2 | 30/30 | 123.3 | 5.3 | 97.3 | 4.23 to 4.46, 2 node proc |
| get | 30 | 31 | 154.0 | 149.7 | 154.0 | 157.3 | 158.2 | 30/30 | 155.0 | 38.0 | 118.9 | 4.46 to 4.46, 4 node proc |
| list | 30 | 31 | 157.3 | 155.0 | 160.2 | 166.1 | 177.4 | 30/30 | 163.8 | 46.5 | 119.0 | 4.46 to 4.26, 4 node proc |
| create | 30 | 31 | 192.5 | 223.2 | 288.0 | 322.2 | 365.4 | 30/30 | 319.9 | 171.7 | 125.1 | 4.26 to 4.31, 4 node proc |
| transition | 30 | 31 | 309.8 | 294.2 | 329.9 | 402.3 | 453.3 | 30/30 | 400.0 | 231.3 | 136.8 | 4.31 to 4.42, 4 node proc |

First index build with the index deleted: 2454 ms. Re-index after a hand edit of the largest shard: 95.2 ms. Both in-process, one sample each.

#### 50000 items, 24 shards, largest shard 2176 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 20 | 21 | 145.2 | 149.2 | 160.9 | 172.3 | 172.7 | 20/20 | 170.0 | 6.3 | 97.0 | 4.39 to 4.44, 4 node proc |
| get | 20 | 21 | 363.2 | 257.5 | 259.2 | 274.4 | 301.2 | 20/20 | 272.1 | 154.0 | 183.4 | 4.44 to 4.16, 5 node proc |
| list | 20 | 21 | 276.4 | 271.9 | 273.4 | 278.3 | 286.7 | 20/20 | 276.0 | 162.1 | 182.3 | 4.16 to 4.15, 2 node proc |
| create | 20 | 21 | 327.4 | 446.4 | 453.3 | 462.0 | 469.5 | 20/20 | 459.6 | 329.1 | 219.6 | 4.15 to 4.15, 2 node proc |
| transition | 20 | 21 | 573.0 | 558.3 | 584.5 | 595.7 | 632.1 | 20/20 | 593.3 | 464.5 | 260.7 | 4.15 to 4.04, 2 node proc |

First index build with the index deleted: 10402 ms. Re-index after a hand edit of the largest shard: 260.2 ms. Both in-process, one sample each.

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
| status | 463 | 1074 | yes | 156 | 167 | 167 | 2.97 | 1441 | 463 B against 1441 B, 0.32x |
| backlog | 717 | 964 | yes | 185 | 185 | 185 | 3.88 | 1781 | 717 B against 1781 B, 0.40x |
| backlog-empty | 120 | 140 | yes | 35 | 37 | 37 | 3.43 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| show | 273 | 310 | yes | 89 | 91 | 92 | 3.07 | 322 | 273 B against 322 B, 0.85x |
| next | 380 | 514 | yes | 156 | 147 | 148 | 2.44 | 659 | 380 B against 659 B, 0.58x |
| explain | 429 | 754 | yes | 151 | 150 | 149 | 2.84 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition | 131 | 230 | yes | 44 | 44 | 44 | 2.98 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-already | 100 | 110 | yes | 37 | 37 | 37 | 2.7 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-dry-run | 163 | 250 | yes | 53 | 53 | 53 | 3.08 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-preview | 233 | 254 | yes | 76 | 69 | 69 | 3.07 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| not-found | 156 | 164 | yes | 51 | 49 | 47 | 3.06 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| guard-refused | 237 | 278 | yes | 80 | 76 | 76 | 2.96 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |

### Package

| Fact | Value |
|---|---|
| Runtime dependencies | 0 |
| Development dependencies | 7 |
| Packed | 63.9 KiB |
| Unpacked | 277.9 KiB |
| Files in the package | 21 |
| Bundle | 203.8 KiB |

### The twelve comparison axes

| Axis | Verdict | Observed | Reference | Target | ops | samples | peak load 1m |
|---|---|---|---|---|---|---|---|
| A1 Write durability | MET | 5: 5/5, 24: 24/24, 60: 60/60, 200: 200/200; every reported write is on disk, zero refusals, zero lock or temp files left. Zero writers crashed | 100% at 5, 24, 60 on both builds (prior-art E1); 200 not run | 100% at every N, and zero silent mis-targets under the A6 scenarios | 289 | 4 | 55.11 |
| A2 Question coverage | MISSED | 10 full, 7 partial, 8 none, out of 25, against the reference's 4 full, 6 partial, 15 none; the 8 that score none are 7, 8, 9, 10, 15, 19, 20, 21, and every one of them needs an entity or a metric this tree does not implement | 4 full, 6 partial, 15 none | 25 full | 37 | 25 | 12.59 |
| A3 Token cost | MET | status 463 B against 1441 B, backlog 717 B against 1781 B, show 273 B against 322 B, next 380 B against 659 B; all 12 artefacts inside their A.3 budget | 1441, 1781, 322, 659 bytes (prior-art E10) | at most the same bytes for the same information, every extra byte attributable to a field the reference lacks | 12 | 12 | not sampled |
| A4 Latency at scale | MISSED | at 50000 items, startup excluded: read p95 154.0 ms, create p95 329.1 ms | 89/90 ms at 100, 154/141 ms at 5k, startup 83 ms (prior-art E11) | below 150 ms at 50k for read and create, startup excluded and reported separately | 570 | 550 | not sampled |
| A5 Malformed-input robustness | PARTIAL | 206 damaged stores read: 2 edit removed the record, 90 refusal names the record, 113 absorbed, 1 refusal names the file only | heading rename: silent drop; bad metadata line: whole-store refusal; duplicate id: silent; self-edge: silent; cycle: accepted | zero silent drops, zero whole-store refusals, every refusal names the record | 206 | 206 | 55.11 |
| A6 Mis-target rate | MET | 0 mis-targets in 10 writes with no explicit target, across all three scenarios; 1 explicit --workspace write landed where it was pointed; 3 of 3 seam resolutions correct; no command invented a store; every write that landed printed the workspace identity in its envelope, while the filesystem path is printed by status, doctor and --preview but not by an applied write | 1 of 3 scenarios writes elsewhere silently (prior-art E2) | 0 of 3; every write prints the store identity | 38 | 11 | 12.59 |
| A7 Audit answerability | MET | 50 of 50 items explained: the named event is in the log, the replay of 250 events ends in the state shown, and every event carries an actor | 0 of 50, the reference keeps no history | 50 of 50 | 303 | 50 | 11.98 |
| A8 Lifecycle enforcement | MET | 22 of 22 illegal pairs refused naming a rule id, 20 legal pairs behaved as the table says, 7 same-state requests returned the idempotent marker | 0 refused of 6 illegal pairs tried (prior-art E8) | every illegal pair refused with a guard id | 177 | 49 | 11.18 |
| A9 Metric coverage | NOT MEASURED | NOT MEASURED: no metric is implemented in this tree; nothing under src computes velocity, cycle time or a burndown series, so there is nothing to score and a figure here would be a figure about a harness | 0 of 14 | 14 of 14, each matching the spreadsheet | 0 | 0 | not sampled |
| A10 Type validation | MET | 11 of 11 refused with a rule id and nothing created; rule ids C1, V4, V5 | 0 of 11 refused, the reference has a single free-text kind | 11 of 11 | 25 | 12 | 11.18 |
| A11 Harness neutrality | NOT MEASURED | NOT MEASURED: the target has two halves and one of them has nothing to score: no adapter generator exists, because ADR-0012 refuses A.8 rule 3 for v1, so "adapters optional and generated" cannot be measured at all. The counting half is now reachable through the same harness the other axes use and is not run here rather than being reported half done | setup writes 4 files across 3 harnesses | 0 required; adapters optional and generated | 0 | 0 | not sampled |
| A12 Output contract | MISSED | 25 of 26 invocations held the contract across 13 verbs; version failure did not, and 3 of 3 probed parse-level refusals ignored --out json because src/cli/main.ts raises them before the rendering is chosen | mutations only; reads refuse the flag with exit 2; errors on stdout (prior-art E9) | every verb, both paths | 32 | 26 | 11.18 |

#### What each unfilled axis is waiting for

- **A1**: the mis-target half of this target is axis A6, which resolves a store from a working directory and needs the command layer
- **A9**: the metrics layer, which no landed commit begins
- **A11**: an adapter generator to score, which ADR-0012 refuses for v1

#### A2, the 25 questions and how each was scored

One command per question. `full` means the command answers the question whole, `partial` that it answers part of it, `none` that no command in the inventory can be aimed at it.
The reference scored 4 full, 6 partial and 15 none on this same list.

| # | Question | Command | Exit | Score | What a full answer needs | Note |
|---|---|---|---|---|---|---|
| 1 | what is ready | `backlog --state ready` | 0 | full | a list of the ready items in one call | one filter on the list verb answers it whole |
| 2 | what is blocked and by what | `explain a2-story` | 0 | partial | a list of the blocked items across the workspace, each with its blockers | the blocked flag and its blocker ids are printed per item by explain; no verb lists the blocked items, and no verb writes a relation, so the flag cannot yet be true |
| 3 | why is X blocked | `explain a2-story` | 0 | partial | the blockers of X with the reason or impediment behind each | explain names the blocker ids, which is what the reference managed too; there is no impediment entity and no relation verb, so nothing can put an id in that list |
| 4 | what is in progress | `backlog --state in_progress` | 0 | full | a list of the in-progress items in one call | the same filter, on the same verb |
| 5 | who is working on X | `show a2-doing` | 0 | full | the assignee of X | the record verb prints the assignee |
| 6 | what finished this week | `backlog --state done` | 0 | partial | the done items narrowed to a time window | the done set is one filter away; no verb takes a time window, and no record carries the instant it was finished, so the window half is missing |
| 7 | what is the sprint goal | `none in the inventory` | no command | none | the goal of the active sprint | there is no sprint entity in this tree; status names sprint in its absent_features line |
| 8 | committed versus capacity | `none in the inventory` | no command | none | the committed points of the active sprint against its capacity | both halves need the sprint entity, which does not exist |
| 9 | velocity over the last three sprints | `none in the inventory` | no command | none | a velocity figure per sprint with the formula that produced it | no metric is implemented; this is the same absence axis A9 is NOT MEASURED for |
| 10 | cycle time of X | `none in the inventory` | no command | none | the elapsed time between two named state instants for X | no verb computes a duration; the event log carries the instants, which is the input to the answer rather than the answer |
| 11 | what is aging | `next` | 0 | partial | the items ordered by how long they have sat, whatever state they sit in | the age in days of every ready item is a scored component of the ranking and is printed; items in other states are not aged, and status separately counts what is past its due date |
| 12 | is X ready per the definition of ready | `explain a2-bug` | 0 | full | a verdict per ready-gate rule for X | the gate block names each failing rule and what would satisfy it |
| 13 | does X meet the definition of done | `explain a2-story` | 0 | full | a verdict per done-gate rule for X | the same block carries the done gate beside the ready one |
| 14 | what changed on X and when | `explain a2-story` | 0 | partial | the change history of X, each entry with its instant | explain names the one event that produced the current state and its instant; there is no history verb, so the rest of the chain is in the committed event log rather than behind a command |
| 15 | who changed X | `explain a2-story` | 0 | none | the actor on the change to X | every event carries an actor and no read surface prints one; the answer is in the store and not behind a command |
| 16 | which items belong to epic E and how far along is it | `show a2-child` | 0 | partial | the children of E with a rollup of their states | the parent edge is writable and printed, which is more than the reference managed; no verb lists an epic children and none rolls their states up |
| 17 | what is the priority order | `backlog` | 0 | full | the items in priority order, with the order stated rather than implied | the list prints the sort it applied, so the order is a stated fact rather than a convention |
| 18 | what duplicates X | `backlog --resolution duplicate` | 0 | partial | the items that duplicate X, named against X | the items stopped as duplicates are one filter away, and nothing records which item each one duplicated, because that is a relation |
| 19 | which bug did story X cause | `none in the inventory` | no command | none | the bugs whose caused-by edge names X | caused-by is a relation, and no relation can be written in this tree |
| 20 | open impediments and their age | `none in the inventory` | no command | none | the open impediments with the days each has stood | impediment is not an entity here; status names it in its absent_features line |
| 21 | is any column over its limit | `none in the inventory` | no command | none | each board column against its work-in-progress limit | there is no board, so guard G3 evaluates against no column at all |
| 22 | what will this command do | `transition a2-story in_progress --dry-run` | 0 | full | the fields the command would change and the exit status it would return, without changing anything | every mutation takes --dry-run, which runs every guard against a store that cannot write, and --preview, which names the store and the guards without evaluating one |
| 23 | why did X not appear in ready | `backlog --state ready --explain-absence a2-doing` | 0 | full | the clause that excluded X from that list | the list verb answers the absence directly, naming the first clause that excluded the id |
| 24 | what should I do next and why | `next` | 0 | full | a ranked list with the components and the weights that produced the order | the weights are in the output rather than in the documentation, so two runs are comparable byte for byte |
| 25 | is the store healthy | `doctor` | 0 | full | a verdict over the whole store, with the count it checked | doctor reports what the files say that no write path would have accepted, and prints the count it checked so a clean answer over nothing is impossible |

#### A6, where each write landed

The landing column is read out of both stores after the write, not out of what the command printed.

| Scenario | Exit | Expected | Landed in | Identity printed | Store path printed |
|---|---|---|---|---|---|
| cwd, from the workspace root | 0 | intended | intended | workspace-a6 | not on this path |
| cwd, from a subdirectory | 0 | intended | intended | workspace-a6 | not on this path |
| cwd, from an unrelated directory | 6 | nowhere | nowhere | - | not on this path |
| config in parent, run from the subdirectory under a decoy config | 0 | intended | intended | workspace-a6 | not on this path |
| config in parent, run from the root under a decoy config | 0 | intended | intended | workspace-a6 | not on this path |
| environment override, TREADLE_WORKSPACE naming the decoy | 0 | intended | intended | workspace-a6 | not on this path |
| environment override, TREADLE_HOME naming the decoy | 0 | intended | intended | workspace-a6 | not on this path |
| environment override, TREADLE_STORE naming the decoy | 0 | intended | intended | workspace-a6 | not on this path |
| environment override, TREADLE_DIR naming the decoy | 0 | intended | intended | workspace-a6 | not on this path |
| environment override, WORKSPACE naming the decoy | 0 | intended | intended | workspace-a6 | not on this path |
| the supported --workspace flag, run from the intended root | 0 | decoy | decoy | a6decoy | not on this path |

At the store seam, which is where resolution is decided: 3 of 3 resolutions correct.

#### A7 and A8, what the walk and the pair sweep did

A7's walk applied 200 transitions and visited cancelled, done, draft, in_progress, on_hold, ready; 1 attempts on a legal edge were refused by a guard and are not counted as applied.
A8's refusals on illegal pairs named T1 and T3; the legal edges a guard refused were in_progress->ready T6, in_progress->in_review G5, in_review->done G6, which is the rule table working rather than failing.

#### A10, the eleven creation rules and what each refusal named

The eleven are enumerated from the prior-art model: five from its own invalid-at-creation column, six from the field dictionary that column defers to.
A twelfth row is this product requiring a field the model gives a default, and is reported beside the eleven rather than counted in them.

| # | Rule | Source | Exit | Code | Rule id | Nothing created | Cause |
|---|---|---|---|---|---|---|---|
| 1 | an epic without an outcome | 2.1, epic row, invalid at creation | 2 | VALIDATION | V4 | yes | a epic needs outcome at creation |
| 2 | a bug without a severity | 2.1, bug row, invalid at creation | 2 | VALIDATION | V4 | yes | a bug needs severity at creation |
| 3 | a bug without repro steps | 2.1, bug row, invalid at creation | 2 | VALIDATION | V4 | yes | a bug needs repro_steps at creation |
| 4 | a spike without a question | 2.1, spike row, invalid at creation | 2 | VALIDATION | V4 | yes | a spike needs question at creation |
| 5 | a spike without a timebox | 2.1, spike row, invalid at creation | 2 | VALIDATION | V4 | yes | a spike needs timebox_hours at creation |
| 6 | a type outside the closed set of six | 2.14, common field type | 2 | VALIDATION | C1 | yes | file needs a type, one of epic, story, task, bug, spike, chore |
| 7 | a title over 200 characters | 2.14, common field title | 2 | VALIDATION | V4 | yes | title is 201 characters and the limit is 200, which is 1 over |
| 8 | a priority outside 1 to 5 | 2.14, common field priority | 2 | VALIDATION | V4 | yes | priority must be a whole number from 1 to 5 |
| 9 | points off the workspace scale | 2.14, common field points | 2 | VALIDATION | V4 | yes | points must be one of the workspace scale 1, 2, 3, 5, 8, 13 |
| 10 | a label that is not a slug | 2.14, common field labels | 2 | VALIDATION | V4 | yes | labels must be slugs; Not A Slug is not one |
| 11 | a field the dictionary does not define | 2.14, the dictionary is closed | 2 | VALIDATION | V5 | yes | squad is not a field of any work item |
| 12, beyond the eleven | a bug without a found-in stage | this product requires it; 2.14 gives it a default instead | 2 | VALIDATION | V4 | yes | a bug needs found_in at creation |

#### A12, every verb on both paths

A row holds when the object is on the expected stream, the other stream is empty, the exit status matches the path, and the object validates against the schema this repository ships for it.

| Verb | Success schema, exit | Failure schema, exit, code | Both hold |
|---|---|---|---|
| init | init/1, exit 0 | error/1, exit 2, VALIDATION | yes |
| file | file/1, exit 0 | error/1, exit 2, VALIDATION | yes |
| show | show/1, exit 0 | error/1, exit 5, NOT_FOUND | yes |
| backlog | backlog/1, exit 0 | error/1, exit 2, VALIDATION | yes |
| transition | transition/1, exit 0 | error/1, exit 3, GUARD_REFUSED | yes |
| mark | mark/1, exit 0 | error/1, exit 2, VALIDATION | yes |
| evidence | evidence/1, exit 0 | error/1, exit 2, VALIDATION | yes |
| doctor | doctor/1, exit 0 | error/1, exit 6, STORE_UNAVAILABLE | yes |
| next | next/1, exit 0 | error/1, exit 6, STORE_UNAVAILABLE | yes |
| explain | explain/1, exit 0 | error/1, exit 5, NOT_FOUND | yes |
| status | status/1, exit 0 | error/1, exit 6, STORE_UNAVAILABLE | yes |
| help | help/1, exit 0 | error/1, exit 2, VALIDATION | yes |
| version | version/1, exit 0 | no object, exit 2, no code | **no**: failure no result object was written to the expected stream |

### DR8 budget gate

Timing limits are program cost at the median: the operation's wall median minus the runner's own `node -e` median, measured in the same job.
Tolerance 35% over the committed limit, because six four-scale runs on 2026-09-05 put the worst run-to-run drift of any operation's program cost at 19.9% across the three runs where the machine was quiet (list at 1,000 items, 87.5 / 87.4 / 104.7 ms); 35% clears that by 1.76x. The in-process median was measured as an alternative and drifts 17.8% on the same case, so the statistic is not what the variance comes from. A run taken under load drifts further and shows up as an open miss, which is the correct outcome for a gate nobody has armed yet. The p95 moved 68.9% between two runs, which is why the gate reads the median and reports the p95 without gating on it.
Limits derived from run 2026-09-04T23-39-28-387Z on 2026-09-04 (Apple M2, 8 cores, darwin 25.6.0, Node 24.11.1).
35 budgets: 28 pass, 0 fail, 7 open miss, 0 pending.
An open miss is a budget the product has never met. It is reported with its number and does not fail a build for standing still; a regression against a budget that was met does.

| Budget | Observed | Limit | Unit | Status | Note |
|---|---|---|---|---|---|
| cold start: the store layer loaded, above the runner's own node floor | 86.8 | 213 | ms | PASS | runner node floor measured in this job at 38.2 ms median |
| identity median at 100 items, above the node floor | 83 | 240.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 100 items, above the node floor | 83.2 | 232.3 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 100 items, above the node floor | 83.8 | 268.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 100 items, above the node floor | 105.6 | 255.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 100 items, above the node floor | 109.9 | 229.6 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 1000 items, above the node floor | 80.1 | 106.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 1000 items, above the node floor | 86.2 | 115.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 1000 items, above the node floor | 89.1 | 121 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 1000 items, above the node floor | 116.9 | 156.3 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 1000 items, above the node floor | 122.8 | 162.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 10000 items, above the node floor | 82.4 | 278.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 10000 items, above the node floor | 115.8 | 438.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 10000 items, above the node floor | 122 | 311.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 10000 items, above the node floor | 249.8 | 232.2 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 10000 items, above the node floor | 291.7 | 267.8 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 50000 items, above the node floor | 122.7 | 369.8 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 50000 items, above the node floor | 221 | 882.1 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 50000 items, above the node floor | 235.2 | 549.9 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 50000 items, above the node floor | 415.1 | 584.4 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 50000 items, above the node floor | 546.3 | 723.3 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| peak RSS, read at the largest scale (DR8, 100 MiB for a read at 50k) | 186624 | 102400 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a read at 50k peaks at about 182 MiB against DR8 100 MiB, measured twice |
| peak RSS, mutation at the largest scale (DR8, 120 MiB for a mutation at 50k) | 224880 | 122880 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a mutation at 50k peaks at about 212 MiB against DR8 120 MiB, measured twice |
| first index build at the largest scale (DR8, 6 s for 50k items and 500k events) | 10402 | 6000 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 11.1 s against DR8 6 s, and the figure is a wall time that a different runner would move on its own |
| re-index after a hand edit of the largest shard (DR8, 50 ms after a hand edit of the largest shard) | 260.2 | 50 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 257 ms against DR8 50 ms, and the figure is a wall time that a different runner would move on its own |
| index size as a multiple of the text it indexes (DR8, index at most 1.0x the text size) | 2.06 | 1 | x | OPEN MISS | 238637056 bytes of index over 115635217 bytes of records and events; open finding, not build-blocking: the landed index stores each record's and each event's source text, which the DR2 spike that measured 0.7x did not; the store owner has to decide whether the budget or the index changes |
| runtime dependencies (DR7, zero runtime dependencies) | 0 | 0 | packages | PASS |  |
| install size, unpacked (DR8, 1.5 MB unpacked) | 284611 | 1572864 | bytes | PASS | the packed tarball: the bundle, the schemas and the three licence files |
| bundle (DR8, 500 KB bundle) | 208710 | 512000 | bytes | PASS |  |
| A1 write durability, worst of the parallel rounds (axis A1) | 1 | 1 | ratio | PASS | 5: 1, 24: 1, 60: 1, 200: 1 |
| A1 writers that crashed rather than reporting a refusal (axis A1) | 0 | 0 | writers | PASS |  |
| A5 silent drops (axis A5) | 0 | 0 | cases | PASS |  |
| A5 whole-store refusals (axis A5) | 0 | 0 | cases | PASS |  |
| A5 crashes (axis A5) | 0 | 0 | cases | PASS |  |
| output size per command, bytes enforced and tokens advisory (interface A.3) | 0 | 0 | artefacts over budget | PASS | 12 artefacts measured |
