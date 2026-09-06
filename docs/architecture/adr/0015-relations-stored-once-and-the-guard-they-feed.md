# ADR-0015: A relation is stored once on its source record, and the guard it feeds already existed

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** section 1 of the capability contract for the four absent features, and domain model 2.3 for the three kinds a caller may write

## Context

`explain` printed `blocked no` and `blocks -` on every item from the day the tool shipped, and no command could write either.
The domain layer carried the whole relation model, the store persisted none of it, and `src/application/services/context.ts` handed every read an empty graph with a comment saying `link` would fill it in.
That is the same family as the acceptance criteria that could be written and never read, and the persisted fields with no read surface: the tool reported a fact it had no way to record.

Four questions had to be answered the same way for the three builders that follow this one, because impediments block work through this edge.
Where does an edge live.
What does the `in_progress` guard do once something can block an item.
What happens to an edge when its other end is cancelled or removed.
What does the `dep 5` weight in `next` measure, given that it was declared before anything fed it.

## Decision

### One stored direction, on the source record, as a `Relations` section

An edge is a `- <kind> <id>` line in a `## Relations` section on exactly one record: the blocker for `blocks`, the copy for `duplicates`, and the lower id for `relates_to`.
The inverse is derived on every read by `relationsOf`, `blockersOf` and `blockedByThis`, and never written.
Both of `explain`'s lines, `show`'s `relations` block, the `dep` component and guards `G2`, `G7` and `DOR3` are served from that one direction.

Two stored directions are two places for one truth.
A hand edit or a merge moves one without the other, and the tool then has to pick a winner or report a contradiction on every read.
Storing on the source rather than the target is the choice that makes the record's own line read as a sentence: `auth-refresh` says `blocks sso-saml`, and `sso-saml` says nothing, because the fact is about what `auth-refresh` holds up.
A symmetric edge has no source, so it takes the lower id, and `relation add` spelled from either end lands in the same place and reports `already` the second time.

It is a section rather than a field line because it is a list a reviewer reads in a diff, which is the shape `Evidence` and `Acceptance criteria` already have.
`MAX_RELATION_ENTRIES` bounds it at 50 on the write path.

### The command writes three of the six kinds

`relation add` and `relation remove` accept `blocks`, `duplicates` and `relates-to`, and the capability contract's hyphenated spelling of the third is taken beside the closed set's `relates_to`, both naming one stored kind.
The domain's `RELATION_KINDS` keeps its six, so a record carrying `caused_by`, `discovered_from` or `split_from` still loads, still shows, and gains a writer with a decision rather than by default.
The contract's words are "three, and no more without a decision", and this is the decision that the other three wait.

### The `in_progress` guard is not new, and it refuses

`G2`, "the item is not blocked", has been on the `start` edge since the transition table was written.
`docs/DOMAIN.md` lists it, `explain` prints it on the `in_progress` move of every ready item, and `transition --override G2 --reason` has been in the help.
It never fired because nothing could feed it.

The contract calls feeding it a breaking change under `docs/STABILITY.md`, and I read STABILITY's own test the other way.
The exit-code contract breaks on "a new non-zero exit for a case that used to succeed".
No invocation that succeeded before this change can now fail: every workspace written by any released version carries an empty relation graph, and `start` behaves on it exactly as it did.
The refusal exists only after a caller runs the new command, which is the case STABILITY's "not breaking" column names as adding a command.

Two softer readings were priced and refused.
A warning instead of a refusal makes `blocked` decorative: a caller starts the item, the blocker finishes later, and nothing in the log says the item was worked on out of order.
The override already is the warning, and it costs a reason that `history` prints as `override=G2`.
Applying the guard only when the blocker is not itself done is what `blockersOf` has always done: a blocker in `done` or `cancelled` is not active and does not count.

So the guard stands as the table wrote it, `G2` refuses with the blockers named, and the release note records that `start` can now refuse on a workspace that has used `relation add`.

### A cancelled other end leaves the edge; a removed one is a finding

