# bench

The performance budget is enforced, not asserted. `npm run bench` measures it; `npm run
bench:gate` measures it and fails on a regression.

## Running it

```text
npm run bench                       # every scale in bench.config.json, writes bench/results/
npm run bench -- --scales 100,1000  # a fast pass while iterating
npm run bench -- --rebuild-corpus   # generate privately, ignoring the shared cache
npm run bench -- --write-budgets    # re-derive bench/budgets.json from this run
npm run bench:gate                  # exit 1 on a regression past the stated tolerance
```

Parameters that decide what a figure means live in `bench.config.json`, not in a flag list:
the seed, the scales, the sample count per scale, the parallel-writer counts and the size of
the malformed-input corpus. `TREADLE_BENCH_DIR` overrides the base the rig works under.

## Two runs at once

Every axis mutates the corpus it measures: A1 writes records through parallel processes, A5
edits shard lines, A4 deletes the index. Two runs sharing one corpus root therefore do not
collide loudly. They agree on numbers taken from a store neither of them was ever in, and
`docs/BENCHMARKS.md` publishes those as measured fact.

So a run never measures a corpus another run can reach. Under the base directory:

| Path | What it is |
|---|---|
| `cache/ws-<items>-<fingerprint>` | a corpus nothing writes to after it is published |
| `run-<runId>-<pid>/ws-<items>` | this run's own copy, and the only thing it measures |

The fingerprint is a hash of the corpus spec together with the source of `bench/corpus.ts`
and `src/adapters/store/`, which is everything that decides the bytes. A corpus written by an
older generator cannot be found at the path a newer run looks up, so reuse needs no staleness
check. An entry is generated under a private staging name and moved into place with one
`rename`, so a process killed mid-generation leaves staging litter rather than a short corpus
at a path a reader trusts, and two runs racing for the same entry resolve without a lock:
whoever renames first owns it and the loser discards its own work.

Generation stays paid once. The per-run copy is `fs.cp` with `COPYFILE_FICLONE`, which is a
copy-on-write clone on APFS, btrfs and xfs and a byte copy elsewhere; `cloneMs` in
`bench/results/bench.json` reports what it actually cost, next to the `generatedMs` it
replaced. The run removes its own directory when it finishes and leaves the cache behind.

Nothing prunes the cache. Every change to the generator or to the store adapter orphans the
entries it supersedes, and a full set of four is about 354 MB, so the ceiling is that many
megabytes per generator version until the directory is removed. Deleting a superseded entry
automatically is the thing not done here on purpose: another run may be cloning it at that
moment, and a reaper racing a reader is the failure this layout exists to remove. Remove the
whole base when it is in the way, with `rm -rf /tmp/treadle-bench`, and the next run rebuilds
what it needs.

One check survives all of that, because none of the above covers a generation that completed
short. The readback every corpus already performs now compares the store's item count against
the spec and stops the run when they differ. Comparing two numbers the run has in hand is
free, and it turns the dangerous failure into the safe one.

## What it measures, and what it cannot

`docs/BENCHMARKS.md` carries the run, the twelve comparison axes and what each unfilled one
is waiting for. Three rules govern every figure in it.

- A value that could not be taken is the string `NOT MEASURED: <reason>`, in the JSON and in
  the Markdown. Never zero, never omitted, never interpolated.
- Every figure carries the machine, the corpus size, the sample count and the date, and every
  axis carries the number of store operations it performed. A count of zero is the tell.
- Percentiles are nearest-rank and print the rank they resolved to, so a p99 that is really
  the maximum of twenty samples says so.

## Shape

| Path | What it owns |
|---|---|
| `bench.config.json` | the control file: seed, scales, sample counts |
| `budgets.json` | the DR8 limits and where each came from |
| `corpus.ts` | corpora written through the landed store, deterministic from the seed |
| `timing.ts` | cold-process sampling, percentiles, floor subtraction |
| `floors.ts` | what spawning, Node, type stripping and loading the store each cost |
| `tokens.ts` | bytes and three tokenizers, reported side by side and never averaged |
| `gate.ts` | the DR8 budget gate, relative to the runner's own Node floor |
| `axes/` | one file per measurable axis, plus the methods of the two that are not |
| `axes/surface.ts` | the command-surface harness the six behaviour axes share |
| `children/` | the programs each cold sample runs |

The children are separate processes on purpose. Durability under parallel writers is a claim
about processes, and a crash on malformed input is only observable from outside the process
that crashes.

The six behaviour axes go the other way and drive `src/cli/main.ts`'s own `run` in process,
with argv, the working directory, the environment and both streams passed in: 612 spawns at
the store-loaded floor the run measures is one to two minutes of Node startup, and startup
cannot change what they measure. Each one runs a single read through the shipped
`bin/treadle.js` as a real child and compares the bytes, so that trade is checked rather than
assumed.
