# ADR-0014: The view every command reads is a projection, and one record is read on demand

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** DR8's peak-memory budgets, over the read the product actually performs

## Context

Every command starts with `readWorkspace` in `src/application/services/context.ts`, because every answer depends on the whole set: a backlog counts it, a gate reads an item's children from it, a new id is chosen against it.
Until this record that read was `store.list()` with no query, which decoded every record in the store into a `WorkItem`, indexed the result by id and built the hierarchy graph off it.
`treadle show` printed 532 bytes about one item by first materialising 50,000 of them.

The measurement rig weighed DR8's 100 MiB read budget over `store.list` bounded at 50 rows, which no command performs, and reported 99.2 MiB.
Weighed over `readWorkspace` the same budget read 418,336 KiB, 4.06x over, and the read took 1.2 s at 50,000 items where `get` took 7 ms.
`docs/BENCHMARKS.md` recorded that as the wall the tool meets first and left it for a change to what the command layer promises the domain.
This is that change.

An allocation profile of the read at 50,021 items, taken with the inspector's sampling heap profiler with collected objects included, put the cost in two places.
The read allocated 1,072 MiB, of which `decodeItem` was 608: `validateWorkItem` allocated a `Set` of the type's permitted fields and two `Object.entries` arrays per record, 340 MiB, and `parseSegment` allocated a `Line` object with two substrings per line, 249 MiB.
What the view then retained was 103 MiB of heap: 40 MiB of dictionary-mode property stores, because the decoder built each item on `Object.create(null)`, 31 MiB of record source strings pinned by the sliced substrings the items held, and 15 MiB of short strings, one copy of `task` and `ready` per item.
Peak RSS was the runtime's 96 MiB floor plus a 300 MiB heap that V8 let grow under that churn while 103 MiB of it was live.

## Decision

### The view holds the fields a scan reads, and nothing else

`WorkspaceView.items` and `byId` hold `WorkItemSummary`, which `src/domain/types.ts` defines as the fourteen `WorkItem` fields a scan over the whole set reads: what `backlog` filters and sorts on, what `status` counts, what a gate reads of a child, what `next` scores.
`SUMMARY_FIELDS` in the same file is the list, and every one is a `WorkItem` field, so a whole item is a summary wherever one is asked for and a function written over the summary takes either.

The store port gains `summaries(query)`, the same items as `list` in the same order, as those fields.
The sharded store serves it from the index's columns alone, streamed with `iterate()` rather than materialised with `all()`, with `resolution`, `due` and `severity` added to the `items` table so that no summary field is read from the record text; `INDEX_FORMAT` moved from `3` to `4` for that.
The overlay projects its pending writes through `summaryOf` and merges them the way `list` does.
`test/store/conformance.ts` holds both implementations to the same property: `summaries()` deep-equals `list()` projected onto `SUMMARY_FIELDS`, with an absent field absent rather than null.

A summary is a value the index cached, and the index is a cache and never an authority.
That was already the rule for `get`, which serves a record's text from `items.source` (ADR-0002), and the freshness check that protects `get` protects this the same way: a shard whose stat moved is re-read before either is served.

### The whole record of the one item a command acts on is read on demand

`wholeItem(store, view, id)` in `context.ts` is one index lookup after the view has established that the id names a record the store serves, and it is what `show`, `set`, `mark`, `evidence`, `transition` and `explain` call.
The six commands that act on one record read one record.
Absent means the record left the store between the two reads, which the caller treats exactly as an id it never held.

`doctor` is the one command that decodes the whole store, because its audit reads every field of every record against its events.
It reads the identity and `list()` itself now, and the `partial` option `readWorkspace` carried for it alone is gone.

### The shard a write touches keeps its parse

Profiling the mutation the rig prices, a create after a create into the largest shard, found the shard parsed twice: once by the warm refresh before the lock and once by `#readShard` under it, 42.5 and 24.9 MiB of the 76 MiB one create allocated.
`apply` names the shards its transaction writes and both refreshes keep those parses, and any refresh keeps the parse of the last record file it read, one file, because the shard a write touches is usually the shard the previous write changed.
`#readShard` proves the bytes have not moved by stat before reusing one, which is the freshness rule everywhere else in the store.

### The decoder allocates for the record, not for the dictionary

The permitted-field sets are built once per type, `isKnownField` is a set lookup, `validateWorkItem` walks keys rather than entry pairs, the decoder builds each item as an object literal so it keeps fast properties, `parseRecordSource` hands its input over as the record's source instead of re-joining the lines, and `summaries()` interns the bounded columns so 50,000 rows carry one copy of `task`.
None of this changes a byte of output.
`test/render/conformance.test.ts` and the CLI suites hold that.

## Alternatives considered

### Hold every item, but hold it leaner

The first pass did this alone and it is kept: allocation fell from 1,072 MiB to 494 and peak RSS from 406 MiB to 298 at 50,021 items, with the view still holding 92 MiB of decoded records.
It could not go further, because a whole item holds its description and 50,000 descriptions are the record text.
Copying every string an item keeps would have released the pinned sources at the price of the copies, a saving of about 10 MiB, and was not done.

