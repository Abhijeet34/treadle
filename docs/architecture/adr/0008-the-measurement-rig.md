# ADR-0008: One measurement rig, cold processes, and a gate that reads the median

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** DR8 of the system design record

## Context

The acceptance bar for this product is not that it works.
It is that it beats the reference by a margin somebody measured, on the twelve axes the prior-art report names, and that every non-functional claim in the repository is a number rather than an adjective.
DR8 turns that into a list of budgets and says CI enforces them.

Nothing in the tree measured anything before this record.
DR1, DR2 and DR4's figures were taken on throwaway spikes in a scratch directory that no longer exists, against corpora nobody can regenerate, so the landed store had never been compared with the design that specified it.

The rig has to survive two more constraints.
The command layer landed in #3 partway through, so the rig had to be built against a surface that did not exist and then take it up when it arrived; axis A3 is the one that moved.
And the machine is shared with sibling workers and is never idle, so a figure taken here carries load that no amount of retrying removes.

## Decision

`npm run bench` measures, `npm run bench:gate` measures and fails.
`bench/bench.config.json` is the control file: seed, scales, sample counts, writer counts, the size of the malformed-input corpus.

### Corpora are written through the store

`bench/corpus.ts` builds workspaces of 100, 1,000, 10,000 and 50,000 items by calling `ShardedStore.apply`, one transaction per month shard, with ten events per item.
A generator that wrote the Markdown itself would measure a format rather than a product and would drift from the grammar on its first change.

Determinism comes from one seed through mulberry32, imported from the store fixtures rather than copied, plus zero-padded ids.
Item counts are read back from the store after generation and it is the read-back count that every table prints.

### Every sample is a cold process

`bench/timing.ts` launches one process per sample, times it with the parent's monotonic clock and reports the first launch apart from the distribution, which is DR1's method.
An in-process loop would measure a warm V8 and a warm index handle, and the figure an agent pays is neither.

`bench/floors.ts` measures five nested floors: `/usr/bin/true`, `node -e`, one JavaScript file, one TypeScript file and the store adapter loaded with no work done.
Each is a strict superset of the one above it, so a difference prices exactly one thing.
The spawn floor is subtracted to give the program's own cost; the `node -e` floor is what the gate compares against.

Percentiles are nearest-rank and print the rank they resolved to, so a p99 that is really the maximum of twenty samples says so.

### The load is recorded rather than waited out

This machine is shared. Sampled during this work the 1-minute load average was 23 to 42 on 8 cores, with a dozen other `node` processes and about 70% of memory in use, and it peaked at 99.03 while 289 parallel writers ran.

Waiting for quiet was tried across several runs and abandoned: it is not a method, and the load did not clear.
So `bench/load.ts` samples the run-queue averages, free memory and the machine's `node` process count either side of every measurement and every axis, and the report prints them beside the figure.
A reader who sees a number above its series can check what the machine was doing for it.

`pgrep` rather than `ps`, which the sandbox refuses, and its lines are counted rather than asking for `-c`, which is a Linux flag macOS pgrep does not carry.

### The floors are measured after the corpora

The floor is subtracted from every operation to leave the program's own cost, which only holds if both are measured in the same conditions.
Generating the four corpora writes about 430 MB.
Floors taken on an idle machine before that write, against operations timed while it was still draining, put the whole of the writeback into program cost: that ordering opened six small-scale timing rows by up to 58% while the 50k rows, which run once the flush has drained, sat on their series.

### The gate reads the median, and the tolerance was measured

Every timing budget is program cost: the operation's wall median minus the runner's own `node -e` median, taken in the same job.
That subtraction removes what a machine charges to start a process and leaves what our code charges to do the work.

The median rather than the p95, because the p95 was measured and cannot carry a gate.
Two identical four-scale runs on this machine on 2026-09-05 moved the median of twenty operations by at most 2.4% and moved one p95 by 68.9%.
A gate on the p95 fires on the scheduler.
The tolerance is 35%, which clears the worst drift observed across the quiet runs, 19.9% on `list` at 1,000 items, by 1.76x.
It is not enough at a load of 99, and that is the gate reporting the machine rather than the code, which is why the timing rows are not armed.

### A number nobody measured is not a number

Three rules, each enforced by the code rather than by a convention.

- A value that could not be taken is the string `NOT MEASURED: <reason>` in the JSON and in the Markdown. `bench/axes/axis.ts` has no path that produces a zero for a missing measurement.
- Every axis carries the count of store operations it performed. A benchmark that ran nothing has the same shape as one that ran a thousand things, and only the count separates them.
- A budget with nothing to compare against is `pending`, and one the product has never met is an `open miss` reported with its number. Neither is `pass`, and the summary prints all four counts.

### What has teeth, and what does not

The gate blocks a build on what transfers between machines: durability under parallel writers, whole-store refusals and crashes on malformed input, the runtime dependency count, the install size.

