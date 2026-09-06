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
| A paused lock holder never overwrites the writer that reclaimed it | A writer stopped with `SIGSTOP` inside its critical section, a competitor reclaiming after the 5 s window: before, 1 lost update in 117 writes with `doctor` clean; after, 5 runs of 5 with version equal to update events plus one, the paused writer refusing `LOCK_LOST`/`S16` or `CONFLICT`/`S10` (`test/store/lock.test.ts`) | Proven |
| No symbolic link at or below the workspace root is followed | 7 paths each replaced by a link to a directory outside the workspace, `items` among them: before, `file` wrote its shard through the link; after, every read and write refuses `S15` naming the link and its target, 0 bytes written outside (`test/store/symlink.test.ts`) | Proven |
| The event log holds the same property the record files hold | A repeated event id across two month files replaced the real creation event in `history` and `explain` with `doctor` clean; now `S14` at the line, every read refusing at 7. An instant naming month 13 sorted after every real event; now refused. A blank line moved the reported line of an appended bad line by one; now the line the file has (`test/store/event-log-integrity.test.ts`, `test/services/event-audit.test.ts`) | Proven |
| A duplicate-id finding goes with the file it clashed against | A shard copied to a second month and then removed left `S3` refusing every read until the surviving shard changed or the index was deleted; the index now records which file a clash was decided against and re-reads the survivor when that file changes or goes, for `S3` and `S14` alike (`test/store/event-log-integrity.test.ts`) | Proven |
| The store never writes a record it would not serve back | `set acceptance_criteria="a\nb"` landed and every read after it exited 7; now refused at 2 as `V4`, and the store parses every record it renders before the write (`test/cli/found-by-use.test.ts`) | Proven |
| The lock reclaim race resolves without an overlapping hold | 24 waiters over 600 contended reclaims, 0 overlapping holds | Proven |
| A symlinked or a foreign-pid lock does not wedge the store | both forms reclaimed within the 5 s window | Proven |
| No field injects into the index's SQL | every query is parameterised, and `backlog` answers byte-identical across a rebuild | Proven |
| A poisoned index does not survive a rebuild | hand-written rows in the index did not survive the next rebuild | Proven |
| The store holds under its declared ceilings | 1.1 million events at 239 MB: the index rebuilds in 123 s and still serves | Proven |
| A pull request cannot silently remove a test that main has | The reconstructed pull request 29 resolution reports 1122 of 1122 tests passing and is refused by `check-tests-kept` naming 32 titles; over all 29 pull requests in main's history, 25 pass and 4 need 9 declarations between them, every one a title whose behaviour changed (`test/architecture/tests-kept.test.ts`) | Proven |

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

Measured on the branch that added this section: 20 of 20 runs completed, 20 green, 0 failed, a test count that did not move across the 20, and 1,147 s in total.
The count itself is deliberately not repeated here, because the paragraph above says a number that measures the size of the tree rots into a false statement on the next commit, and this one did: it read 757 for six pull requests after the suite had grown past it, where `node --test "test/**/*.test.ts"` reported 1,146 on 2026-09-06.
That command is the number's only authority, and it is one line to run.
What the gate asserts is zero failures and a count that does not move within a run set, which is the part a later commit cannot make false.
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

## The fourth field of one class, and the gate that ends it

Question 15 of the benchmark's question-coverage axis, "who changed X", scored `none`, with this verdict:

> every event carries an actor and no read surface prints one; the answer is in the store and not behind a command

That is the third instance of one defect: a field captured faithfully on every write and shown by no command.
`severity` was required at creation and printed nowhere, a severity change was recorded in no event, and the actor is on every event line and reached no command.
So this branch answered the question and then swept the whole dictionary for the same shape.

**The sweep, measured.**
The store persists 35 work-item fields and 14 event keys.
Counted against the shapes at the branch base, 18 of the 35 and 11 of the 14 reached no read surface at all: `actual`, `component`, `expected`, `extra`, `findings`, `fix_confirmed`, `found_in`, `held_from`, `hold_reason`, `hold_until`, `hours_estimate`, `labels`, `outcome`, `question`, `reporter`, `repro_steps`, `reviewer` and `timebox_hours` on the record, and `actor`, `actor_kind`, `entity_kind`, `entity`, `op`, `before`, `after`, `guards`, `outcome`, `cmd` and `txn` in the log.
Of those 29, 24 are readable now and 5 are declared hidden with a reason.

