# Benchmarks

The acceptance bar for treadle is a measured margin over the reference on twelve axes, not an adjective.
Ten of the twelve are measured here.
Two are not, and each says so in its own row with the reason rather than as a gap, because a gap in a table reads as a pass to whoever skims it.

Six of the ten were filled in this run: A2, A6, A7, A8, A10 and A12.
All six needed a harness that drives the command surface rather than one artefact rendered from it, and that harness is `bench/axes/surface.ts`.
Four of the six meet their target, two miss it, and the two misses are reported with the mechanism behind each.

Reproduce it with `npm run bench`.
The appendix at the end of this file is `bench/results/bench.md` from run `2026-09-05T12-08-34-931Z`, with its heading levels demoted one step and nothing else changed.
[ADR-0008](architecture/adr/0008-the-measurement-rig.md) holds the method and what it departs from in DR8.

**One set of figures below is older than the appendix and is marked where it appears.**
The ten-run series in "Targets missed" was taken on 2026-09-04, before [#4](https://github.com/Abhijeet34/treadle/pull/4) and [#7](https://github.com/Abhijeet34/treadle/pull/7) landed, and none of it was re-taken.
It is kept because it is the only evidence this repository has of how far a figure on this machine drifts between runs, and a single run cannot replace it.
Everything else on this page was measured in the appended run.
"Targets missed" also carries what happened to the seven timing, memory and size misses it originally reported: two closed by optimisation, two budgets corrected against a new measurement, and three still open with a smaller number and a named mechanism.
`bench/budgets.json` carries the two corrected limits, each beside the measurement it is derived from.

## Read this before you read a number

This machine is shared with other work and was not idle for this run.
At the start of the appended run the 1-minute load average was 6.14 on 8 cores, with 64.6% of memory in use; across its twenty timed operations the 1-minute load ranged from 4.47 to 5.41, and it peaked at 61.30 while 289 parallel writers were running.
Waiting for quiet was tried and abandoned on earlier runs: it is not a method, and the load did not clear.

So the confound is recorded rather than dodged.
Every row in the appendix carries the load either side of it.
The appended run sits above the ten-run series on every timed operation, and eight of its timing rows are open misses against limits derived on a quieter day; the load column and the floor table are where that is visible, and the floors moved with it rather than against it.

The six axes filled in this run are counts rather than timings.
A refusal either names a rule id or does not, and a record either landed in the intended store or did not, so the load column bounds how long those axes took and not what they measured.

## The machine

| Fact | Value |
|---|---|
| Machine | Apple M2, 8 cores, 16 GB, `darwin 25.6.0`, `arm64` |
| Node | 24.11.1, below the 24.15.0 floor `package.json` declares |
| SQLite in Node | 3.50.4 |
| Seed | `20260905` |
| Appended run | 454 s of wall time, four corpora, 550 timed cold processes, 289 parallel writers, 206 damaged stores, 12 rendered command artefacts, 612 commands driven at the surface |

Node 24.11.1 is under the product's own floor, so every figure was taken on a runtime the shipped package refuses to run on.
The store is the only layer with a measurable cost here, it runs unchanged on both, and a figure without its runtime named is not a figure.

## The harness floor

Five nested floors, each a strict superset of the one above, so a difference prices exactly one thing.

| Floor | Best of 50 | Median |
|---|---|---|
| `/usr/bin/true` | 2.2 ms | 2.7 ms |
| `node -e` | 38.4 ms | 44.1 ms |
| `node` plus one JavaScript file | 47.7 ms | 55.4 ms |
| `node` plus one TypeScript file | 84.1 ms | 106.1 ms |
| `node` plus the store adapter loaded, no work | 141.4 ms | 188.0 ms |

Subtract 2.2 ms of spawn from any wall figure to get the program's own cost.
Type stripping costs 36.4 ms and loading the store costs 57.3 ms on top of it, so 94 ms of every cold invocation is module loading that a bundle would mostly remove.
Both are above their own series: type stripping ran 32.6 to 33.3 ms in the runs either side of this one, which is the machine and not the code, and is why the fixed costs are taken from the best of fifty rather than the median.
The tree now builds one, weighed in the package table of the appendix, and `npm run build` prints that count against DR8's 512,000 limit and fails rather than warns if it goes over.
The timed children still launch from TypeScript source, so these figures and DR1's 45 ms budget on a 406 KB bundle are still not the same measurement.

The floors are measured after the corpora are generated and immediately before the operations they are subtracted from, so both share their conditions.
Measuring them first, on an idle machine, put 430 MB of corpus writeback into program cost and opened six small-scale rows by up to 58%.

## Targets met

| Target | Measured |
|---|---|
| A1, 100% of reported writes persisted at every N | 1.000 in every round; 200 of 200 at N=200, at a 1-minute load of 61.30 |
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
| DR8, install size at most 1.5 MB unpacked | 284,749 bytes across 21 files |
| DR8, bundle at most 500 KB | 208,691 bytes |

A3 is the widest margin in the table.
The bare dashboard is 3.1x smaller than the reference's and the nine-item list 2.5x smaller, while carrying sprint identity, points, per-column WIP against limits, a ranked next-three and a blocked block that the reference has no concept of.
`test/cli/budget.test.ts` gates those bytes; its own header records that the token figures were taken outside the tree because a tokenizer is a package and the product ships zero runtime dependencies.
This rig carries all three tokenizers as development dependencies, so the token half is measured in-repo: bytes per token range from 2.44 on `next` to 3.88 on `backlog`, a 1.59x spread that a byte budget alone hides.

A6, A7, A8 and A10 are the four axes filled in this run that meet their target, and each beats the reference outright rather than narrowly.
The reference wrote to the wrong store in one scenario of three, kept no history at all, refused none of six illegal transitions and refused none of eleven invalid creations.

Of 35 budgets in the appended run: 22 pass, 0 fail, 13 open miss, 0 pending.

## Targets missed

The first two are measured once in the appended run, at the command surface, and are counts rather than timings.
The third is a timing, and the series below is what bounds it.

| Target | Reference | Measured | Miss |
|---|---|---|---|
| A2, every one of the 25 questions answerable with one command | 4 full, 6 partial, 15 none | 10 full, 7 partial, 8 none | 15 of 25 short of full |
| A12, every verb with a machine-readable object on both paths | mutations only, reads refuse the flag, errors on stdout | 25 of 26 invocations hold the contract, across 13 verbs | one invocation |
| A4, read and create below 150 ms at 50k, startup excluded | 89/90 ms at 100 items, 154/141 ms at 5k | read 292.1 ms, create 672.5 ms | 1.95x and 4.48x |

A2's eight unanswerable questions are 7, 8, 9, 10, 15, 19, 20 and 21, and every one of them needs an entity or a metric this tree does not implement: a sprint, an impediment, a board column, a relation, or a flow metric.
The per-question table is in the appendix under "A2, the 25 questions and how each was scored", with the command each question was put to and what a full answer would have to contain, so the scoring can be checked rather than trusted.
Seven more score partial: the answer is there for one named item but not for the workspace, or the set is one filter away but the window or the edge that would complete it is not stored.
Against the reference on the same list this is 2.5x as many questions answered whole, and 8 unanswerable against its 15.

A12's one miss is a defect in this product and is described below.

The remaining rows are the ten-run series, taken on 2026-09-04 on the tree before #4 and #7, and no figure in it was re-taken.
It is the only evidence here of run-to-run drift, so it is kept and marked rather than replaced by any single run.

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
Its median sat between 147.7 and 150.1 ms in nine of the ten pre-#4 runs and reached 157.9 in the tenth, and a quieter run taken fifteen minutes before the appended one put its p95 at 154.0 ms.
The appended run reads 292.1 ms for the same operation, which is the machine: its `node -e` floor is 44.1 ms against 38.2 ms in that quieter run, and eight timing budgets opened with it.
Read is at the target rather than under it, and a claim that it passes would rest on which run got quoted, which is why the series is the claim and no single run is.

Create misses on every run and misses wide.
The mechanism is in the corpus table: a create appends one record to the largest shard, which holds 2,176 records in 1.06 MiB, and the whole shard is rewritten and re-indexed.

`list` and `transition` are not axis targets but bound the same work: `transition` is the most stable figure in the whole rig at 428.9 to 447.6 ms across ten runs, and `list` is 161.0 to 164.0 in eight runs and 209.0 and 491.7 in the two loaded ones.

Five of the DR8 rows are budgets the landed store has never met, and DR8's numbers came from throwaway spikes that no longer exist rather than from this code.
They are recorded as open misses: printed with their number, not failing a build for standing still.
A budget nobody has ever met is a finding, not a regression.

### What happened to the seven timing, memory and size misses

Every figure in this subsection was taken on the machine the table above names, Apple M2, 8 cores, 16 GB, `darwin 25.6.0`, `arm64`, on Node 24.11.1, which is still below the 24.15.0 floor `package.json` declares.
The corpus is the same one, seed `20260905`, 50,000 items in 24 shards with a largest month of 2,176 records in 1,115,493 bytes, restored from an untouched copy before every measurement so that a mutation never measures the store a previous mutation left.
The 1-minute load either side of each run is given with it.

Two of the seven are closed by changing the code, two are corrected budgets, and three are still open with a smaller number than they had.
The before column below is that same corpus re-measured on this machine beside the after, not the median of ten above, because a before and an after have to be taken under the same conditions.

| Target | Budget | Before | After | Verdict |
|---|---|---|---|---|
| A4, create at 50k, startup excluded | 150 ms | 322.6 ms | 136.1 ms, p95 139.8 | closed by optimisation |
| A4, read at 50k, startup excluded | 150 ms | 144.0 ms | 7.2 ms | closed by optimisation |
| DR8, peak RSS on a read at 50k | 100 MiB | 185.8 MiB | 99.2 MiB from source, 52.6 MiB from the bundle | closed, on the line from source |
| DR8, peak RSS on a mutation at 50k | 120 MiB | 220.9 MiB | 151.4 MiB from source, 122.7 MiB from the bundle | still open, 1.02x from the bundle |
| DR8, first index build at 50k | 6,000 ms | 10,504 ms | 10,250 ms | still open, 1.71x |
| DR8, re-index after a hand edit | 50 ms | 249.1 ms | 100.4 ms | budget corrected to 135 ms |
| DR8, index size against the text it indexes | 1.0x | 2.064x | 1.538x | budget corrected to 1.6x |

Every before and after in that table is one interleaved run of three repetitions on the same corpus bytes, with the trees alternating inside each repetition and fifteen cold processes per operation.
That shape is not decoration.
The first before and after this work produced were taken forty minutes apart, at 1-minute loads of 68.77 and 6.45 on a machine that also moved from 98.7% to 58.7% memory in use, and their `node -e` floors were 504.2 ms and 37.6 ms.
Those two numbers measured the machine.
The run in the table sat at a 1-minute load of 3.98 to 5.66 with a `node -e` floor of 37.6 ms on both sides, against the appendix run's own 38.5 ms, and its baseline column reproduces the published medians of ten: create 322.6 against 311.1, read 144.0 against 148.6, read RSS 185.8 against 182.0, mutation RSS 220.9 against 216.6, index ratio 2.064 against 2.06.
A before and an after taken under different conditions are not a comparison.

### The mechanism, which was one thing and not five

The report above named the create path and it was right about it.
It was not the largest cost.

A CPU profile of a single warm `get` at 50,000 items put 117 ms of its 218 ms in the load-time hierarchy cycle check, plus most of a further 37 ms of garbage collection that the same check's allocations caused.
`#hierarchyFindings` read five columns of all 50,000 rows out of SQLite, mapped them into 50,000 objects, and built a `HierarchyGraph` of five Maps, in order to answer a question that only the parent edges decide.
It ran on every command, and `transition` ran it twice, because `get` refreshes and then `apply` refreshes again inside the lock.

The check itself is not optional.
Finding F8 is that a write-time cycle check cannot see an edge a hand edit or a git merge put in a file, and decision D1 makes the file the authority.
What is optional is recomputing it when nothing moved.

The walk now takes the parent edges alone, read as two columns with a `parent is not null` clause, and its verdict is stored in the index beside the rows it came from.
Any transaction that inserts or deletes an item row also records what it moved.
A refresh that moved no parent edge reads the verdict.
A refresh that moved some, over a store already known to be acyclic, walks up from those nodes alone, because a cycle that was not there before has to pass through an edge that moved.
A store already reported cyclic recomputes whole as soon as any row moves at all, because dropping the edge that closed a cycle moves no edge, and a rule watching only for moved edges would keep reporting a cycle a hand edit had removed.
That last case is not hypothetical: the regression test for this covers both directions across two shards, and it is what caught the first version of the rule.

Read at 50,000 items went from 144.0 ms to 7.2 ms, and it is now flat: 7.1 ms at 100 items, 7.3 at 1,000, 7.3 at 10,000, 7.3 at 50,000.
A read no longer scales with the store.

Four smaller changes carry the rest.
A re-index applied its file's rows as a difference rather than as a drop and a reload, because every column but the key is derived from `source` and a row whose id, line and source are unchanged is the row the reload would have written.
The write path stopped parsing its shard twice, once in the refresh that runs inside the lock and once again in `readShard`, reusing the first parse when a stat proves the bytes have not moved.
`items_state` led on `(state, priority)` and no query in this store orders by priority, so a `backlog` read sorted every matching row, each carrying a whole record's source text, to return fifty; it is now `(state, filed_at, id)` with `(filed_at, id)` beside it.
And the events table stored each log line whole beside six columns that already carried six of its keys, so it now stores the remainder and a read rejoins the two halves in DR3's key order.

### Peak RSS on a read: closed, and the budget was never the store's to miss

**Corrected below.** This section is kept as the record of what was measured in the appended run, and the operation it measures is `store.list` bounded at 50 rows, which no command performs. "The read every command performs is the wall that is still standing" carries the figure for the read the product actually makes, and the gate now weighs this budget over the worst of its set rather than over `list`.

Peak RSS on a read at 50,000 items is 99.2 MiB against 100 MiB.
That is a pass by 0.8%, which is too close to celebrate, so here is what the number is actually made of.

At 100 items the same read peaks at 98.5 MiB.
At 1,000 it is 99.2, at 10,000 it is 99.0, at 50,000 it is 99.2.
The store contributes 0.7 MiB across a 500x range in corpus size, and a `npm run bench` whose largest scale is 1,000 items still prints this row as an open miss at 102,544 KiB against 102,400.
A budget that a thousand-item store misses is not measuring the store.

Measured on the same machine with the same launcher: `node -e` alone peaks at 41.5 MiB, one type-stripped TypeScript file at 68.6 MiB, and the store adapter loaded with no work done at 95.9 MiB.
Node's type stripper costs 27.1 MiB of resident memory and the module graph another 27.3 before a single record is read.
The product does not ship TypeScript source.
Running the identical timed child through esbuild with the release path's own settings puts the same read at 52.6 MiB, 1.9x under the budget, and takes 67 ms off every cold invocation as well.

So the budget is left exactly where it is, because it is met.
What the rig prints straddles it because the timed children launch from source and the shipped artefact is a bundle, which is the gap the floors table has been pricing since this file was written.

### Re-index after a hand edit: the budget was below the floor of the work

This is the first of two budgets moved, and the argument is a measurement rather than a preference.

ADR-0002 shards by month so that freshness is a stat per file, 0.27 ms across 24 shards.
The price of that choice, written into the same ADR's consequences, is that a file whose stat moved is re-read and re-parsed whole.
At 50,000 items over 24 months the largest shard is 2,176 records in 1,115,493 bytes.

Reading, parsing, decoding and hashing that one file, with no index and no store around it, is 59.0 ms at the median of twelve runs: read 0.6, parse 30.3, decode 26.1, hash 1.9.
DR8's budget is 50 ms.
No implementation of this layout reaches it on this corpus, because the floor of the unit the design re-indexes is already 9 ms above the budget for the whole operation.
That is what makes this a budget correction rather than an excuse.

The new limit is that floor plus the measured cost of the freshness pass and the index difference on top of it, 100.4 ms at the median of five hand edits, times the 35% tolerance `bench/budgets.json` already commits to for run-to-run drift: 135 ms.
It was 249.1 ms before the difference-based re-index landed.
The figure tracks the shard rather than the store, at 11.0 ms over 9 records, 14.9 over 55, 34.6 over 477 and 100.4 over 2,176, which is 46.1 microseconds per record re-indexed at the largest scale.
It stays unenforced for the reason every other wall time here does, that a different runner moves it on its own.
ADR-0002's own reopening condition, a month filing more than about 5,000 records, is the point at which the shard key and not this number is what should change.

### Index size: the budget was measured against a different index

This is the second, and ADR-0002 had already written down half the argument.

DR2 measured 0.7x over an index of columns.
ADR-0002 departed from that on purpose and recorded the departure: this index also caches every record's rendered source, so that a `get` is one index lookup and never reopens a shard.
A budget taken from the first design cannot be met by the second, and the departure is the one this store wants to keep, because `get` is 7.3 ms at 50,000 items and flat from 100 items upward.

So the number is corrected against what the index actually holds.
`dbstat` over the 50,000-item corpus, against 110.3 MiB of records and log:

| Segment | Before | After | What it buys |
|---|---|---|---|
| `items` table | 34.6 MiB | 34.6 MiB | 24.4 MiB of it is `items.source`, exactly the record text, which is what makes `get` a lookup |
| `items` indexes | 3.1 MiB | 6.7 MiB | the two orders `listItems` asks for, replacing one order no query asks for |
| `events` table | 139.9 MiB | 78.3 MiB | 44.8 MiB of columns and 23.4 MiB of the remainder, where it was 44.8 MiB of columns and 85.4 MiB of whole lines |
| `events` indexes | 50.1 MiB | 50.1 MiB | the primary key an idempotent append needs, and the two the entity and file queries range over |
| Total | 227.6 MiB | 169.6 MiB | 2.064x becomes 1.538x |

Reaching 1.0x now means dropping `items.source` and reopening a shard on every `get`, or replacing the event remainder with an offset into the log.
Both are design reversals, not tuning, and neither is a thing to do on the way past.
The limit is 1.6x, the measured figure with room for the corpus mix to move.
It is not armed, and the reason is the gate rather than the drift: a size does not drift run to run, reading 2.064 in every run before this change and 1.538 in every run after, but the gate weighs the largest corpus of the run and a pull-request run stops at 1,000 items, where the same index reads 1.868x because 421,888 bytes of SQLite pages over 230,591 bytes of text is the page floor and not what the index stores.

### Still open: peak RSS on a mutation, and the first index build

Two are still open, and neither is closed by anything in this pull request.

Peak RSS on a mutation is 151.4 MiB from source and 122.7 MiB from the bundle, against 120 MiB.
It is 1.02x over on the shape the product ships, and it is the only DR8 memory figure that still moves with the store: 99.6 MiB at 100 items, 102.4 at 1,000, 110.5 at 10,000, 151.4 at 50,000.
The mechanism is the shard the report already named.
A create rewrites the whole of the largest month, so one mutation holds that file's 1,115,493 bytes as a string, its parse, its re-render, and the journal's JSON copy of the same bytes.
Closing it means not copying the shard three times, which is a change to DR4's journal format and not a tuning constant.

The first index build is 10,250 ms against 6,000 ms, down from 10,504 ms, which is to say untouched.
A CPU profile of the cold build puts 6,120 ms of it, 59%, in `replaceEventFile`: 500,000 event rows at about 12 microseconds each, every one of them writing a primary key, an `events_file` entry and an `events_entity` entry.
The build is linear in the corpus at 57 ms over 100 items, 212 over 1,000, 1,933 over 10,000 and 10,267 over 50,000, so the figure is the row rate and nothing else.
The next thing to try is inserting events in batched multi-row statements rather than one at a time, and it is not tried here because it is a separate measurement and this pull request already carries five.

A budget nobody has ever met is a finding rather than a regression, and that is still true of these two.
The difference is that both now have a named mechanism and a number attached to it.

### A finding this work turned up, which is larger than any of the seven

The seven targets are store operations, and this document has said so since it was written: the timed children call `get`, `list` and `apply` at the store seam, not the command surface.
So a reader who takes a 7.3 ms `get` at 50,000 items as what `treadle show` costs would be wrong by two orders of magnitude, and the number is worth writing down.

The same three commands on the same 50,000-item workspace, index warm, best of five, run from source on both trees:

| Command | Before | After |
|---|---|---|
| `treadle show wi-024584` | 1,849 ms | 1,584 ms |
| `treadle backlog --state ready` | 1,850 ms | 1,814 ms |
| `treadle status` | 2,043 ms | 1,518 ms |

The output is byte-identical on both.
A CPU profile of `treadle show` on the new tree accounts for 1,406 ms of it, and 866 ms of that is decoding every record in the store: `decodeItem` 215.7 ms, `validateWorkItem` 190.6, `listItems` 141.1, `parseSegment` 109.5, the safe-text regex 95.0, `#decodeRow` 72.8 and `findUnsafeCharacter` 41.3, with a further 93.5 ms of garbage collection on top.

The mechanism is `readWorkspace` in `src/application/services/context.ts`, which calls `store.list()` with no query and then builds a `byId` map and a full hierarchy off it.
Every command pays it, including one that prints a single record.
That is the same shape the store had before this work, one layer up: a whole-store read to answer a question about one item.

It is not fixed here, and the reason is scope rather than difficulty.
`WorkspaceView`'s contract is one read of the store and every derived fact off that one read, so making it lazy is a change to what the command layer promises the domain, with its own correctness surface, in a file none of the seven targets measures.
It is the next thing to do and it is worth more than the three misses still open.

### What did not change

Every existing test stays green: 984 pass, 0 fail, against 981 before, the three added being the regression tests for the cycle verdict, for the event round trip, and for the crash window between a row commit and the verdict recompute that follows it.
The A1 durability and A5 malformed-input axes were compared against this branch's base, 01580d0, which predates #7: A1 reported 200 of 200 at N=200 with zero crashes on both trees, and the A5 corpus read identically on both.
See "The three defects the rig found, and what happened to them" below for #7's closure of the A5 silent drop.
No invariant was traded.
The one place where this work could have traded one, the cached hierarchy verdict, is kept correct by a marker of what moved, merged inside the same transaction that moves the rows it describes, so a crash between the two leaves work to redo on the next open rather than a stale verdict silently reused.

`list` and `transition` are not axis targets but bound the same work: `list` went from 160.6 ms to 10.3 ms and `transition` from 457.4 ms to 174.2 ms.

A budget that a hundred-item store also misses is measuring the runtime, not the code under it.

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
The appended run adds a sixth clean round set at a peak load of 61.30.
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
No process is spawned per invocation, because 612 spawns at the appended run's store-loaded floor of 188 ms is close to two minutes of Node startup, spent measuring behaviour that startup cannot change.

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
The appended run has eight timing rows open, `get`, `list`, `create` and `transition` at 1,000 items and `create` and `transition` at 10,000 and 50,000, from 5.1% to 18.2% over limits that already carry the 35% tolerance.
A run taken fifteen minutes earlier on the same tree had two of them open and the rest passing.
That is the gate reporting the machine rather than the code, which is exactly why the timing rows are not armed.

The six surface axes have no such spread to report.
Each ran in three recorded four-scale runs during this task and returned the same verdict and the same counts in all three, which is what a deterministic corpus and a fixed rule table buy.

## Confounds that could not be eliminated

Stated plainly, because each one bounds what these numbers support.

1. **The machine was shared throughout.** Sibling workers ran during every run, and the appended run started at a 1-minute load of 6.14 on 8 cores with 64.6% of memory in use. Load is recorded for the later runs only; the earlier ones contribute timings without it.
2. **The ten-run series predates #4 and #7.** It measures the store before the busy-timeout fix and before the heading resynchronisation, while the appended run measures the store after both. A series figure and an appendix figure are not measurements of the same store.
3. **Node 24.11.1 is below the product's declared 24.15.0 floor.** The store runs unchanged on both, and no figure here was taken on the runtime the package will ship against.
4. **The timed children run from TypeScript source, not from the bundle the package ships.** Every timed figure carries 36.4 ms of type stripping plus 57.3 ms of module loading that the bundle would mostly remove.
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

## Where it stops scaling, and what gives way first

Everything above stops at 50,000 items because that is what DR8 sized.
This section pushes past it and names the wall.
Every figure here was taken on the machine and runtime the table above names, on 2026-09-06, with sibling workers running throughout; the 1-minute load is given beside each group because none of it was taken idle.

Three things could give way: the wall time of an answer, the memory one answer holds, and the shard layout's own ceilings.
One of them had already given way below 50,000 and nothing said so.

### `doctor` was quadratic, and at 50,000 items it returned nothing at all

`doctor` handed every item the entire event log and `auditItem` filtered that log by entity three times per item, so the audit cost items x events.

| Corpus | Before | After |
|---|---|---|
| 100 items, 1,000 events | 375 ms | 272 ms |
| 1,000 items, 10,000 events | 1,338 ms | 342 ms |
| 10,000 items, 100,000 events | 273,554 ms | 991 ms |
| 50,000 items, 500,000 events | no answer inside 600,000 ms | 4,438 ms |

Index warm in every run, wall time measured around the shipped `bin/treadle.js`, at 1-minute loads of 8.5 to 20.9.
The finding list is byte-identical before and after at all three scales that produced one: 27, 238 and 2,473 findings.

Nothing about this was visible from the axis table, because no axis calls `doctor`.
It was found by running the command against the 50,000-item corpus and watching it not come back.
The fix buckets the log by entity once, which makes it linear in both, and the regression test asserts passes over the log rather than a wall time: the old code walked the whole log 150 times over 50 items, the new one walks it once.

A command that has no answer is a wall, and a command with no bound on its work has no way to say it reached one.

### The read every command performs is the wall that is still standing

`readWorkspace` in `src/application/services/context.ts` calls `store.list()` with no query, indexes the result by id and builds the hierarchy graph off it.
Every command pays it, including `show`, which prints one record.

Peak RSS and in-process time of that read against the bounded `list` the memory budget used to be weighed over, one cold process each, at 1-minute loads of 4.2 to 4.3:

| Items | `list`, 50 rows | the read every command performs |
|---|---|---|
| 131 | 101,456 KiB, 7.6 ms | 101,744 KiB, 14.4 ms |
| 1,320 | 100,448 KiB, 10.8 ms | 114,240 KiB, 46.1 ms |
| 10,120 | 100,736 KiB, 9.2 ms | 199,200 KiB, 275.7 ms |
| 50,022 | 102,400 KiB, 9.3 ms | 416,128 KiB, 1,578.4 ms |
| 100,001 | 103,040 KiB, 43.2 ms | 599,536 KiB, 2,773.2 ms |
| 200,001 | 100,592 KiB, 22.7 ms | 984,208 KiB, 6,116.7 ms |

The three rows past 10,000 are the median of three cold samples each, taken back to back at 1-minute loads of 3.7 to 4.3; the rows above them are one sample each from the appended run's corpora.
RSS is stable across the three: 414,896 to 416,592 KiB at 50,022, 599,360 to 599,776 at 100,001, and 967,024 to 984,768 at 200,001, a spread of 0.4% or less.
It is not stable against the machine's state, which is why the series exists: a single sample taken immediately after the 200,001-item corpus was generated, with the writeback still draining at a 1-minute load of 28.1, read 1,302,400 KiB, 32% high.

What the corpus adds over the runtime floor is 6.29 KiB per item at 50,022, 4.98 at 100,001 and 4.41 at 200,001, and the marginal cost between the top two scales is 3.85 KiB per item.

The instrument is `process.resourceUsage().maxRSS`, read in the process that did the work; libuv normalises the darwin `ru_maxrss` to KiB, and `/usr/bin/time -l` cannot report it in the sandbox these runs were driven from because `sysctl kern.clockrate` is denied there.
About 99 MiB of every row is the runtime rather than the corpus, which the floors table prices: `node -e` alone peaks at 41.5 MiB and the store adapter loaded with no work done at 95.9 MiB.

The same read at the command surface, one process per command, on the 50,021-item corpus at a 1-minute load of 4.2:

| Command | Wall | Peak RSS | Bytes printed |
|---|---|---|---|
| `treadle show wi-000286` | 1,262.9 ms | 418,672 KiB | 532 |
| `treadle backlog --limit 9` | 1,285.3 ms | 419,200 KiB | 862 |
| `treadle next --limit 3` | 1,321.7 ms | 419,392 KiB | 458 |
| `treadle status` | 1,313.3 ms | 419,632 KiB | 601 |
| `treadle history wi-000286` | 1,247.2 ms | 419,584 KiB | 563 |
| `treadle backlog --limit 60000` | 1,360.6 ms | 426,672 KiB | 3,653,036 |
| `treadle file task "..."` | 1,308.4 ms | 430,256 KiB | 211 |
| `treadle doctor` | 4,338.9 ms | 1,060,816 KiB | 1,677,306 |

Printing 532 bytes costs 409 MiB and 1.26 s, and the figure does not move with what is asked for.
`doctor` is 1.01 GiB because it holds the 500,000 events beside the 50,000 items.

DR8's budgets are 100 MiB for a read at 50k and 120 MiB for a mutation.
The rig reported the read row as a pass at 99.2 MiB in the run appended below, and that figure is a `store.list` bounded at 50 rows, which no command makes.
The budgets are unchanged here; what changed is which operation they are weighed over, and the read row now reads 4.06x rather than 0.99x.
A budget met by an operation the product never performs is not a budget.

### The layout's own ceilings, and where the arithmetic puts them

`src/adapters/store/limits.ts` caps one shard at 8 MiB and 20,000 records, and ADR-0002's own reopening condition is a month filing more than about 5,000 records.
The corpus spreads its items over 24 months, and the largest month holds about 4.3% of them.

| Items | Shards | Largest shard | Of the 8 MiB cap | Index / text | On disk |
|---|---|---|---|---|---|
| 50,000 | 24 | 2,176 records, 1,115,493 B | 13.3% | 1.538x | 110 MiB |
| 100,000 | 24 | 4,315 records, 2,214,665 B | 26.4% | 1.539x | 221 MiB |
| 200,000 | 24 | 8,554 records, 4,393,898 B | 52.4% | 1.540x | 441 MiB |

The index ratio does not move with the corpus and the shard is linear in it: 512.6 B per record at 50,000, 513.3 at 100,000 and 513.7 at 200,000.
At that rate the 8 MiB byte cap is reached by a month holding about 16,330 records, which this distribution reaches at roughly 380,000 items, and the 20,000-record cap at roughly 465,000.
ADR-0002's own reopening condition of 5,000 records in one month arrives first, at about 116,000 items, and 200,000 is already past it.

### The write path builds a shard the read path refuses

That ceiling is not extrapolated here, it is reached: 20,000 records filed into a single month through the landed store.

```text
$ ls -l items
-rw-r--r--  1  10246139  2026-09.md

$ treadle status
err INTEGRITY -
rule S4
"cause items/2026-09.md line 1: items/2026-09.md is 10246139 bytes, over the 8388608 byte
 ceiling for a record file; it is not served; that finding hides a record this workspace
 holds, so no answer over it is whole
fix treadle doctor
[exit 7]
```

`doctor` reports the same finding and `checked 0`, and `treadle file` into the same workspace exits 7 with it.
`MAX_FILE_BYTES` is read in `src/adapters/store/grammar.ts:351` and in `src/adapters/store/sharded-store.ts:167`, both on the read path, and nothing consults it before a write.
So `store.apply` reported `ok` for the transaction that produced the file, and every command since has refused the workspace it produced.
The refusal is loud, names the file, the byte count and the cap, and there is no command that splits a shard, so the workspace is unrecoverable through the tool.

That is the wall, and it is the one shape of degradation that is not graceful: the ceiling is enforced where the damage is discovered rather than where it is done.
This is left to whoever owns the store's ceilings rather than fixed here, because the guard belongs beside the four `S` rules in `src/adapters/store/`.

### What gives way, in the order it gives way

1. **From about 1,300 items**, the read every command performs is over DR8's 100 MiB budget. Most of that is the runtime: the timed children launch from TypeScript source, and "Peak RSS on a read" above measured the same read at 52.6 MiB through the release path's bundle against 99.2 from source. Even from that floor, 3.85 KiB per item spends the remaining headroom by about 12,600 items.
2. **From about 116,000 items**, a month holds more than the 5,000 records ADR-0002 set as its own reopening condition.
3. **At about 380,000 items**, the largest month crosses the 8 MiB shard cap. The write is accepted and every read of that workspace refuses from then on.
4. **At about 1,000,000 items**, the whole-workspace read reaches 4 GiB at the marginal 3.85 KiB per item, which is the region of Node's default old-space limit.

The wall this tool meets first is `readWorkspace`, and it is nowhere near the shard key.

## Deep pagination, proved by counting

`backlog`, `history` and `next` page by naming an id in a `page` line the caller follows.
Whether that walk is exact is a counting question, so it was counted rather than inspected.
The reader follows only the `page` line the tool prints, through the shipped `bin/treadle.js`, and compares the ids it collected against the tool's own `total` and against one unpaged read.

| Walk | Pages | Rows returned | Distinct | Duplicates | Missed |
|---|---|---|---|---|---|
| `backlog --limit 500` over 50,021 items | 101 | 50,021 | 50,021 | 0 | 0 |
| `history --limit 3` over 402 events | 134 | 402 | 402 | 0 | 0 |
| `backlog --limit 100` over 10,031 items with a writer filing one item every 150 ms | 102 | 10,119 | 10,119 | 0 | not applicable |

The set the 101 pages produced is equal to the set one unpaged read produces, in both directions: 0 ids in the pages and not in the whole, 0 in the whole and not in the pages.

### What the walk actually guarantees

It is exact over a workspace that does not change under it, and it is not a snapshot.
Each page is a fresh whole read, sorted by `priority, filed_at, id`, sliced from the cursor id.
So the guarantee is stated by what a concurrent writer can do to the sort key, and all three cases were driven deterministically with the write placed between two pages:

- **An append is picked up.** A new item has no priority and today's `filed_at`, so it sorts to the end. 88 items landed during the 102-page walk above and all 88 were returned, with no duplicate.
- **An item whose key moves from after the cursor to before it is skipped.** Nine items at `--limit 3`; between page 1 and page 2 a writer raised `itm-8` to priority 1. Pages 2 and 3 returned `itm-4`, `itm-5`, `itm-6`, `itm-7`, `itm-9`. `itm-8` was never returned: 8 of 9 items for a walk that read every page.
- **An item whose key moves the other way is returned twice.** The same nine items; between page 1 and page 2 a writer dropped `itm-2`, already returned on page 1, to priority 5. Page 3 ended with `more 1`, and the item that page names is `itm-2`.

That is a read-committed walk over a moving list, and it is what an offset-free cursor over a re-sorted set can offer without a snapshot.
It is written down here because a caller cannot infer it from the output.

### The case that was silently wrong

A cursor the list no longer holds returned index -1, and all three commands clamped that to 0 and served the first page.
Measured on the 10,000-item corpus before the fix: `treadle backlog --state ready --limit 3 --cursor wi-003956`, where that item is `done` and so outside the filtered list, printed byte for byte what `treadle backlog --state ready --limit 3` printed.
A writer that transitions the cursor item out of the filter therefore turns a walk into a loop over the first pages, with nothing in the output to read it from.

All three now refuse with `C1`, name the cursor, and give the command that starts the walk again.

## Forward compatibility, measured

`docs/STABILITY.md` makes one promise: unknown fields and unknown sections are preserved verbatim and travel with the record through every mutation, so an older tool writing a newer file loses nothing it did not understand.
Five shapes of "written by a newer version" were driven against a build that has never seen them, each in its own workspace, through the shipped entry point.

| What a newer version wrote | This build's answer |
|---|---|
| An unknown field key, `risk_tier: gold` | **Preserved.** It survives a `set`, is re-rendered after the known fields in dictionary order, and is counted by `extra` on `show` |
| An unknown H2 section | **Preserved.** It survives a `set` and is re-attached after the sections this build knows |
| An unknown event op, `item.escalate`, with an unknown key beside it | **Ignored, and preserved.** `history` prints the op verbatim and counts the unknown key as `+1`, `doctor` reports the store clean, and nothing rewrites the log |
| An unknown item type, `type: gadget` | **Refused, workspace-wide.** Every read exits 7 naming `V4` and the record; `doctor` lists one finding per bad record. The refusal hides the other records in the same workspace, which is `readWorkspace`'s stated contract rather than an accident |
| A file at a newer schema, `schema: 2` | **Refused.** `S8` names the file, `doctor` lists it, and every read and every write over that workspace exits 7. `workspace.md` at a newer schema refuses at `S1`/`S8` with exit 6 |
| A gate rule a workspace configured | **Ignored in silence.** There is no surface to configure one: `evaluateGate` takes a `Gate` and no adapter reads one from the workspace, so a `## Gates` section added to `workspace.md` is neither read nor reported, and is preserved because nothing rewrites that file |

The promise holds where it is made, and the two refusals are the design working: a new item type or a grammar change bumps the compiled-in schema number, and `docs/STABILITY.md` already classes that as breaking with a minor bump.

Two things beside it read false and one of them is fixed here.

The refusal on `show <id> --field risk_tier` said "carries no field named risk_tier" for a key the file did carry and that `show` was counting under `extra` in the same output.
The value stays unprinted, for the reason the count exists, and the refusal now says which of the two answers it is.

The other is reported rather than fixed, because the message belongs to the store.
`S8` says "every other file keeps serving", which is true of the store and false at the command surface: with one shard at `schema: 2`, `show`, `backlog`, `set` and even a `file` into a different month all exit 7.
A caller reads that clause and concludes some commands will work.

## What a cold caller could not learn from the tool

A caller that had never seen this tool or this workspace drove `file`, `advance`, `gate`, `complete` and `audit` using only `treadle help` and each step's own output.
It completed the flow.
`explain` is what carries it: it prints every failing gate rule with the exact command that clears it, and `transition`'s refusal points back at `explain`.

Six places needed knowledge the tool did not give it.

1. **`--cursor` was in no help output.** The tool prints `page treadle backlog --cursor <id>` itself, and `--cursor` was absent from the flag matrix, so `treadle help backlog` never named it and `treadle show <id> --cursor x` was accepted in silence where `--limit` is refused. `history`'s usage line carried it and `backlog`'s and `next`'s did not. Fixed: it scopes as `--limit` does and all three usage lines name it.
2. **`set` printed `[object Object]`.** Writing acceptance criteria answered `set acceptance_criteria - -> [object Object],[object Object]`, and the event log recorded the length of that placeholder as the value that moved. Fixed: a criterion prints as `open` or `done` and an evidence pointer as its kind.
3. **The actor is `unknown` and nothing says how to set it.** `init` printed `actor unknown`, every event's `by` column says `unknown`, and `explain` prints `"by unknown`. `TREADLE_ACTOR` and `TREADLE_ACTOR_KIND` are read in `src/cli/main.ts` and appear in no help output, no example and no README line. A cold caller writes an unattributed audit trail and is not told.
4. **Command-specific flags are not in help.** `help <command>` lists the 17 global flags with a verdict each, and command flags appear only where a `usage` line happens to name one. `file` accepts `--id`, `--desc`, `--assignee`, `--label`, `--sprint` and `--parent`, and its usage line names none of them; `transition` accepts `--reason`, `--until`, `--resolution`, `--outcome` and `--override`; `backlog` accepts `--sprint` and `--priority`. The parser refuses an unknown flag by naming the option table, so a caller finds these by being refused rather than by asking.
5. **`--contract`, `--no-color`, `--ascii` and `--log-values` are accepted and documented nowhere.** `treadle --contract` prints the line grammar, which is the one thing an agent most needs first, and no help output mentions it.
6. **The word "gate" reaches no command.** The top-level table's 15 summaries never use it; the gate verdicts live in `explain`, whose summary is "Say why one item is where it is". A caller told to gate an item guesses, and learns from the first `GUARD_REFUSED`, whose `fix` line names `explain`.

## The run

## treadle benchmark run 2026-09-05T12-08-34-931Z

Started 2026-09-05T12:08:34.931Z, finished 2026-09-05T12:16:08.879Z, 453.9 s of wall time.
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
| at the start | 6.14 | 8.78 | 11.3 | 5794 | 64.6% | 7 |
| at the end | 10.97 | 19.79 | 15.91 | 7235 | 55.8% | 5 |

Across the 20 timed operations the 1-minute load ranged from 4.47 to 5.41.

### What the harness itself costs

Each row is a strict superset of the one above it, so a difference prices exactly one thing.
The spawn floor is subtracted from every net column below; the node floor is what the CI gate compares against.

| Floor | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| spawn floor (/usr/bin/true) | 50 | 0 | 3.2 | 2.2 | 2.7 | 2.9 | 3.0 | 50/50 | n/a | NOT MEASURED | NOT MEASURED | 4.98 to 4.98, 7 node proc |
| node floor (node -e) | 50 | 51 | 38.9 | 38.4 | 44.1 | 52.2 | 61.8 | 50/50 | 49.5 | NOT MEASURED | NOT MEASURED | 4.98 to 4.98, 7 node proc |
| node + one JavaScript file | 50 | 51 | 57.2 | 47.7 | 55.4 | 68.7 | 71.6 | 50/50 | 66.0 | 0.0 | 44.9 | 4.98 to 5.3, 7 node proc |
| node + one TypeScript file (type stripping) | 50 | 51 | 113.2 | 84.1 | 106.1 | 127.7 | 137.7 | 50/50 | 125.0 | 0.0 | 68.6 | 5.3 to 5.2, 7 node proc |
| node + the store adapter loaded, no work done | 50 | 51 | 143.3 | 141.4 | 188.0 | 213.7 | 241.9 | 50/50 | 211.0 | 0.0 | 96.9 | 5.2 to 5.09, 7 node proc |

Type stripping costs 36.4 ms and loading the store adapter costs 57.3 ms on top of it, both taken from the best of N: they are fixed costs, and the cleanest launch of the fifty is the closest thing to an uncontaminated reading of one.
DR1 measured its budget on a 406 KB bundle. The tree now builds one, weighed in the package table above, but the timed children below still run from TypeScript source and carry both of those costs; bundling them is what would make these figures comparable with DR1's.

### Corpora

Written through the landed store, not synthesised as files. Item counts are read back from the store after generation.

| Items in store | Shards | Largest shard | ready matches | Records bytes | Events bytes | Index bytes | Generated |
|---|---|---|---|---|---|---|---|
| 100 | 23 | 2024-12: 9 records, 4.2 KiB | 9 | 49.3 KiB | 175.9 KiB | 520.0 KiB | 0.4 s |
| 1000 | 24 | 2025-04: 55 records, 27.5 KiB | 130 | 498.9 KiB | 1.7 MiB | 4.6 MiB | 0.7 s |
| 10000 | 24 | 2025-08: 477 records, 238.7 KiB | 1450 | 4.9 MiB | 17.2 MiB | 45.4 MiB | 4.1 s |
| 50000 | 24 | 2025-08: 2176 records, 1.1 MiB | 7295 | 24.4 MiB | 85.8 MiB | 227.6 MiB | 36.9 s |

### Latency, one cold process per sample

`net p95` is the wall p95 with the spawn floor removed. `in-process p95` excludes Node startup and module loading entirely, which is the form axis A4 targets.
These are store operations rather than commands: the timed children call the store directly so a millisecond is not mostly argument parsing. The command surface is measured by axes A2, A6, A7, A8, A10 and A12 below, which score behaviour rather than time.

#### 100 items, 23 shards, largest shard 9 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 138.4 | 145.3 | 171.8 | 205.2 | 208.0 | 30/30 | 202.6 | 9.7 | 97.4 | 5.09 to 4.92, 7 node proc |
| get | 30 | 31 | 142.9 | 155.5 | 180.8 | 251.1 | 264.3 | 30/30 | 248.4 | 21.8 | 99.4 | 4.92 to 4.69, 7 node proc |
| list | 30 | 31 | 156.6 | 161.6 | 192.4 | 330.9 | 357.8 | 30/30 | 328.2 | 58.7 | 99.4 | 4.69 to 4.51, 7 node proc |
| create | 30 | 31 | 178.5 | 176.7 | 204.3 | 251.0 | 263.9 | 30/30 | 248.3 | 66.0 | 101.0 | 4.51 to 4.47, 7 node proc |
| transition | 30 | 31 | 261.4 | 181.7 | 221.7 | 322.8 | 353.9 | 30/30 | 320.1 | 114.6 | 102.5 | 4.47 to 4.35, 7 node proc |

First index build with the index deleted: 237 ms. Re-index after a hand edit of the largest shard: 25 ms. Both in-process, one sample each.

#### 1000 items, 24 shards, largest shard 55 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 195.2 | 138.1 | 150.4 | 218.9 | 246.0 | 30/30 | 216.2 | 9.2 | 96.9 | 4.88 to 4.73, 7 node proc |
| get | 30 | 31 | 144.1 | 144.5 | 180.4 | 203.2 | 209.1 | 30/30 | 200.6 | 20.2 | 101.3 | 4.73 to 4.91, 7 node proc |
| list | 30 | 31 | 148.0 | 158.6 | 171.4 | 198.1 | 206.9 | 30/30 | 195.4 | 23.9 | 101.7 | 4.91 to 4.76, 7 node proc |
| create | 30 | 31 | 240.0 | 188.9 | 214.9 | 276.6 | 520.4 | 30/30 | 273.9 | 78.7 | 103.8 | 4.76 to 4.78, 7 node proc |
| transition | 30 | 31 | 224.4 | 187.6 | 234.7 | 268.0 | 281.1 | 30/30 | 265.4 | 78.7 | 104.9 | 4.78 to 4.91, 8 node proc |

First index build with the index deleted: 428 ms. Re-index after a hand edit of the largest shard: 32.8 ms. Both in-process, one sample each.

#### 10000 items, 24 shards, largest shard 477 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 30 | 31 | 180.1 | 164.7 | 194.7 | 222.5 | 237.6 | 30/30 | 219.9 | 13.4 | 97.5 | 4.91 to 5.16, 7 node proc |
| get | 30 | 31 | 230.4 | 199.4 | 216.9 | 261.8 | 262.3 | 30/30 | 259.1 | 69.2 | 119.4 | 5.16 to 5.06, 6 node proc |
| list | 30 | 31 | 207.4 | 206.5 | 228.3 | 262.0 | 276.3 | 30/30 | 259.3 | 85.6 | 119.4 | 5.06 to 5.13, 7 node proc |
| create | 30 | 31 | 263.6 | 253.7 | 303.7 | 400.9 | 419.0 | 30/30 | 398.2 | 203.4 | 125.6 | 5.13 to 5.35, 7 node proc |
| transition | 30 | 31 | 338.8 | 300.7 | 343.9 | 464.9 | 479.6 | 30/30 | 462.3 | 247.5 | 137.3 | 5.35 to 5.37, 7 node proc |

First index build with the index deleted: 2516 ms. Re-index after a hand edit of the largest shard: 101.1 ms. Both in-process, one sample each.

#### 50000 items, 24 shards, largest shard 2176 records

| Operation | n | ops | first | best | p50 | p95 | p99 | p99 rank | net p95 | in-process p95 | peak MiB | load 1m, node procs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| identity | 20 | 21 | 148.2 | 145.1 | 162.3 | 226.2 | 564.0 | 20/20 | 223.5 | 11.9 | 97.0 | 5.34 to 5.31, 7 node proc |
| get | 20 | 21 | 367.6 | 365.6 | 396.5 | 497.9 | 527.9 | 20/20 | 495.2 | 292.1 | 180.7 | 5.31 to 5.13, 7 node proc |
| list | 20 | 21 | 498.6 | 378.3 | 389.7 | 472.0 | 498.2 | 20/20 | 469.3 | 288.8 | 182.8 | 5.13 to 5.41, 7 node proc |
| create | 20 | 21 | 479.6 | 634.3 | 695.1 | 857.4 | 890.0 | 20/20 | 854.7 | 672.5 | 221.9 | 5.41 to 4.88, 7 node proc |
| transition | 20 | 21 | 814.9 | 682.2 | 830.7 | 1033.8 | 1057.0 | 20/20 | 1031.2 | 824.6 | 258.7 | 4.88 to 4.52, 7 node proc |

First index build with the index deleted: 14032 ms. Re-index after a hand edit of the largest shard: 393.3 ms. Both in-process, one sample each.

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
The explain row was re-derived by executing runA3 in bench/axes/a3-output.ts against the current golden results with the real tokenizers from bench/tokens.ts.
Only the explain row moved because that axis is a pure function of the golden results and explain is the only golden whose output this change alters.

| Artefact | Bytes | Budget | Within | claude | o200k | cl100k | B/token claude | Reference | Against reference |
|---|---|---|---|---|---|---|---|---|---|
| status | 463 | 1074 | yes | 155 | 166 | 167 | 2.99 | 1441 | 463 B against 1441 B, 0.32x |
| backlog | 717 | 964 | yes | 185 | 185 | 185 | 3.88 | 1781 | 717 B against 1781 B, 0.40x |
| backlog-empty | 120 | 140 | yes | 35 | 37 | 37 | 3.43 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| show | 273 | 310 | yes | 89 | 91 | 92 | 3.07 | 322 | 273 B against 322 B, 0.85x |
| next | 380 | 514 | yes | 156 | 147 | 148 | 2.44 | 659 | 380 B against 659 B, 0.58x |
| explain | 471 | 762 | yes | 171 | 166 | 165 | 2.75 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition | 131 | 230 | yes | 44 | 44 | 44 | 2.98 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-already | 100 | 110 | yes | 37 | 37 | 37 | 2.7 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-dry-run | 163 | 250 | yes | 53 | 53 | 53 | 3.08 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| transition-preview | 233 | 254 | yes | 75 | 68 | 69 | 3.11 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| not-found | 156 | 164 | yes | 51 | 49 | 47 | 3.06 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |
| guard-refused | 237 | 278 | yes | 80 | 76 | 76 | 2.96 | NOT MEASURED: the prior-art axes table carries no byte count for this artefact | no reference figure |

### Package

| Fact | Value |
|---|---|
| Runtime dependencies | 0 |
| Development dependencies | 7 |
| Packed | 63.9 KiB |
| Unpacked | 278.1 KiB |
| Files in the package | 21 |
| Bundle | 203.8 KiB |

### The twelve comparison axes

| Axis | Verdict | Observed | Reference | Target | ops | samples | peak load 1m |
|---|---|---|---|---|---|---|---|
| A1 Write durability | MET | 5: 5/5, 24: 24/24, 60: 60/60, 200: 200/200; every reported write is on disk, zero refusals, zero lock or temp files left. Zero writers crashed | 100% at 5, 24, 60 on both builds (prior-art E1); 200 not run | 100% at every N, and zero silent mis-targets under the A6 scenarios | 289 | 4 | 61.3 |
| A2 Question coverage | MISSED | 10 full, 7 partial, 8 none, out of 25, against the reference's 4 full, 6 partial, 15 none; the 8 that score none are 7, 8, 9, 10, 15, 19, 20, 21, and every one of them needs an entity or a metric this tree does not implement | 4 full, 6 partial, 15 none | 25 full | 37 | 25 | 13.33 |
| A3 Token cost | MET | status 463 B against 1441 B, backlog 717 B against 1781 B, show 273 B against 322 B, next 380 B against 659 B; all 12 artefacts inside their A.3 budget | 1441, 1781, 322, 659 bytes (prior-art E10) | at most the same bytes for the same information, every extra byte attributable to a field the reference lacks | 12 | 12 | not sampled |
| A4 Latency at scale | MISSED | at 50000 items, startup excluded: read p95 292.1 ms, create p95 672.5 ms | 89/90 ms at 100, 154/141 ms at 5k, startup 83 ms (prior-art E11) | below 150 ms at 50k for read and create, startup excluded and reported separately | 570 | 550 | not sampled |
| A5 Malformed-input robustness | PARTIAL | 206 damaged stores read: 2 edit removed the record, 90 refusal names the record, 113 absorbed, 1 refusal names the file only | heading rename: silent drop; bad metadata line: whole-store refusal; duplicate id: silent; self-edge: silent; cycle: accepted | zero silent drops, zero whole-store refusals, every refusal names the record | 206 | 206 | 61.3 |
| A6 Mis-target rate | MET | 0 mis-targets in 10 writes with no explicit target, across all three scenarios; 1 explicit --workspace write landed where it was pointed; 3 of 3 seam resolutions correct; no command invented a store; every write that landed printed the workspace identity in its envelope, while the filesystem path is printed by status, doctor and --preview but not by an applied write | 1 of 3 scenarios writes elsewhere silently (prior-art E2) | 0 of 3; every write prints the store identity | 38 | 11 | 13.33 |
| A7 Audit answerability | MET | 50 of 50 items explained: the named event is in the log, the replay of 250 events ends in the state shown, and every event carries an actor | 0 of 50, the reference keeps no history | 50 of 50 | 303 | 50 | 12.42 |
| A8 Lifecycle enforcement | MET | 22 of 22 illegal pairs refused naming a rule id, 20 legal pairs behaved as the table says, 7 same-state requests returned the idempotent marker | 0 refused of 6 illegal pairs tried (prior-art E8) | every illegal pair refused with a guard id | 177 | 49 | 11.66 |
| A9 Metric coverage | NOT MEASURED | NOT MEASURED: no metric is implemented in this tree; nothing under src computes velocity, cycle time or a burndown series, so there is nothing to score and a figure here would be a figure about a harness | 0 of 14 | 14 of 14, each matching the spreadsheet | 0 | 0 | not sampled |
| A10 Type validation | MET | 11 of 11 refused with a rule id and nothing created; rule ids C1, V4, V5 | 0 of 11 refused, the reference has a single free-text kind | 11 of 11 | 25 | 12 | 11.66 |
| A11 Harness neutrality | NOT MEASURED | NOT MEASURED: the target has two halves and one of them has nothing to score: no adapter generator exists, because ADR-0012 refuses A.8 rule 3 for v1, so "adapters optional and generated" cannot be measured at all. The counting half is now reachable through the same harness the other axes use and is not run here rather than being reported half done | setup writes 4 files across 3 harnesses | 0 required; adapters optional and generated | 0 | 0 | not sampled |
| A12 Output contract | MISSED | 25 of 26 invocations held the contract across 13 verbs; version failure did not, and 3 of 3 probed parse-level refusals ignored --out json because src/cli/main.ts raises them before the rendering is chosen | mutations only; reads refuse the flag with exit 2; errors on stdout (prior-art E9) | every verb, both paths | 32 | 26 | 11.66 |

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
| 16 | which items belong to epic E and how far along is it | `show a2-child` | 0 | partial | the children of E with a rollup of their states | the parent edge is writable and printed, which is more than the reference managed; no verb lists the children of an epic and none rolls their states up |
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
| backlog | backlog/2, exit 0 | error/1, exit 2, VALIDATION | yes |
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
35 budgets: 22 pass, 0 fail, 13 open miss, 0 pending.
An open miss is a budget the product has never met. It is reported with its number and does not fail a build for standing still; a regression against a budget that was met does.

| Budget | Observed | Limit | Unit | Status | Note |
|---|---|---|---|---|---|
| cold start: the store layer loaded, above the runner's own node floor | 169.5 | 213 | ms | PASS | runner node floor measured in this job at 44.1 ms median |
| identity median at 100 items, above the node floor | 127.7 | 240.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 100 items, above the node floor | 136.6 | 232.3 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 100 items, above the node floor | 148.2 | 268.8 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 100 items, above the node floor | 160.2 | 255.2 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 100 items, above the node floor | 177.6 | 229.6 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 1000 items, above the node floor | 106.2 | 106.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 1000 items, above the node floor | 136.2 | 115.2 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 1000 items, above the node floor | 127.2 | 121 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 1000 items, above the node floor | 170.7 | 156.3 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 1000 items, above the node floor | 190.6 | 162.9 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 10000 items, above the node floor | 150.6 | 278.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 10000 items, above the node floor | 172.7 | 438.9 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 10000 items, above the node floor | 184.1 | 311.7 | ms | PASS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 10000 items, above the node floor | 259.6 | 232.2 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 10000 items, above the node floor | 299.8 | 267.8 | ms | OPEN MISS | n=30, 31 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| identity median at 50000 items, above the node floor | 118.1 | 369.8 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| get median at 50000 items, above the node floor | 352.3 | 882.1 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| list median at 50000 items, above the node floor | 345.5 | 549.9 | ms | PASS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| create median at 50000 items, above the node floor | 651 | 584.4 | ms | OPEN MISS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| transition median at 50000 items, above the node floor | 786.6 | 723.3 | ms | OPEN MISS | n=20, 21 store operations; not build-blocking: the limits below were derived on one machine and have never been measured on a CI runner, so a failure there would be evidence about the runner rather than about the change. Run-to-run drift on the machine that produced them reaches 19.9% on its own. Arm this by re-deriving on the runner with --write-budgets, and only once the runner's own drift has been measured. |
| peak RSS, read at the largest scale (DR8, 100 MiB for a read at 50k) | 187216 | 102400 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a read at 50k peaks at about 182 MiB against DR8 100 MiB, measured twice |
| peak RSS, mutation at the largest scale (DR8, 120 MiB for a mutation at 50k) | 227264 | 122880 | KiB | OPEN MISS | open finding, not build-blocking: the landed store has never met this: a mutation at 50k peaks at about 212 MiB against DR8 120 MiB, measured twice |
| first index build at the largest scale (DR8, 6 s for 50k items and 500k events) | 14032 | 6000 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 11.1 s against DR8 6 s, and the figure is a wall time that a different runner would move on its own |
| re-index after a hand edit of the largest shard (DR8, 50 ms after a hand edit of the largest shard) | 393.3 | 50 | ms | OPEN MISS | open finding, not build-blocking: the landed store has never met this: 257 ms against DR8 50 ms, and the figure is a wall time that a different runner would move on its own |
| index size as a multiple of the text it indexes (DR8, index at most 1.0x the text size) | 2.06 | 1 | x | OPEN MISS | 238637056 bytes of index over 115635217 bytes of records and events; open finding, not build-blocking: the landed index stores each record's and each event's source text, which the DR2 spike that measured 0.7x did not; the store owner has to decide whether the budget or the index changes |
| runtime dependencies (DR7, zero runtime dependencies) | 0 | 0 | packages | PASS |  |
| install size, unpacked (DR8, 1.5 MB unpacked) | 284749 | 1572864 | bytes | PASS | the packed tarball: the bundle, the schemas and the three licence files |
| bundle (DR8, 500 KB bundle) | 208691 | 512000 | bytes | PASS |  |
| A1 write durability, worst of the parallel rounds (axis A1) | 1 | 1 | ratio | PASS | 5: 1, 24: 1, 60: 1, 200: 1 |
| A1 writers that crashed rather than reporting a refusal (axis A1) | 0 | 0 | writers | PASS |  |
| A5 silent drops (axis A5) | 0 | 0 | cases | PASS |  |
| A5 whole-store refusals (axis A5) | 0 | 0 | cases | PASS |  |
| A5 crashes (axis A5) | 0 | 0 | cases | PASS |  |
| output size per command, bytes enforced and tokens advisory (interface A.3) | 0 | 0 | artefacts over budget | PASS | 12 artefacts measured |
