# ADR-0025: A referential rule inside the lock every write already holds, and the parent finding that was missing

**Status:** Accepted
**Date:** 2026-09-08
**Implements:** limit two of the platform-parity scout report, which reproduced three interleavings against `52616bc`
**Overtaken in part by:** [ADR-0029](0029-the-record-is-the-product-and-the-agile-surface-is-not.md) removes the closed-sprint referrer and `H26`, leaving `S17` with the parent and the relation edge

## Context

ADR-0024 refused a removal wherever another record would be left naming it, at the service layer, as `R6`.
That refusal is decided against `readWorkspace`, which runs before the store takes its lock.
A neighbour written between that read and the write is not in what `R6` read, and no read set closes the gap, because `StoreTransaction.reads` names records whose version moved and the neighbour here did not exist to have a version.
`src/application/services/removal.ts` said exactly that, and named the store as the layer that could hold the guarantee.

Three interleavings were reproduced, two store instances on one workspace with the first held at its `apply` until the second had landed.

```text
A  remove csv-export decided; relation add webhook-retry blocks csv-export lands; remove ok
   -> the edge is stored and names no record. doctor: H24.
B  remove auth-refresh decided; set onboard-copy parent_id=auth-refresh lands; remove ok
   -> onboard-copy carries parent_id auth-refresh and no such record exists. doctor: clean, exit 0.
C  set onboard-copy parent_id=auth-refresh decided; remove auth-refresh lands; set ok
   -> the same dangling parent. doctor: clean, exit 0.
```

B and C are the worse two.
`set parent_id=` and `file --parent` carry no read set at all - `parentRefusal` decides against the pre-lock view - so the reverse order was open for a parent where it was closed for a relation target, whose write does name it in `reads`.
And nothing reported the result: `doctor` had `H24` for a relation target and `H26` for a `sprint_id`, and no finding at all for a parent.
A state the store's own health check passes over is worse than the dangling reference, because every read then answers from it as though the parent were there.

## Decision

### The rule runs inside `#applyUnderLock`, not around it

`S17` is checked after the read set and before any shard is rewritten.
The index has been refreshed under that same lock, so the check and the write see one state and there is no window between them.
A refusal at that point has written nothing, which is why it sits before the write loop rather than after it.

A removal is refused when a record this transaction leaves behind names the removed id: a child's `parent_id`, a stored relation edge, or a closed sprint's committed set - read both as the frozen `carried` and `finished` lists this build writes and as the `sprint_id` a sprint closed by an older build left its members pointing at.
The transaction's own effects are answered first, so a referrer it also removes leaves nothing behind and one it rewrites is judged as this transaction leaves it.

An item write is refused with `S10` when it INTRODUCES a `parent_id` the store does not hold, using the sentence that rule already uses for a removal of a record that is not there.
That closes C without teaching `set` and `file` a read set they do not have, and it covers the hand-built and `migrate` paths that a service-layer read set would leave open.

"Introduces" is the whole rule, and the first draft did not have it.
Watching the reference rather than the write that creates one refused every write to a record whose parent had already gone: `treadle set child-task assignee=kim` answered `CONFLICT rule S10` with `fix treadle show parent-story` over a record that is not there, and the remedy `H30` prints is itself a write to that record.
So a write whose `parent_id` is what the store already holds for that record passes, exactly as a record carrying an `H24` edge is still writable, and only a new or changed parent is checked.
The one exception is a transaction that removes the parent itself: an unchanged `parent_id` is refused there, because that transaction is what creates the dangle.

`R6` stays exactly as it is.
It fires first, with the friendlier cause and the fix lines, in the ordinary case where the neighbour was already there; `S17` is what answers the case `R6` cannot see.

### Relation targets are checked on a removal and not on a write

An edge naming a record the store does not hold is `H24`, a finding a hand edit may legitimately leave, and ADR-0015 decided it is a finding rather than a refusal.
Refusing one at write time would refuse to write back any file that already carries one, so the asymmetry is deliberate: the removal that would create the dangling edge is refused, and a record that already carries one is still writable.