**Question 15's answer, as it prints.**
`history <id>` is the reader [ADR-0011](architecture/adr/0011-evidence-and-the-severity-audit.md) named when it widened the `file` event to carry the fields an item was created with.

```text
$ treadle history pay-hook
ok history demo
item pay-hook
sort at desc
~events 4 4
#at kind op what "by
2026-09-05T12:10:07Z human item.transition state kim
2026-09-05T12:10:07Z human item.transition state ravi
2026-09-05T12:10:07Z agent item.mark severity agent-7
2026-09-05T12:10:06Z human item.file type,state,filed_at,priority,points,severity,found_in dana
```

`explain` gains one line for the same fact about the write that put the item where it is, because that is where the axis looked and it already reads that event for `since` and `from_event`:

```text
$ treadle explain pay-hook
...
sev S1
"by kim
```

The decision per field is in `test/architecture/field-visibility.test.ts` rather than here, because a table in a document drifts and that one is executed.
Every persisted field has a line naming the result key that carries it or the reason it stays hidden, and a field with neither fails by name.

**Red before green.**
Three trees, each the branch tip with one part of the fix removed.
Back out `show`'s field additions and the gate says `item hours_estimate claims show:hrs, and the show shape declares no hrs`.
Keep the shape and remove only the assignments and it says `hours_estimate claims show:hrs and no record printed hrs`, so declaring a surface that never prints the field is not a way through.
Remove the `by` column and the gate states question 15 as a failing assertion: `event actor claims history:by, and the history shape declares no by`.
The three CLI cases in `test/cli/found-by-use.test.ts` fail at the branch base too: `history` exits 2 as an unknown command, `explain` prints no `by`, and a 201-character actor is accepted.

**What it costs, in bytes.**
The A.3 budgets are unchanged and every budgeted artefact is inside its own.
The golden `show` is a story carrying none of the new fields and is 273 B against 310 as before; `explain` moves 429 B to 438 B against 754.
`history` is a new command and A.3 carries no figure for it: the golden is 280 B, gated here at 380 B, which is the 75 percent fill A.3 gave `backlog` (717 of 960) and `next` (380 of 510).

The finding A.3 does not cover is that one budget for `show` is measured on one record type.
The same workspace, read with the branch base and then with the tip: a bug goes 263 B to 604 B, a spike 121 B to 336 B, an epic 119 B to 172 B, an item on hold 129 B to 218 B, and a cancelled chore stays at 142 B.
A bug is the expensive record because a bug has six more stored fields than a task, three of them prose, and the reason its `show` looked cheap was that those fields were not printed.
That is a budget for the budget owner to state per type, not a set of required fields to hide so a story's figure holds.

A field a caller can set and cannot read back is a field the tool cannot answer for.

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

## The gate that demanded a field nothing could set

Two defects on the field surface, both found by driving the built bundle and both invisible to every suite.

**A gate can demand a field no command can set.**
A bug filed without `expected` and `actual` was refused at the ready gate with `GUARD_REFUSED rule G1, the ready gate fails: DOR6, DOR7`, and `explain` printed the remedy `set expected on checkout-drops-paid-orders`.
No such command existed: the mutating surface was `init`, `file`, `transition`, `mark` and `evidence`, and none of them writes a stored field after creation.
`explain` on the done gate printed `record a reviewer` and `set fix_confirmed to true`, so the same dead end sat on both gates, and `doctor` reported the workspace clean with the stuck item in it.
The item was unadvanceable for good, because filing before you know the details is the normal order.

**The write path and the read path disagreed about a field's name.**
`file task "x" --set description=` was accepted and `--set desc=` refused with `V5, desc is not a field of any work item`, while `show <id> --field desc` printed the block and `--field description` was refused with `C2, carries no field named description`.
Each path's refusal asserted the other path's name did not exist.

