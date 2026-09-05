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
| No network egress | 10 commands run with 14 network entry points replaced by traps: 0 attempts | Proven |
| Coverage meets the gate | 97.54% lines and 89.81% branches against a 90/85 gate; every one of the 7 named files over its 95/90 bar | Proven |
| A flake budget of zero | 20 of 20 consecutive full runs completed and green, 0 failures, and the same test count in all 20, which is the condition `scripts/flake.ts` fails on if it moves; 50.9 s to 84.5 s each, 1,437 s in total | Proven |
| One regression test per closed security finding | 12 closed findings, each mapped to a named test that names the finding and carries assertions, 201 assertions passing across the 12 files in one child run; 1 open finding naming the layer it waits on | Proven |
| Every character of a random id is equally likely | Chi-squared 23.3 to 46.2 over ten runs of 600,000 characters against a ceiling of 120 on 35 degrees of freedom; the `byte % 36` implementation this replaced scored 1,340.6 on the same test | Proven |
| Every property can fail | 9 deliberate breakages of the product and the harness, 9 caught by the property that claims them | Proven |
| No literal invisible code point ships | 169 tracked text files scanned, 0 carrying one; every such character in the suites is built from its number or written as an escape | Proven |
| Severity reaches every read surface | 5 of 5 surfaces print it for an S1 bug, against 0 of 5 before; `show --field sev` answers where it was a `C2` refusal | Proven |
| `next` separates an S1 from an S4 | At equal priority, 74, 56 and 50 for an S1 bug, an S4 bug and a chore, against 50, 50 and 50 before; severity's lift is bounded at 24, which is 2.4 priority levels | Proven |
| Every severity and priority change the tool makes is an event with a before and an after | A `file` event's `after` carried 2 keys and now carries every audited field set; a `mark` carries `before`, `after`, the actor and the reason | Proven |
| A change made outside the tool is a finding | A hand edit from S1 to S4 and priority 1 to 5 produced 0 findings and now produces 2, each naming the stored value and the last one the log recorded | Proven |
| Both prose bounds refuse and neither truncates | 90,000-character description refused naming 90000, 10000 and 80000 over, shard unchanged; 10,000-character reason refused at `T7` naming 500 | Proven |
| A record over the old bound still reads | A 42,000-character stored description serves on `show` and is finding `H18`, where the first build quarantined it and reported `checked 0` | Proven |
| A done item points at evidence | `DOD7` is the only failing rule on an otherwise complete bug, and its remedy is the command that fixes it; a hand edit removing the section is `H21` | Proven |

## What is not proven

**Performance and efficiency.**
No figure here is a performance measurement, and the fuzzing budget is a ceiling rather than a benchmark.
A separate branch owns that work.

**The one open threat-model finding.**
F4, CSV formula injection, waits on export, which is not built.
`test/security/findings.test.ts` asserts that it names the layer it waits on rather than silently disappearing from the list.

**What a closed-by-absence finding proves, and what it does not.**
F1, F7 and F11 closed by removing their surface rather than by guarding it, which [architecture/adr/0012-the-extension-surface-that-does-not-ship.md](architecture/adr/0012-the-extension-surface-that-does-not-ship.md) argues.
Their tests prove that nothing under `src/` starts a process, evaluates a string, reads a hook setting or writes a file outside the store's own six writers.
They do not prove that a hook contract would be safe if one were built, and they are not evidence about a release that has never fired: F13's third control, provenance at publish, is asserted over the workflow and the preflight script rather than over a publish that happened.

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

| File | What it is | Held to | Result |
|---|---|---|---|
| `src/adapters/store/grammar.ts` | parser and serializer | 95% lines, 90% branches | met |
| `src/domain/state-machine.ts` | state machine | 95% lines, 90% branches | met |
| `src/domain/text.ts` | escaper: the safe-text class | 95% lines, 90% branches | met |
| `src/adapters/render/grammar.ts` | escaper: the line grammar guards | 95% lines, 90% branches | met |
| `src/adapters/workspace.ts` | path resolution: the workspace walk | 95% lines, 90% branches | met |
| `src/adapters/target.ts` | path resolution: the store seam target | 95% lines, 90% branches | met |
| `src/adapters/store/lock.ts` | lock | 95% lines, 90% branches | met |
| all files | | 90% lines, 85% branches | 97.07 to 97.66 lines, 89.08 to 89.69 branches across three runs on this branch |

