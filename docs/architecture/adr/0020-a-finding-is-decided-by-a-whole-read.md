# ADR-0020: A finding is decided only by a read of the whole file, and `doctor` re-derives the index

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** D1, that the files are the authority and the index is a cache, and its obligations 3 and 4, that load-time validation reports every violation and that a duplicated id across files is one of them
**Departs from:** ADR-0002's tail rule, under which the tail re-index could record a clash; and ADR-0004's recovery from an index that disagrees with the files, which was to delete `.index/` by hand

## Context

Two ordinary commands at once locked a workspace with nothing wrong in its files.

    one process:  treadle set <id> <field>=<value>   in a loop
    another:      treadle show <id>                  in a loop

The reader refreshed the index beside the writer.
It read the event file's fingerprint before the writer had indexed its append, saw the file had grown, checked that the old prefix was unchanged, and scanned the tail from the older size.
By then the writer had indexed those same lines under its lock.
Every line the reader inserted collided on the events table's primary key, and the code on that path recorded each collision as it records a duplicate across two month files: one `S14` finding per line, under the file's new fingerprint.

`S14` hides content, so `readWorkspace` refuses every command over the store at exit 7, and the fingerprint matched from then on, so no refresh ever re-read the file.
Measured against `9888781` with 200 iterations a side, the workspace was locked after the 17th write: 183 of 200 sets and 182 of 200 shows exited 7, and `doctor` reported one `S14` at line 19 of a log that carried the id once.
The only way back was deleting `.work/.index/` by hand, which no refusal named, and which also deletes the transaction journal ADR-0004 keeps there.

No relations were involved.
Two agents working one board is the product's primary use.

The race is one defect, and it has a fix: the append checks its base inside the index transaction and hands the file back for a whole pass when another process has indexed past it.
The question this record answers is the class behind it.
Should a finding recorded by a read be able to lock the workspace at all?

## Decision

### A finding is a verdict on the files, and it is cached like every other row

The index holds a finding under the fingerprint of the file it was derived from, and it stays there until that file's bytes move.
That is right, and it is not the defect.

A finding is not a different kind of thing from an item row.
Both are what parsing the file's bytes produced, both are served while the fingerprint holds, and both are wrong in exactly the same way if the bytes they were derived from are not the bytes the fingerprint names.
Of the two, the stale item row is the worse failure: it answers with exit 0 and a wrong count, where the stale finding at least refuses.
So the invariant the index lives by is not "a finding must be re-established before it refuses".
It is that every row written into the index, findings included, is a function of the bytes its fingerprint covers and of nothing else.
The race broke that invariant, because the append pass is a function of the bytes and of a base it assumed, and the base moved.

Re-checking a finding against the files at refusal time was considered and rejected.
It checks the refusal path and leaves the answer path unchecked, so the same rows would be trusted by `backlog` and distrusted by the refusal one command later.
It puts a whole re-parse on every command in a store that really is corrupt, which is the one state where `doctor` is the command that should pay.
And the check it would perform is the whole pass, which already exists as the authority; the fix is to make sure nothing but that pass decides.

### The append pass may add rows and never decide a clash

An append is a partial read of a file.
What its lines clash against may be the file's own earlier lines under another process's fingerprint, and the append cannot tell that from a repeated id.
Only the pass that read the whole file, dropped the file's rows and inserted every line in order can say that two lines in the store share an id.

So `replaceEventFile` with `append` set does two checks inside its `begin immediate` and hands the file back on either:

- the base the tail was scanned from is not the size the index now holds for the file, and
- any line in the tail fails the primary key.

Handing back rolls the transaction back with nothing written and returns `wholePass`, and `#indexEventFile` re-indexes the file with no previous fingerprint, which is the whole pass.
A repeat the tail really carries is then found by that pass, at its line, against the file that holds the first copy, exactly as it is found today when the file is read cold.
The guard is corrected, not weakened: `test/store/event-log-integrity.test.ts` holds both hand-backs by construction and the genuine repeat beside them, and `test/cli/index-append-race.test.ts` runs the two loops as real processes through the entry point.

The whole pass is also the only pass that runs `#invalidateAgainst`, so a clash an append introduces now re-decides the other file's findings on the next pass, which the append path skipped.

### `doctor` answers from the files, never from what the index held

