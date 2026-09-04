# ADR-0002: The workspace is month-sharded files with a derived index that is never authoritative

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** DR2 of the system design record, under decision D1

## Context

The committed, human-readable files are the source of truth, and the index is a cache whose deletion is always safe.
That is settled and this record does not reopen it.
What it settles is the shape of those files, because the shape decides two numbers that everything else pays.

The first is the freshness check.
Nothing may be answered from the index unless the store has established that no file changed since the row was written, and the cheapest true test is a stat per file.
The design measured 296 to 340 ms for that check across 50,000 per-item files on APFS, against 0.27 ms across 24 month shards.
The filesystem sets that price, not the runtime: the same measurement in Go and on Node's thread pool lands in the same range.

The second is git.
`git add` of a fresh 50,000-item repository took 45 seconds with one file per item and 822 ms with shards, and the `.git` directory was 201 MB against 8.4 MB.

## Decision

The workspace is a directory of record files sharded by the calendar month of an item's `filed_at`, plus an append-only monthly event log, plus a gitignored SQLite index built with `node:sqlite`.

```text
<workspace>/
  workspace.md            the workspace record: its id and its name
  items/2026-09.md        every work item whose filed_at is in that month
  events/2026-09.jsonl    append-only, one event per line, merge=union
  .gitattributes          events/*.jsonl merge=union
  .gitignore              .index/ and .lock
  .index/index.sqlite     derived; deletable at any moment
  .index/txn/<txn>.json   the transaction journal (ADR-0004)
  .lock                   present only while a mutation runs
```

`filed_at` is immutable, so a record never moves between files.
The store is resolved by walking up from the working directory to the nearest `workspace.md` (`resolveWorkspace`), and is never created except by an explicit request (`createWorkspace`).

The index holds a `files(path, size, mtime, hash, lines)` fingerprint table plus one table each for items, events and findings.
Before any query, every store file is stat-ed; a file whose size or mtime moved is re-read and its rows are replaced in one transaction, and a file that has gone has its rows deleted.
An event file that only grew has the hash of its old prefix compared against the new file's first bytes, and only the tail is parsed when they match.

The index caches each record's canonical source rather than its columns, so `get` returns a whole item without reopening the shard, and every answer is still a parse of bytes that came off disk.

### Deleting the index is harmless, and that is a test

`test/store/index-cache.test.ts` deletes the whole `.index` directory ten times in a loop and asserts the full read set (`list`, `events`, `findings`) is byte-identical each time, then asserts the database file exists again afterwards.
A database that is not on disk has no fingerprints, so every file reads as stale and the next refresh rebuilds it before any query runs.
The same suite deletes the index between a write and the read that follows it, and asserts the write is still served.

## Alternatives considered

### One file per item

The most merge-friendly layout and the easiest to hand-edit, and those are exactly the properties the shard keeps at a 24-file cost.
It loses on the freshness check (296 to 340 ms at 50,000 items, against a 150 ms budget for the whole command) and on `git add` (45 seconds).

### One file for everything

Freshness is one stat, but every mutation rewrites the whole file (44.6 MB and 29.56 ms at 50,000 items), and one 44 MB text file is the entire review surface of every pull request.

### Sharding by state or by sprint

Records would move between files on every transition, which turns a one-line diff into a delete and an insert across two files.
That defeats the merge property the whole decision rests on.

## Ceilings, and the number behind each

Threat-model finding F8 is that the design set performance budgets and no caps, so a hostile committed file is parsed into memory with nothing to stop it.
A budget says what should be fast; a ceiling says what is refused.
Every ceiling is checked against the size the stat already returned, before the file is read, because a limit that fires after the read is not a limit.

| Ceiling | Value | Where the number comes from |
|---|---|---|
| `MAX_FILE_BYTES` | 8 MiB | DR2's largest measured shard is 1,688 KB; its own reopen trigger is a month past 5,000 items, which it puts at 4 MB. Twice the trigger. |
| `MAX_RECORDS_PER_FILE` | 20,000 | Four times that same 5,000-item reopen trigger. |
| `MAX_FIELD_VALUE_BYTES` | 8 KiB | The longest single-line field in the dictionary is `hold_reason` at 500 characters. Sixteen times it. |
| `MAX_SECTION_BYTES` | 128 KiB | The largest multi-line field is `description` at 100,000 characters. |
| `MAX_FIELDS_PER_RECORD` | 256 | The dictionary names 21 common fields and at most 6 type fields. |
| `MAX_SECTIONS_PER_RECORD` | 64 | The dictionary names six sections across every type. |
| `MAX_EVENT_FILE_BYTES` | 256 MiB | DR2's whole 50,000-item corpus is 500,000 events in 117.3 MB across 24 files. |
| `MAX_EVENTS_PER_FILE` | 2,000,000 | Four times that whole-corpus event count, in a single month. |
| `MAX_EVENT_LINE_BYTES` | 1 MiB | One event carries a before and an after snapshot; `description` alone caps at 100,000 characters. |
| `MAX_JSON_DEPTH` | 32 | An event's `before`, `after` and `guards` are the store's own shapes, two levels deep. |

Crossing one is an `S4`, `S5`, `S6` or `S7` finding that names the file and both numbers, and the file stops being served while every other file keeps serving.
The oversized-file tests build their files with `truncate`, which is both instant and the exact shape of the attack: a repository states a size, and the tool must refuse before it reads.

## Consequences

**Positive**

- The freshness check is 0.27 ms at 24 shards, so every command can afford to run it and no answer ever comes from a stale row.
- A one-record change is a one-record diff: two branches editing different records in one shard merge clean, and the same two editing the same record conflict only on adjacent lines.
- A crashed or deleted index costs a rebuild and nothing else.

**Negative**

- A mutation rewrites its whole shard. At the measured 1.7 MB worst case that is 9.2 ms, and the text diff is still the record's own lines.
- A busy month is a large file to open in an editor. At 2,084 records the shard is 1.7 MB, and a person edits it by search rather than by scrolling.
- The first command on a fresh clone at 50,000 items pays a full index build.

**Neutral**

- The index is roughly 0.7x the size of the text it derives from.

## Departures from the design record

- **Ceilings are checked before the read, not inside the parser.** DR2 and F8 said what to cap and not where. The stat that establishes freshness already carries the size, so the check is free there and the hostile file is never read.
- **The index caches each record's rendered source, not only its indexed columns.** DR2 lists the columns and reports a `get by id` at 0.01 ms without saying what the row returns. Storing the source keeps `get` a single index lookup while keeping the parse honest, and it is what DR2's own "index is 0.7x the text size" measurement implies.
- **`sprints.md`, `impediments.md` and `ceremonies/` are not written.** Those entities have no domain types yet, so a store for them would be an abstraction with no caller. The one parser and the one layout already cover them the day they exist.

## What would reopen this

- A workspace filing more than about 5,000 items in one month, which is a half-month shard key and a migration.
- A freshness check measured above 5 ms for a real workspace's file count, which means the sharding drifted toward per-item.