The overall figures are ranges rather than points, because they move between runs and a single decimal would be spuriously precise.
The concurrency and durability suites are real processes: how many trials leave a lock file for the next writer to reclaim, how many journalled transactions a kill leaves to be replayed, and how many compare-and-set attempts 24 writers need are all decided by the scheduler, so each run takes a slightly different set of branches through `lock.ts` and the store.
What is asserted is the gate, which every run met, not the decimal.
A count that measures a claim is kept here; a count that measures only the size of the tree is not, because it rots into a false statement on the next commit.

The gate has been seen red: before the tests in this branch, `src/adapters/workspace.ts` sat at 80.17% lines and 65.22% branches and `src/adapters/store/lock.ts` at 88.37% branches, and `npm run coverage` named all three misses with their numbers and exited non-zero.
Writing those tests is what found the crash below.

## Flake

`npm run flake` runs the whole suite 20 times in a row and reports the count that completed alongside the count that passed.
It also fails if the test count moves between runs, because a suite that decides at runtime how much to check would pass while checking nothing.

Measured on this branch: 20 of 20 runs completed, 20 green, 0 failed, 757 tests in every run, 1,147 s in total.
Individual runs ranged from 49.8 s to 88.6 s, which is a 1.78x spread on a shared machine and is the reason the fuzzer's time bound is generous rather than tight.
The figure before this branch was 626 s over 20 runs of a smaller suite on an idle machine, ranging 27.1 s to 34.4 s; what both runs assert is the budget of zero failures and a test count that does not move, never the seconds.

One flake was found and fixed during this work, in a test written during it: the fuzzer's per-input time budget of 250 ms was measuring the machine rather than the code, and a 12-byte input crossed it on a loaded run.
Catastrophic backtracking is an orders-of-magnitude event, so the budget is now 2 s and the real claim is carried by the star-height scan, which is deterministic.

A tight timing bound in a test is a machine measurement wearing a correctness costume.

## The three defects this branch closed, red then green

Each was found by driving the built command surface, and each was reproduced against the tree before the fix.
The transcripts are the two scripts under the task's scratch directory; the numbers below are what they printed.

**Severity reached nobody.**
`show`, `explain`, `backlog`, `status` and `next` printed it 0 times for an S1 production bug, `show --field severity` exited 2 with `C2` naming the six fields the record did carry, and `backlog --fields id,sev,title` exited 2 because there was no such column.
`next` scored an S1 bug, an S4 bug and a chore at priority 1 as 50, 50 and 50.
After: all five surfaces carry it, and the same three score 74, 56 and 50 with `v4`, `v1` and `v0` in the printed components.

**A lowered severity had no author.**
`grep -c severity` over the event log returned 0, and a `file` event's `after` was `{"state":"draft","type":"bug"}`.
A hand edit taking S1 to S4 and priority 1 to 5 left `findings 0` and the same 7 event lines.
After: the `file` event carries `{"type":"bug","state":"draft","filed_at":...,"priority":"1","severity":"S1","found_in":"production"}`, a `mark` carries `before`, `after`, the actor and the reason, and the same hand edit is two `H20` findings on `doctor` and on `explain`.

**Both prose doors were open.**
A 90,000-character description was accepted and left a 90,675-byte shard; a 10,000-character reason produced a 10,287-byte event line.
After: both are refused, each naming the field, the observed length, the limit and the difference, and the shard is byte-identical to what it was before the refused write.

**And the evidence rule that ships with them.**
A bug with a reviewer, a confirmed fix and no evidence is refused at `done` with `DOD7` as the only failing rule, and `explain` prints `treadle evidence add retry-key <kind> <ref> [label]` as the remedy.
Two pointers cost 2 rows on `show` and one `## Evidence` section in the shard.
A ref carrying a space is refused, an invented kind is refused naming the seven, a duplicate is refused, and the twenty-first entry is refused naming the count and the limit.

The bound that could not go where it was written is recorded too, because the first build got it wrong.
Applying the narrowed `description` bound on the load path made a 42,000-character record unservable: `show` exited 4 and `doctor` reported `checked 0`.
Reading always works, so the bound is a write-time rule and the store's S5 ceiling is the load bound.

A bound that stops an old file from being read is not a bound, it is a data loss.

## The defect this work found

Writing the coverage gate exposed two reachable filesystem-failure paths on the same class.
`treadle init` where `.work` is already a file, and `treadle file` into a shard directory with its write bit off.
At the base this branch rebases onto, PR #4's command-boundary backstop already turns both into a structured envelope with no stack trace.

```text
err INTERNAL -
"cause init did not complete: Error: ENOTDIR: not a directory, mkdir '.../.work/items'
fix treadle version
```

Both were reported as `INTERNAL` with exit 1 and no rule id.
A filesystem that refuses a write is the store being unavailable, which [STABILITY.md](STABILITY.md) maps to exit 6.
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