It does not block on the per-operation timing limits.
They were derived on an Apple M2 under macOS and have never been measured on a GitHub runner, so a red build there would be evidence about the runner.
`bench/budgets.json` carries `timing.enforced: false` with that sentence, the rows still print with their numbers, and arming them means re-deriving on the runner with `--write-budgets`.

A pull request measures 100 and 1,000 items; the weekly run measures all four scales, because 10k and 50k cost minutes of corpus generation and should not be paid per push.

### Two development dependencies, one record each

DR7 requires a record per dependency. Neither reaches the shipped package: `files` in `package.json` lists `dist/`, `schemas/`, `LICENSE`, `NOTICE` and `README.md`, and `bench/` is in none of them.

| Package | Version | What it saves | Why it is not a few lines |
|---|---|---|---|
| `@anthropic-ai/tokenizer` | 0.0.4 | the `claude` column of the token budget | a BPE vocabulary and its merge table |
| `gpt-tokenizer` | 4.0.0 | the `o200k` and `cl100k` columns | two more of the same, offline and deterministic |

Three columns rather than one, reported side by side and never averaged, because they disagree and the disagreement is the information.
The Claude column encodes a legacy vocabulary, since Anthropic publishes no tokenizer for the current models, so it is a real measurement of a real tokenizer and not a measurement of any current model.
It is never used alone for a decision.

## Alternatives considered

### Bundling the benchmark children with esbuild

DR1's budget was taken on a 406 KB bundle and DR7 already records esbuild for that purpose, so bundling would make these figures comparable with it.
Rejected for now because there is no entry point to bundle: `src/cli` is empty.
The gap is measured instead, as the difference between the JavaScript and TypeScript floors, and it is 32.7 to 33.8 ms at the median.

### Absolute millisecond budgets, as DR8 wrote them

DR8 states `show <id>` at 65 ms p95 and similar.
Those are Apple M2 numbers and a GitHub runner is not one, so an absolute limit would fail on a slow runner and hide a regression on a fast one.
Program cost against the runner's own floor is the same idea DR8 applies to cold start, extended to every row.

### Measuring against the reference implementation

Out of scope by the brief and impossible in this worktree: the reference is not present, and its evidence file is quarantined.
Every reference figure in the axes table is quoted from the prior-art report and none is re-derived.

## Consequences

**Positive**

- The landed store now has measured numbers against the design that specified it, and five DR8 budgets are recorded as missed rather than assumed met.
- Axis A3 is measured in-repo, tokens included. `test/cli/budget.test.ts` gates the bytes and records that its token figures were taken outside the tree, because a tokenizer is a package and the product ships none; this rig carries all three as development dependencies.
- Two defects surfaced that no test reaches: a record heading renamed out of the grammar is dropped from every query with no finding, and a few of 200 parallel writers die with an uncaught `database is locked`.
- A run is reproducible from its seed, and across ten runs `transition` at 50k spread 4.4% and `get` 6.9% at the median, loaded runs included.

**Negative**

- A full four-scale run costs about five and a half minutes and about 430 MB of corpora under `TREADLE_BENCH_DIR`. A pull request pays the two small scales.
- The timing limits are calibrated to one machine and are not yet armed anywhere else.
- Axis A1's 200-writer round alone takes about 70 seconds, because 200 cold Node processes serialise through one store lock.
- The figures are bounded by confounds this rig cannot remove: a shared machine, a runtime below the product's floor, and no bundle. `docs/BENCHMARKS.md` lists all seven.

## Departures from the design record

- **The gate reads the median, not the p95.** DR8 says "runs each command 20 times as a cold process, and fails on any p95 over budget". The p95 moved 68.9% between two identical runs here, so that gate would be a coin toss. The p95 is still measured and printed.
- **Timing limits are relative on every row, not only on cold start.** DR8 makes cold start relative to the runner and leaves the per-command rows absolute. A runner cannot carry an absolute row either.
- **A budget the product has never met is an open miss rather than a failure.** DR8 has one status. Six budgets are missed today by code that landed before this rig existed, and failing every build for them would train people to ignore the job. They print with their numbers and the report leads with them.
- **The timed rows are store operations, not commands.** DR8's rows name `show`, `list`, `create` and `transition`. The timed children call `get`, `list` and `apply` at the store seam and say so in every table; the command surface that landed in #3 is not yet what they invoke. Axis A3 is the exception and does render real command artefacts.
- **Every figure carries the machine's load.** DR8 assumes a benchmark runner it controls. This one runs on a shared machine, so the load is part of the record.
- **The corpora carry 24 month shards at every scale, matching DR2's, but not DR2's byte-for-byte records.** Our largest shard at 50k holds 2,176 records in 1.09 MB against the design's 2,084 in 1.69 MB, so a direct millisecond comparison with DR2 carries that difference.

## What would reopen this

- The command layer landing, which turns eight `NOT MEASURED` axes into rows and moves these children behind real verbs.
- A build step, which would make the figures comparable with DR1's bundle and would give the bundle-size budget something to weigh.
- A CI runner baseline, which is what arms `timing.enforced`.
- A dedicated machine, which would make the load columns uninteresting and the tolerance tighter.