### `items.parent` gains an index, and the format number does not move

The scout report designed the child lookup as "one indexed lookup, 0.002 ms at 50,000 rows".
There was no index on that column: measured here at 50,000 rows, 8.85 ms of full scan against 0.006 ms behind `items_parent`, on a machine at a 1-minute load of 2.8.
The index is partial (`where parent is not null`), because four rows in five carry no parent and `= ?` never matches null; it serves `parentEdges` too, which reads exactly that subset.

`INDEX_FORMAT` stays at `6`.
It exists for a column that changes meaning, which would leave rows an older build wrote being served by newer code.
`create index if not exists` runs on every open and derives its rows from the columns that are already there, so an existing index gains it without a re-derive and no row's meaning moves.

### `H30`: a `parent_id` naming a record the store does not hold

The store now refuses to write one, so this reports what reaches the files by the routes decision D1 permits: a hand edit, a git merge, a build older than this rule, a crash between two writes.
It runs against the same held-or-served set `H24` and `H26` use, so a child of a quarantined record raises nothing - the record exists, it is simply not served.
Its detail names the line that clears it, as `H24`'s does: `treadle set <child> parent_id= drops it`.

## Alternatives considered

**Take the lock before `remove`'s read, widening the transaction to cover it.**
Rejected.
It closes A and B and not C, which is a `set` that never takes the wide lock, and the cost is a `remove` holding the write lock across a full `readWorkspace` - milliseconds at 24 items and seconds at 50,000, with every other writer waiting.
That trades the store's measured concurrency for a rule that does not even close the third case.

**Drop or flag the edge at read time, so a dangling reference never reaches a caller.**
Rejected as the fix.
`H24` already does this for relations, and it is the behaviour that leaves a record silently pointing at nothing.
It is the repair half, not the guarantee, and `H30` is that half done properly.

**Add `reads: [{ id: parent, version }]` in `editing.ts` and `items.ts`.**
Rejected as the whole answer.
It closes C for those two commands and leaves the hand-edited and `migrate` paths open, and the store already re-reads what it needs under the lock, so the check costs one indexed lookup where it is.

**An `edges(source, kind, target)` table in the index, so the relation lookup is indexed too.**
Deferred, not rejected.
The scan is 12.2 ms at 50,000 items and the bench corpus's edge density, and 26.5 ms at three times that density; a covering index on `(relations, id)` takes it to 4.6 ms and a full `edges` table would take it to a lookup.
None of that is paid by anything but a removal, against a workspace read the same command already performs at 218 ms, so the measurement does not ask for it yet.
When it does, the table is maintained where `relations` is written and the change carries an `INDEX_FORMAT` bump.

## Consequences

- The store seam gains one refusal id, `S17`, in the `CONFLICT` class, which is exit 4 and an additive change under [../../STABILITY.md](../../STABILITY.md)'s exit-code rule. Both store implementations carry it, so the conformance suite covers both.
- `doctor` raises twelve findings rather than eleven, and `explain` carries `H30` beside `H24` for the one item it audits.
- A removal pays one indexed lookup, one scan of the rows that carry an edge, and one decode of the closed sprints, all inside the critical section every write already holds. Lock scope, lock order, the compare-and-set and the journal are untouched, and `test/store/lock.test.ts`'s 24 parallel writers touch no parent and no relation, so they pay one indexed lookup each.
- The overlay store gains the same rule, so `--dry-run` refuses what the real write would refuse.

## Departures from the design record

The design record put referential integrity at the layer that reads: DR2 makes the committed files authoritative and every dangling reference a finding, and ADR-0015 followed it for relations.
That is right for a state the files already hold and wrong for a state a write is about to create, and the distinction only became visible once `remove` existed to create one.
So the rule here is not a reversal of D1: reading still always works, a dangling reference the files already carry is still served and still reported, and what changed is that no write path may add one.

ADR-0024's `R6` reasoned that "a write that manufactures a finding is a write the tool should not perform" and implemented it where the guards were.
That sentence was right and the layer was not, which is what the reproduction above measured rather than argued.
