# bench

The performance budget is enforced, not asserted. `npm run bench` measures it; `npm run
bench:gate` measures it and fails on a regression.

## Running it

```text
npm run bench                       # every scale in bench.config.json, writes bench/results/
npm run bench -- --scales 100,1000  # a fast pass while iterating
npm run bench -- --reuse-corpus     # skip generation; only valid if no earlier run mutated it
npm run bench -- --write-budgets    # re-derive bench/budgets.json from this run
npm run bench:gate                  # exit 1 on a regression past the stated tolerance
```

Parameters that decide what a figure means live in `bench.config.json`, not in a flag list:
the seed, the scales, the sample count per scale, the parallel-writer counts and the size of
the malformed-input corpus. `TREADLE_BENCH_DIR` overrides where corpora are written.

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
