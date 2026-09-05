# Verification

What this project claims about itself, what was measured, and what is not proven.

Every figure here comes from a run of the suite in this repository, on Node 24.11.1.
That is below the declared floor of 24.15 in `package.json`, so `npm install` warns and `node:sqlite` prints one experimental notice per process.
Both are expected here and neither changes a number below.

Counts are per run, and every property suite prints its own count as a test diagnostic, so a run that generated less than it claims says so rather than reporting a silent pass.

## The claims

| Claim | Measured | Verdict |
|---|---|---|
| Round trip is byte-exact over generated adversarial documents | 2,000 documents, 1,987 records served and 1,740 quarantined, 0 bytes moved; 2,000 records are fixed points; 1,000 work items either refuse at encode or return unchanged, 579 returned unchanged | Proven |
| A mutation applied twice is a no-op that writes nothing | 95 repeated transitions, every one reported `already` with no transaction; 9 of them checked by hashing the authoritative store either side, 0 bytes changed; 5 repeated creates refused with 0 bytes changed | Proven |
| Any sequence of legal commands leaves a store that still holds | 40 sequences of 25 commands, 1,000 invocations: 498 mutations, 293 reads, 209 refusals; 0 shards left unparseable, 0 quarantined records, 0 answers that changed when the derived index was deleted and rebuilt | Proven |
| The parser and the escaper survive fuzzing | 500,000 mutated inputs per run and 2,000,000 in the recorded soak, 0 crashes; slowest single input 227.9 ms against a 2,000 ms budget | Proven |
| No regex that reads foreign input can backtrack | 23 regex literals across the 4 files that read foreign input, every one of star height 1 or 0, by a scanner with its own self-test | Proven |
| N parallel processes leave zero corruption and zero lost updates | 24 separate processes over one record: 24 of 24 writes persisted, version 25, 24 events, 0 corrupt shards, 0 quarantined, 0 locks left behind | Proven |
| A process killed mid-write leaves the store intact | 30 SIGKILL trials: 30 stores parseable, 0 corrupt, 0 quarantined, every lock left behind reclaimed by the next writer, every journal replayed | Proven |
| A stale lock is recovered | Both forms: a holder whose process is provably gone, reclaimed in under 1 s; a live process whose heartbeat stopped, reclaimed. `EPERM` is treated as alive and the lock is not stolen | Proven |
| A hand edit during an operation is handled | 12 trials: 6 broken records quarantined and reported as findings with the record either side still serving, 6 concurrent edits leaving a shard that still parses, 0 stores left unreadable | Proven |
| Zero injection escapes across an adversarial corpus | 4,840 rendered cases over 11 result shapes: 1,239 decoded back to exactly the values that went in, 1,181 refused by the grammar naming the key, 0 escapes | Proven |
| The seams take a second implementation | Store: 12 conformance tests against 2 real implementations. Renderer: 16 golden objects through 4 renderers, 64 renderings, the fourth written against 2 types and no code | Proven |
| No network egress | 10 commands run with 14 network entry points replaced by traps: 0 attempts. 51 source files scanned against 11 network module specifiers: 0 imports | Proven |
| Coverage meets the gate | 97.11% lines and 88.95% branches overall against a 90/85 gate; all 7 named files at 96.33% lines or better and 96.26% branches or better | Proven |
| A flake budget of zero | Measurement in progress; see [Flake](#flake) | Not yet measured |
| One regression test per closed security finding | 8 closed findings, each mapped to a named test that names the finding and carries assertions; 5 open findings each naming the layer they wait on | Proven |
| Every property can fail | 9 deliberate breakages of the product and the harness, 9 caught by the property that claims them | Proven |

## What is not proven

**Performance and efficiency.**
No figure here is a performance measurement, and the fuzzing budget is a ceiling rather than a benchmark.
A separate branch owns that work.

**The five open threat-model findings.**
F1 and F7 wait on the hook contract, F4 on export, F11 on the agent adapter, F13 on the release path.
None of those layers exists, so none of the five has a regression test, and `test/security/findings.test.ts` asserts that each names the layer it waits on rather than silently disappearing from the list.

**Coverage-guided fuzzing.**
The fuzzer here is mutation-based over a committed corpus.
A parser with deep state would deserve a coverage-guided one; this one is a single linear pass with no backtracking, which is asserted rather than assumed by the star-height scan.
[ADR-0007](architecture/adr/0007-proving-the-properties.md) records why no fuzzing dependency was added.

**Correctness of the domain rules themselves.**
Every property above is about the machinery: the parser round-trips, the renderer cannot be made to forge a line, the store does not lose a write.
Whether the definition-of-ready gate asks for the right things is a product question these tests do not touch.

## Coverage

`npm run coverage` runs the suite under Node's own coverage and holds the result to a table in `scripts/coverage.ts`.
The overall gate is 90% lines and 85% branches; the named files are held to 95% and 90%, because those are exactly the files a project-wide average hides.

| File | What it is | Line % | Branch % |
|---|---|---|---|
| `src/adapters/store/grammar.ts` | parser and serializer | 96.33 | 96.26 |
| `src/domain/state-machine.ts` | state machine | 100.00 | 100.00 |
| `src/domain/text.ts` | escaper: the safe-text class | 100.00 | 100.00 |
| `src/adapters/render/grammar.ts` | escaper: the line grammar guards | 100.00 | 100.00 |
| `src/adapters/workspace.ts` | path resolution: the workspace walk | 100.00 | 100.00 |
| `src/adapters/target.ts` | path resolution: the store seam target | 100.00 | 100.00 |
| `src/adapters/store/lock.ts` | lock | 100.00 | 98.00 |
| all files | | 97.11 | 88.95 |

The gate has been seen red: before the tests in this branch, `src/adapters/workspace.ts` sat at 80.17% lines and 65.22% branches and `src/adapters/store/lock.ts` at 88.37% branches, and `npm run coverage` named all three misses with their numbers and exited non-zero.
Writing those tests is what found the crash below.

## Flake

`npm run flake` runs the whole suite 20 times in a row and reports the count that completed alongside the count that passed.
It also fails if the test count moves between runs, because a suite that decides at runtime how much to check would pass while checking nothing.

The 20-run measurement for this tree has not completed at the time of writing, so the table above says so rather than guessing.

One flake was found and fixed during this work, in a test written during it: the fuzzer's per-input time budget of 250 ms was measuring the machine rather than the code, and a 12-byte input crossed it on a loaded run.
Catastrophic backtracking is an orders-of-magnitude event, so the budget is now 2 s and the real claim is carried by the star-height scan, which is deterministic.

A tight timing bound in a test is a machine measurement wearing a correctness costume.

## The defect this work found

Writing the coverage gate exposed two reachable crashes on the same class.
`treadle init` where `.work` is already a file, and `treadle file` into a shard directory with its write bit off, each printed a raw Node stack trace to stderr and exited 1.

```text
Error: ENOTDIR: not a directory, mkdir '.../.work/items'
    at async mkdir (node:internal/fs/promises:861:10)
    at async createWorkspace (.../src/adapters/store/sharded-store.ts:106:3)
```

That is not the envelope a caller parses, not an exit from the table in [STABILITY.md](STABILITY.md), and a stack trace on stderr carries absolute paths and internal frames, which is finding F10's class, record content reaching a log, arriving on a path nobody had walked.
`createWorkspace` declared a result type it never used, and `apply` let an errno escape the same way.
Both now return `STORE_UNAVAILABLE` with the rule id `S13`, and `run` carries a backstop for anything that still escapes.

```text
err STORE_UNAVAILABLE -
rule S13
"cause the workspace at .../.work could not be created: mkdir failed with ENOTDIR
```

`test/cli/robustness.test.ts` fails 3 of 3 against the old sources and passes against the new ones.

A return type that says it reports failures has to report them.

## Running it

```bash
npm run check      # tsc --noEmit under strict, then the whole suite
npm run coverage   # the suite under coverage, held to the per-file gate
npm run flake      # 20 consecutive full runs, budget zero
npm run flake -- 5 # a shorter local check
```

`TREADLE_FUZZ_INPUTS=<n> npm test` raises the fuzzer above its gate count for a soak run.
