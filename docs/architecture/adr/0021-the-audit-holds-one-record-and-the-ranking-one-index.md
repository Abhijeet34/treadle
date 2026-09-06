# ADR-0021: The audit holds one record and one event at a time, and the ranking reads one index

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** DR8's peak-memory budget over the two commands the corpus could not price until it carried a relation graph

## Context

The benchmark corpus carried no relation edge, no sprint record and no impediment until 2026-09-06.
The run that added them, 5,000 relations, 24 sprints and 489 impediments over 50,000 items, also added `workspace`, `board`, `next` and `doctor` to the operations the read budget is weighed over, and two figures appeared that no earlier corpus could have produced.
`doctor` peaked at 1,043,456 KiB against a 102,400 KiB budget, 10.2x over, and `next` ranked in 2,002.3 ms.
Neither was a regression: `doctor` had never been measured, and `next` had never ranked over a graph.

ADR-0014 is the precedent.
Its profile found `treadle show` printing 532 bytes about one item by first materialising 50,000, and the fix was to hold the fourteen fields a scan reads rather than whole records.
The shape here is the same one twice over.

### Where the memory went

The instrument is the inspector's sampling heap profiler, `HeapProfiler.startSampling` at a 16 KiB interval with objects collected by either garbage collector included, around the service call alone in one process over the 50,021-item corpus with the index warm.

`doctor` allocated 1,441.8 MiB.
`store.events()` was 865.3 MiB of it: `listEvents` read 500,042 rows with `.all()`, 384.2 MiB of row objects, and mapped each through `eventFrom`, 431.1 MiB of decoded events and their parsed `rest`.
`store.list()` was 484.5 MiB: `parseSegment` 205.2, `decodeItem` 117.0, `validateWorkItem` 51.7 and `buildRecord` 49.3, which is the whole-record decode ADR-0014 measured and left for the one command that needs it.
The audit itself was 88.2 MiB, the map of events by entity and the finding rows.
So 1,350 MiB of the 1,442 was two arrays held so that each element could be looked at once, and the peak was those arrays plus the heap V8 let grow while it built them.

### Where the time went

The instrument is the inspector's CPU profiler at a 200 microsecond sampling interval, around the same call.

`next` took 1,885.2 ms, of which `rank` was 1,250.0.
`activeBlockers` was 644.0 ms and `scoreOf` 596.5, and inside each the cost was one callback: the filter in `blockersOf` at 295.9 ms self and the filter in `blockedByThis` at 268.3.
Both walk the whole relation list for one item, which is the right cost for the one item a command acts on, and `rank` called each once per ready item: 7,122 ready items over 5,000 edges, twice.
`activeBlockerIndex` already existed for `board`, which had met the same shape.
The remaining 187.6 ms was `readWorkspace`, and 112.9 of that was `relationGraphFrom`: it refused a repeated edge by scanning every edge it had already accepted, 5,000 scans over a list growing to 5,000.
The ranking allocated nothing worth naming, 142.3 MiB for the whole call of which 98.7 was the summaries read, so this was time and not memory.

## Decision

### The store seam gains two reads without the array

`eachItem(query, visit)` and `eachEvent(query, visit)` sit beside `list` and `events` in `src/application/ports/store.ts`.
Each visits what its array form returns, in that order, and returns the count; the read is refused where the array form refuses it, and an item visited before the refusal is the caller's to discard.
The sharded store serves both from the index's own row iterator, `listItems` for records and a new `iterateEvents` for the log, and `list` and `events` are now those two with an array.
The overlay serves both off the merged list it already holds, which is the cost ADR-0006 records for it and does not change here.
`test/store/conformance.ts` holds both implementations to the property: the visitor sees exactly the array, in its order, with the same filters and limit.

### The audit is a fold over two streams

`WorkspaceAudit` in `doctor.ts` is fed every record and then every event, and read once both passes are over.
At `record` it decides the two findings that need more of the record than a summary carries, `H18` on the description's length and `H21` on the evidence list, keeps `summaryOf(item)` and lets the record go.
At `event` it folds the last logged value of each marked field into the item's entry for `H20`, decides `H23` against the summary's `filed_at` and `H19` against its assignee, and keeps nothing of the event.
`findings()` then walks the entries in record order and emits each item's findings in the order `auditItem` always emitted them, `H26`, `H18`, `H20`, the log's own in log order, `H21`, `H24`, `H27`, and the cycle check last.
`auditItem` is the same fold over one record and its own slice of the log, which is what `explain` reads, and `test/services/doctor-scale.test.ts` holds the two equal.

### The ranking reads both directions of the graph off one index

`rank` builds `activeBlockerIndex` and its mirror `blockedByThisIndex` once and reads each item's blockers and dependents from them.
`scoreOf` keeps its signature for the one-item callers and hands `d` to an inner `scored`, so the per-item form and the ranking cannot compute the component two ways.
`relationGraphFrom` finds a repeated edge by key rather than by scanning the edges accepted so far.
`test/services/next-scale.test.ts` counts passes over the relation list the way the doctor test counts passes over the log, and holds the indexed ranking equal to the per-item one.

### The gate prices both against the read they perform