When the blocker is cancelled or done, nothing changes on disk.
The edge stays on the record, `show` still lists it, and every derived read already treats a terminal item as inactive: `blocked` goes to `no`, `blocks` drops it, `dep` stops counting it.
The edge is the decision that was recorded, and `duplicates` in particular is a fact that outlives the original's state.
Cancelling a blocker while something active still waits on it is `G7`'s refusal, which yields to an override with a reason, and that is unchanged.

When the other end's record is removed by hand, which D1 makes a legitimate edit, the edge dangles.
That is doctor finding `H24` on the record that holds it and on `explain` of that record, and the detail names `treadle relation remove <id> <kind> <other>` as the line that drops it.
`relation remove` therefore accepts an id the store does not hold, because the remedy has to run.
A dangling edge counts for nothing on any read: `blockedByThis` already required a known state, and `blockersOf` now does too, so a record removed by hand never holds another item forever.

A `blocks` cycle the files carry is `H25`, naming the path.
`relation add` refuses one at write time as `R2`, and cannot see one a hand edit or a merge put in, which is threat-model finding F8's case.
The load-time finder the domain always carried had no caller until this.

### `dep` counts the active items this one directly blocks

`d<n>` in a `next` row is the number of active items the ranked item directly blocks, so finishing it frees `n` items.
It is not blocker severity, because the ranked item is the blocker and its own severity is already `v` on the same row; the impediment work reads severity across the edge and has its own line for it.
It is not blocked depth, because a chain is freed one link at a time and the next link is ranked when its turn comes.

An item with an active blocker is left out of `next`, because `G2` would refuse the start the list invites, and `next --explain-absence <id>` names the blockers as `blocked by <ids>`.
`status`'s three-row preview reads the same ranking.

### `status` no longer lists `relation` as absent

`absent_features` is `sprint board impediment`.

## Alternatives considered

### Storing both directions

Rejected above.
The cost is one derived lookup per read, which `readWorkspace` already pays for the hierarchy.

### An edge as a field line, `relations: blocks a, duplicates b`

A field line is one value the grammar bounds at 8 KiB and a reviewer reads as a run-on.
The section form puts one edge on one line, which a diff shows as one added or removed line, and the parser already has the shape from `Evidence`.

### One event on each end of the edge

The record written gets the event, so `history <other>` does not show that it became blocked.
Two events per write would put the edge in the log twice with one of them against a record that did not change, and `H20`'s logic reads the log per entity as a record of that entity's writes.
`explain <other>` answers the question the log would have, from the edge itself.

### Refusing a dangling edge on load

A record that names a missing id would be quarantined, which hides the whole record for one line no reader is harmed by.
`docs/STABILITY.md` says reading always works, and the finding is the loud answer that keeps that true.

## Consequences

- `relation add <id> <kind> <other>` and `relation remove <id> <kind> <other>` are the writers of the `relations` field, and `set` refuses it, through `writerOf`.
- `R4` joins the domain's closed rule set: a second `duplicates` edge out of one item is refused, naming the first original.
- `H24` and `H25` join the doctor's finding ids.
- `show <id>` gains a `relations` block, appended after `criteria`, listing stored edges under their kind and edges other records hold against this one under the inverse.
- `history` prints a relation write as `relation=<kind>:<other>`, under the `what` convention, for both the add and the remove.
- `G2`, `G7` and `DOR3` fire for the first time on a workspace that has used the command.

## Departures from the design record

Domain model 2.3 names six kinds and a `link`/`unlink` pair.
The command is `relation add` and `relation remove`, which is the `evidence add` shape the surface already had, and it writes three kinds.
The model's `blocked` flag is unchanged: derived, never stored, and shown beside the state.

## What would reopen this

A second caller for one of the three unexposed kinds, argued rather than assumed.
A workspace whose `blocks` graph is deep enough that direct dependents mis-rank the item that would free the most, which would be a measurement on a real backlog rather than a theory.