**What holds them closed.**
`test/domain/gate-remedies.test.ts` sweeps every remedy the shipped gates and two probe gates can emit and asserts each names a command the inventory carries.
It fails 29 of 34 against the tree before the fix, with `ready DOR6`, `ready DOR7`, `done DOD3` and `done DOD6` among the named failures.
Every check kind in the evaluator carries a line saying which command performs its remedy, or a reason it has none; `no_open_impediment` is the one such line, because the impediment entity is not in this build and `openImpediments` is a hard-coded 0.
`writerOf` in the field dictionary is now the single statement of which command writes which field, read by the field editor and by the gate remedies, so a rule cannot tell a caller to `set severity` when `mark` is what writes it.
`canonicalField` is the single statement of a field's two spellings, and `test/architecture/field-visibility.test.ts` holds it to the same table that says which surface prints each field.
Two end-to-end cases in `test/cli/found-by-use.test.ts` drive the whole path: a bug reaches `ready` by running the remedy `explain` printed, verbatim, and both spellings of `description` work on both paths.

**What it costs, in bytes.**
`explain` moves 429 B to 471 B against an allowance that moves 754 to 762, because a remedy that names a command is longer than a sentence and the budget grows four bytes per occurrence of the binary name.
Every other budgeted artefact is byte-identical.

A remedy is a promise, and a remedy naming no command is a promise nothing keeps.

## The revert a green suite could not see

Pull request 28 landed the acceptance-criteria readback and the `what` column convention.
Pull request 29 was rebased onto it, four service files conflicted, and the resolution took the pre-rebase file whole, deleting 28's code and 28's tests together.
The suite passed on 1132 tests and all ten checks were green.

The reconstruction is a branch off `3bce1ca` with those four service files and their tests back at their pre-28 state.

```text
$ npm test
ℹ tests 1122
ℹ pass 1122
ℹ fail 0

$ treadle set cart acceptance_criteria=...
set acceptance_criteria - -> [object Object]        # main: [ ] a shopper reopens a saved cart
$ treadle show cart --field ac
ac 0/1                                              # main: ac 0/1, then ~criteria 1 1 and the text

$ node scripts/check-tests-kept.ts 3bce1ca HEAD
FAIL  the what column of history has one convention
      test/services/history-convention.test.ts declares it at 3bce1ca and this branch does not
      restore the test, or record the removal in a commit message trailer:
        Removes-test: the what column of history has one convention
check-tests-kept: 772 tests at 3bce1ca4, ... 32 removed without a Removes-test trailer
```

772 of this repository's 773 test declarations are read and compared.
The one that is not is `it(file, ...)` in `test/architecture/license-header.test.ts`, whose title is a variable; the `describe` around it is compared, so deleting the loop is still caught.

### What check-tests-kept does not see

**A test that keeps its title and loses its body.**
The mechanism compares names, so a resolution that empties an assertion while leaving `it('...', () => {})` standing is invisible to it.
That is the case a manifest of behaviours checked against the built binary would answer, and [architecture/adr/0013-a-branch-may-not-remove-a-test-main-has.md](architecture/adr/0013-a-branch-may-not-remove-a-test-main-has.md) prices it.

**A subtest declared as `t.test(...)` rather than at the start of a line.**
There are none here, and a file that adds one fails the check with the file named rather than passing over it, because the gate counts the declaration-shaped calls it did not read.

**A test whose title is a variable.**
One in 773, named above.

**A branch that is not up to date with main.**
The comparison is against the merge base, so a test main gained after the fork is not one this branch removed.
`strict_required_status_checks_policy` is what makes that safe: a branch behind main cannot merge, so the run a merge is gated on compares against main's tip.

## Running it

```bash
npm run check      # tsc --noEmit under strict, then the whole suite
npm run coverage   # the suite under coverage, held to the per-file gate
npm run flake      # 20 consecutive full runs, budget zero
npm run flake -- 5 # a shorter local check
npm run tests-kept # no test main has disappears from this branch undeclared
```

`TREADLE_FUZZ_INPUTS=<n> npm test` raises the fuzzer above its gate count for a soak run.
