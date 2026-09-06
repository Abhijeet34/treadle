# ADR-0006: The store seam ships two real implementations under one conformance suite

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** the store half of DR6 of the system design record

## Context

The standing rule in this project is that a seam with one implementation is not a seam, it is an interface waiting to be deleted.
DR6 names six of them and requires each to ship two real implementations for a product reason rather than a test-only one, with one shared suite running against both.

The store's second implementation has a product reason on day one.
`--dry-run` has to evaluate every guard and diff every entity without writing, and the way to do that without a second code path through the guards is a copy-on-write layer over the base store.
`--preview` is the cheaper question beside it, resolving the target and evaluating nothing, so it needs no store of its own.

## Decision

The seam lives in `src/application/ports/store.ts` and names no path, no lock and no file.

```ts
interface Store {
  identity(): Promise<StoreResult<StoreIdentity>>
  get(id: ItemId): Promise<StoreResult<WorkItem | undefined>>
  list(query?: ItemQuery): Promise<StoreResult<readonly WorkItem[]>>
  events(query?: EventQuery): Promise<StoreResult<readonly StoreEvent[]>>
  apply(transaction: StoreTransaction): Promise<StoreResult<Applied>>
  findings(): Promise<StoreResult<readonly Finding[]>>
  close(): Promise<void>
}
```

A refusal is a value, not an exception, the same contract the domain core uses.
`StoreErrorCode` is the domain's three codes plus `CONFLICT`, `SCHEMA_NEWER`, `SCHEMA_OLDER`, `LOCK_TIMEOUT` and `STORE_UNAVAILABLE`, so carrying a `DomainError` outward is total and invents no code.

Two implementations.

- **`ShardedStore`** is ADR-0002 and ADR-0004: month-sharded files, the SQLite index, the lock, the journal.
- **`OverlayStore`** wraps any base store and stages writes in memory. It takes no lock, touches no file, and merges its staged records over the base's on every read. A `--dry-run` reads its own writes back through it, which is how every guard downstream of a write sees the store the write would have made.

`test/store/conformance.ts` is parameterised by a factory and runs 12 tests against both: identity, compare-and-set in all three of its forms, versioning, all-or-nothing multi-write, list filters and limits, event queries by entity and time range, refusal of a record the grammar could not write back, refusal of an item the field dictionary refuses, and unknown-field carry-through.
The overlay's base in that suite is a real empty sharded store on a temporary directory, not a stub.

The overlay runs a write through the same encode, render, parse and decode the sharded store's write path runs, so a dry run can never approve a record the real store would refuse.
That is not decoration: writing the suite is what found that the sharded store was rendering an item the field dictionary rejects and only failing on the read back, and the fix moved validation into `encodeItem`, which both implementations share.

## Alternatives considered

### An in-memory store as the second implementation

Cheaper to write and worth nothing.
It would exist only to be tested against, which is the definition of the interface-with-one-implementation the rule forbids, and it would not have caught the validation gap above because it would not have gone through the format at all.

### `--dry-run` as a flag threaded through the sharded store

One code path with a boolean that skips the writes.
Every guard, every compare-and-set and every refusal would then have two behaviours depending on a flag, and the preview would be a claim about what would happen rather than a thing that happened to a store.

## Consequences

**Positive**

- The seam is proved rather than declared: the same 12 tests hold for a store made of files and a store made of a `Map`.
- `--dry-run` is a store, so the application layer above it needs no dry-run branch at all.
- A later store with a genuinely different shape has an acceptance test the day it starts.

**Negative**

- The overlay merges the base's whole item list on every `list`, so a preview at 50,000 items reads the base list rather than an index query. The upgrade path is to push the filter into the base call, which the interface already allows.

## The one asymmetry, stated rather than hidden

The sharded store carries a stored record's unknown H2 sections through a mutation by re-reading the record it is replacing.
The overlay cannot, because the seam's currency is `WorkItem`, and `WorkItem` has a place for an unknown field (`extra`) and no place for an unknown section.
A preview of a record carrying a section written by a newer version therefore shows the record's known content and not that section.

Unknown *fields* do survive the overlay: it carries them from the item it is layering over, which the conformance suite asserts for both implementations.

Closing the gap means giving `WorkItem` a carrier for unknown sections, which is a change to the domain model and belongs to the task that owns it.
Nothing on the write path loses a section, because every real write goes through the sharded store.

## Departures from the design record

- **The store serves work items and events, not every entity DR6 implies.** Sprints, impediments and ceremonies have no domain types yet. The one grammar and the one layout already cover them; a store method for them today would be an abstraction with no caller.
- **`findings()` is on the interface.** DR6 does not name it. D1 obligation 3 requires load-time validation to report every violation with the record and the rule, and the doctor that will consume it is a later task, so the seam has to carry the findings out today or they are computed and dropped.
- **The overlay's base in the conformance suite is an empty sharded store, not "an empty in-memory store".** DR6 names the latter. There is no in-memory store, and inventing one to be a base would be the test-only implementation the rule forbids.

## What would reopen this

- A second store with a genuinely different shape, such as a remote tracker. The conformance suite is its acceptance test, and the interface names no machine, which decision D2 requires.