### Scan in SQL

`backlog` could filter and sort in the index and `status` could count there, and the view would then hold nothing for the commands that scan.
That is the next step if 100 MiB from the bundle has to be met, and it is not taken here because it moves the domain's ordering and filtering rules into query text, which is a second place for each of them to be right.

### Raise the budget to the number

Refused, and DR8's two figures are unchanged in `bench/budgets.json`.
A budget written before the operation it names existed is allowed to be wrong, but only after the product is as light as it reasonably can be, and the SQL scan above says it is not there yet.

## Consequences

Every figure is a cold process per sample, seven samples, both trees interleaved per sample over clones of the same corpora, at 1-minute loads of 4.54 to 3.47, with `process.resourceUsage().maxRSS` read by the child.
The transcripts are under `.fm-evidence/` on the branch that landed this.

**Positive**

- The read every command performs, in-process median and peak RSS, before and after: 17.0 ms and 104,240 KiB to 12.0 ms and 101,904 KiB at 100 items; 49.9 ms and 112,576 KiB to 17.4 ms and 103,584 KiB at 1,000; 287.6 ms and 201,104 KiB to 80.4 ms and 117,584 KiB at 10,000; 1,268.7 ms and 418,592 KiB to 338.8 ms and 166,944 KiB at 50,000.
- `get` did not move: 7.2, 7.7, 13.2 and 7.7 ms before against 7.2, 7.7, 13.6 and 7.4 ms after at the four scales, and the 10,000 row is the re-index of the shard the previous sample's create changed on both trees.
- The mutation the rig prices at 50,000 items: `create` 175.1 ms and 162,560 KiB to 119.5 ms and 147,088 KiB, `transition` 177.9 ms and 163,904 KiB to 133.1 ms and 146,960 KiB.
- At the command surface on the 50,000-item corpus, three samples each: `treadle show` 1,434.6 ms and 486,144 KiB from source to 531.0 ms and 202,320 KiB, and through the bundle 1,344.7 ms and 387,424 KiB to 421.8 ms and 129,680 KiB; `backlog --limit 9`, `next --limit 3`, `status` and `history` land within 3 percent of `show` on both trees; `file` 1,560.0 ms and 432,576 KiB from source to 618.3 ms and 203,344 KiB, and through the bundle 1,473.7 ms and 405,648 KiB to 562.1 ms and 168,112 KiB.
- The allocation of the read fell from 1,072 MiB to 119 MiB, and what the view retains from 103 MiB to 36.3 MiB: 13.4 MiB of strings, 8.5 of arrays and 6.5 of objects over 50,021 items.

**Negative**

- Six commands make two reads of the store where they made one, and a record can leave between them; the second read's absence is treated as an unknown id, which is what the caller would have seen a moment earlier.
- The read budget is still missed. 166,944 KiB against 102,400 from source is 1.63x, and 129,680 to 131,168 KiB through the bundle is 1.27x, down from 4.09x and 3.78x. The runtime's own floor from source is 95.9 MiB with the store adapter loaded, so no read that retains anything meets 100 MiB on the rig's children; the figure that can meet it is the bundle's, and 30 MiB of view and heap slack stand between it and the budget.
- The mutation budget is still missed on the rig at 1.20x and at the command surface through the bundle at 1.37x, and the mechanism is now the shard parse: `parseFile` allocates about 25 bytes for every byte of a 1.1 MB shard, and the next command after any write pays it once to re-index that shard.
- The index carries three more columns, and an index an older build wrote is dropped and re-derived on the first open.
- `-vvv` logs a `read` line per summary on a scan and the whole record's fields on `get`, so the description a scan never reads no longer appears in a scan's log; `test/security/f10-verbose-content.test.ts` asserts the field is named and sized where it is read, which is `show`.

**Neutral**

- `WorkspaceView`'s contract is unchanged: one read of the store, refused whole when a finding hides a record, and every derived fact off that read.

## Departures from the design record

- **DR8 priced a read the design never made.** Its 100 MiB budget predates `readWorkspace`, and the rig met it with a bounded `list` for two runs. The budget is kept and weighed over the worst of `identity`, `get`, `list` and `workspace` at the largest scale, and `bench/gate.ts` reports the row `NOT MEASURED` rather than a figure if any of the four is missing, so it cannot pass over `list` again.
- **DR6's store seam gains a method.** `summaries` sits beside `list` in the interface ADR-0006 quotes, held to the same conformance suite, and the overlay's recorded cost of merging the whole base list on every read applies to it as it does to `list`.

## What would reopen this

- A caller for whom 130 MiB through the bundle at 50,000 items is the difference, which is the SQL scan above.
- A summary field a command reads that the index does not carry, which is one more column and one more `INDEX_FORMAT`, never a read from the record text.
- The shard parse's 25 bytes per byte, which is a line scanner over offsets rather than `Line` objects and belongs with the store's own ceilings.