Even with the race closed, an index can disagree with the files: a file restored with its old mtime and size, a crash that ADR-0004's journal replay does not cover, a bug not yet found.
Every integrity refusal prints one fix line, `treadle doctor`, so that command has to be the way back.

`doctor` opens the store with `rederive`, which forgets every fingerprint and the hierarchy verdict in one transaction and keeps every row.
The refresh that follows re-reads every file whole: a record file is diffed against its rows and rewrites only what moved, an event file is dropped and reloaded inside its own transaction, and a file that has gone has its rows dropped because the forgotten names are carried into the pass.
A finding a partial read once recorded is gone after the first re-read, and a finding the files support is recorded again at its line.

Deleting `index.sqlite` from inside the tool was rejected for two reasons ADR-0004 already states.
The journal lives beside it under `.index/`, and a process that dies mid-transaction loses its replay if the directory goes.
And a command running beside `doctor` holds the database open; pulled from under it, that command answers from an empty table with exit 0.
Forgetting fingerprints leaves the rows in place until each file's own re-read replaces them, so a concurrent command keeps answering from whole files throughout.

A `--rebuild` flag on `doctor` was rejected because the recovery has to be the step the refusal already prints.
A user at exit 7 should not need to know a flag exists, and a flag is a surface with a matrix, help text and a schema behind it.

### `S14` stays a refusal

`history`, `explain` and `doctor`'s `H20` audit answer from the log.
A log holding two events under one id has one of them unserved, and every answer that reads it is then wrong in a way the caller cannot see.
`readWorkspace` refuses uniformly for every finding that hides content, and the closed set of findings served anyway stays `H16` and `S12`.
The cost of that uniformity was never the refusal; it was a refusal recorded by a read that had not earned it, and that is what this record closes.

## Alternatives considered

### Re-establish a finding against the files before it refuses

Rejected above.
It checks the wrong path, and a cache that can hold a verdict the files do not support can hold an item row they do not support either.

### Keep findings out of the index and recompute them per command

A finding comes out of the parse that produces the rows, so recomputing findings is re-parsing every file, and the 7.3 ms read at 50,000 items exists because no command re-parses anything.

### Make `S14` a finding the store serves anyway

It would make `history` and `explain` answer from a log the store knows is ambiguous, and it changes a contract `docs/VERIFICATION.md` records as proven.
That is a product decision, and nothing in this incident argues for it: the refusal was right about what it saw and wrong about how it came to see it.

### Re-derive only the files that carry a finding

Cheaper on a clean store, and it misses the case where the index holds rows for bytes a file no longer has, which is the exit 0 failure.
`doctor` is the audit command and the one that should read the files, so the cost lands where it belongs.

## Consequences

- `ReindexOutcome.wholePass` replaces the handed-back patch's `stale`: an append is handed back for a moved base or a clashing line, and nothing was written either way.
- `ShardedStoreOptions.rederive` and `IndexCache.forgetFingerprints()` exist for one caller, `doctor`, through `openWorkspace` in `src/cli/main.ts`.
- An append that meets a repeat the tail really carries costs one whole pass over that month's log, once, and the next append is a tail again.
- `doctor` re-reads every file whole on every run, and that is its cost.
  On the bench corpus at 50,000 items, 25 MiB of shards and 87 MiB of log over 500,241 event lines, index warm, `doctor` took 6.4 s and 6.2 s on `9888781` and 23.9 s and 31.8 s here, on a shared machine at a 1-minute load of 24 to 40.
  The audit itself is unchanged; the difference is the whole re-read, most of it the event files dropped and reloaded.
  No benchmark axis calls `doctor`, so no budget moves, and no other command pays anything.
- A workspace locked by an index that disagrees with its files is recovered by running the fix line the refusal prints, and `test/cli/doctor-recovery.test.ts` follows only that line.

## Departures from the design record

DR2 says an event file that only grew has its old prefix hashed and only the tail is parsed when the hashes match.
The tail is still parsed on its own, and when what it finds disagrees with the index the whole file is, because the tail cannot decide a clash.
DR4 lists the index as deletable at any moment and names no other recovery; the tool now carries its own, and the manual deletion is what it protects the journal from.

## What would reopen this

A workspace at a scale where `doctor`'s re-read is its wall time and a caller runs it on a schedule, which would be a measurement against a real backlog.
A second command that needs the re-derivation, at which point it becomes a store operation rather than an open option.