Two enforced rows in `bench/budgets.json`: `doctor`'s peak RSS over `workspace`'s at the largest scale, limit 3, and `next`'s program cost over `workspace`'s, limit 2.
A ratio of two figures taken in one job on one runner transfers between machines in a way the timing rows cannot, because both carry the same runtime floor and the same load, and that is why these two are armed where every millisecond count stays `enforced: false`.
Both read 6.2x and 3.8x on the shape that was replaced and 2.0x and 1.1x after it.

## Alternatives considered

### Ask the log per item

`store.events({ entity })` once per record holds ten events at a time and adds nothing to the seam.
It is 50,000 index seeks where one range scan does the same work, the N+1 shape, and `doctor` already runs for seconds at this scale.
Refused.

### Carry the description's length and the evidence count in the index

Then `doctor` reads summaries alone and never decodes a record, which is ADR-0014's own move.
A summary is a `Pick` of `WorkItem` fields and the description's length is not one, so this would be a third kind of column, cached from the record text and answering one audit rule.
The stream costs one method on the seam and answers any rule that needs the whole record.
Refused for now; it is the move if the decode churn below has to go.

### Raise the read budget to the number

Refused, for ADR-0014's reason: a budget written before the operation it names existed is allowed to be wrong, but only once the product is as light as it reasonably can be, and the next step below says it is not there yet.

## Consequences

Every figure below is a cold process per sample, seven samples, both trees interleaved on every sample over copies of the same corpora, at 1-minute loads of 4.34 at the start and 4.54 at the end, with `process.resourceUsage().maxRSS` and `performance.now()` read by the child around the operation.
The transcripts are under `.fm-evidence/` on the branch that landed this.

**Positive**

- `doctor` at 50,000 items: 3,778.4 ms and 1,031,776 KiB to 3,416.8 ms and 335,584 KiB, 3.1x less memory for the same 11,908 findings.
- `doctor` at 10,000 items: 703.9 ms and 383,120 KiB to 689.4 ms and 157,584 KiB; at 1,000, 92.0 ms and 142,896 KiB to 93.3 ms and 114,096 KiB.
- `next` at 50,000 items: 2,006.1 ms to 396.4 ms, with peak RSS 170,032 to 171,392 KiB; at 10,000, 154.6 ms to 94.2 ms.
- The read every command performs got the graph build back: `workspace` at 50,000 is 516.5 ms to 373.4 ms and 169,440 to 170,480 KiB, and `board` at 50,000 is 559.8 ms to 419.6 ms and 170,064 to 175,584 KiB.
- Every command's output over the 50,000-item corpus is byte-identical to `main`: `doctor` at 1,619,659 bytes and exit 7 on both trees, `next --limit 50` 4,395 bytes, `board --all` 3,966, `status` 638, `explain` 317, `show` 422 and `backlog --limit 20` 1,691.
- What ADR-0014 bought is not spent: `workspace` peak RSS is 104,208, 107,008, 121,600 and 170,480 KiB at the four scales against 103,616, 106,192, 120,304 and 169,440 before, and `get` is 7.4, 8.2, 7.6 and 7.4 ms against 7.8, 8.2, 8.7 and 7.4.

**Negative**

- The read budget is still missed, and `doctor` is still the worst member of the set it is weighed over: 334,688 KiB against 102,400 is 3.3x, down from 10.2x.
  What the audit retains is 49 MiB, the summaries and their findings, measured as heap in use after a forced collection.
  What stands between that and the peak is the heap V8 commits under the churn of decoding 50,000 records and 500,000 events, about 1.35 GB of transient allocation in 3.4 s: `heapTotal` reaches 190 MiB during the record pass and 223 during the event pass while 59 is live, and a 64 MB semi-space moves the peak by under 1 MiB, so it is not promotion.
  The mechanism is the one ADR-0014 named as the store's own ceiling, `parseFile` allocating about 25 bytes per byte of shard and `eventFrom` parsing every event's `rest`, and the step that closes it is a line scanner over offsets, not a change to this command.
- The seam has two more methods, and a third implementation would have to serve them; the conformance suite says how.
- `doctor` makes three reads of the store where it made three before, and the record stream and the event stream are two moments rather than one; a write between them is read-committed, which is what `history` and `explain` already are.

**Neutral**

- `auditItem`, `auditRelationsOf` and `auditImpediment` keep their signatures, and `explain` reads them as before.
- `scoreOf` keeps its signature, so the anti-ambiguity suite's per-item scores are unchanged.

## Departures from the design record

- **DR6's store seam gains two methods.** `eachItem` and `eachEvent` sit beside `list` and `events` in the interface ADR-0006 quotes, held to the same conformance suite; the overlay's recorded cost of merging the whole base list applies to them as it does to `list`.
- **DR8's read budget is now weighed over a command it never named, and a second row prices that command as a ratio.** DR8 gave `doctor` no budget; the rig gave it a peak-RSS figure on 2026-09-06 and this record gives it a limit that transfers, 3x the workspace read.

## What would reopen this

- A third audit rule that needs the whole record, which is a third field decided at `record` and nothing else.
- The read budget from source, which is the line scanner over offsets and belongs with the store's own ceilings.
- A corpus whose decode churn moves `doctor` past 3x the workspace read, which is the row firing and the ceiling above being the next step.
