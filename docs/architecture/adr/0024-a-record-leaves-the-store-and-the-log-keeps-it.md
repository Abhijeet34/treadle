# ADR-0024: A removed record leaves its shard and nothing leaves the log, and three reads that were write-only get their reader

**Status:** Accepted
**Date:** 2026-09-07
**Implements:** the captain decision `first-run-gaps-before-publish`, over findings STR-3, STR-4, STR-5, STR-6 and STR-10 of the round-six report
**Overtaken in part by:** [ADR-0029](0029-the-record-is-the-product-and-the-agile-surface-is-not.md) removes the sprint, so the closed-sprint referrer below and the `sprint set` verb are gone and `I5` is now `V9`; the removal, the label and the title search stand
**Overtaken in part by:** [ADR-0033](0033-a-current-value-can-be-arranged-and-the-log-is-what-happened.md) splits the one sentence `history` printed for an absent id in two: `note this record was removed; the log keeps every event it earned while it was here` where an `item.remove` is on record, and a sentence naming `H33` where it is not; the query-the-log-first mechanism below stands

## Context

A scout ran a stranger's first week against the tool and came back with four holes, each one a thing the tool could write and could not read, or a mistake it could make and could not undo.

```text
$ treadling set login-cta labels=frontend,backend        # accepted
$ treadling backlog --label frontend
err VALIDATION  rule C1  --label is not a flag of backlog                    exit 2
$ treadling backlog --fields +labels
err VALIDATION  rule C2  labels is not a column of this list                 exit 2
$ treadling set sprint-1 goal="Ship the token refresh"
err NOT_FOUND  rule I5  sprint-1 is a sprint here, not an item               exit 5
$ treadling backlog --title login
err VALIDATION  rule C1  --title is not a flag of backlog                    exit 2
$ treadling remove login-cta-2
err VALIDATION  rule C1  remove is not a treadling command                     exit 2
```

Three of the four are missing readers, and their answer is not interesting: a field that only `show` prints is a field nobody can act on across a backlog, an open sprint whose typo is permanent is a record pretending to be immutable when only its closed form is, and a backlog with six exact-match filters and no way to find "the login thing" is answered by reading the whole list.

The fourth is a real design question, and the captain assigned it here rather than leaving it as a documented absence.
The store is append-only in one specific sense and not in another.
The event log is append-only by construction: every write appends lines to `events/YYYY-MM.md` and nothing rewrites them.
The record files are not: a `set` rewrites a record in place and bumps its version.
So "the store is append-only and committed to git" is true of the log and half true of the shards, and a removal has to say which half it is touching.

## Decision

### Removed means the record leaves its shard, and the event log is not touched

`treadling remove <id> --reason <text> --yes` takes one record out of `items/YYYY-MM.md` under the same compare-and-set token a write uses, and appends one `item.remove` event carrying the record's audited fields on the `before` side, the caller's reason, and the actor.

The trail is intact because the log gains a line and loses none.
Every event that record ever earned is still in the log, and `history <id>` reads them back after the removal, because the log is keyed by entity id rather than by a record existing.
That last part was not free: `history` refused an id no record carried, so before this change a removal would have erased the trail it is supposed to leave.
It now queries the log first and refuses only an id with neither a record nor an event, and prints `note no record here carries this id now; these are the events it earned while it did`.

```text
$ treadling remove login-cta-2 --reason "filed twice by the same import" --yes
ok remove acme tm59l25 1
item login-cta-2
"set state draft -> -
event ea9kzye
$ treadling history login-cta-2
note no record here carries this id now; these are the events it earned while it did
2026-09-07T14:18:56Z human item.remove type=task,state=draft,filed_at=… dana
2026-09-07T14:18:55Z human item.file  type=task,state=draft,filed_at=… dana
~reasons 1 1
2026-09-07T14:18:56Z item.remove filed twice by the same import
```

The record's prose is not in the log and does not need to be.
`auditedSnapshot` records prose as its length rather than its content, for the reason it always has, and the shard is a committed file, so `git log -p -- .work/items/2026-09.md` is where the removed record's own bytes live.
Git is the archive; the log is the trail.

### A removal is refused exactly where it would leave another record naming nothing

Three records can hold another record's id: a closed sprint's frozen `members` list, a stored relation edge, and a child's `parent_id`.
Each of those, left dangling, is a `doctor` finding the store already raises, `H28`, `H24` and the hierarchy's own, and a write that manufactures a finding is a write the tool should not perform.
So `remove` refuses with `R6`, names the record that would break, and offers the line that clears it.

An item's own state gates nothing.
A `done` item nothing names is removed, because no state of an item makes another record depend on it; what makes a done item dangerous is a closed sprint that counted it, and that is exactly the case `R6` already catches.
An open sprint is not a refusal either, because its committed set is what points at it, recomputed on every read, so a member leaving takes nothing with it.
Both consequences a caller did not name are said out loud instead, in one `note`: which open sprint shrank and to what, and what stopped being blocked.

`--reason` and `--yes` are both required, and the confirmation is checked last so `--dry-run` reaches every guard and answers what the real run would do without needing it.
The confirmation is a refusal naming the line to run, never a prompt, which is the shape `init`'s own confirmation already has.

### The id becomes free again, and `history` says so

Nothing stops a later `file --id login-cta-2` reusing the id, and `history login-cta-2` then shows both lives with the `item.remove` between them.
That is the true history of that id in this workspace and the reading a person wants; refusing the reuse would make the log's own completeness a reason to refuse a legal thing, and freeing a mis-filed id is half the point of removing it.

### Labels are a scan field, filtered by membership and printed as a column

`labels` joins `SUMMARY_FIELDS`, so it is in the index and in the view every command reads, and `backlog --label <slug>` and `board --label <slug>` filter on membership of that list.
`--fields +labels` prints it comma-joined; the column is not free text under F3, because a label carries no space by its own slug rule, so it sits in the same row as `title`.

The label bound drops from three characters to two, for `labels` alone.
`ux`, `ui`, `qa`, `ci` and `db` are the labels a team writes in its first week and every one of them was refused, which is a rule about ids applied to a field that is not one.
Two rather than one is where the meaning stops: a one-character label is indistinguishable from a value typed past, and it would make `backlog --label a` a filter nobody can read back.
`id`, `parent_id`, `sprint_id` and a relation target keep the three-character floor, because those name records and a two-character id collides far sooner than a label does.

### `backlog --title` searches titles by their words, and not descriptions

Every word of the value, case folded, anywhere in the title, in any order.
It is one clause in the same conjunction as every other filter, it names itself in the `filter` line, and `--explain-absence` reports the title the item does carry.

Titles only, and the reason is the row grammar rather than cost.
The title is the one field every list already prints, so a caller can see why each row matched.
A description match would return rows whose reason for matching is invisible, and `backlog` has no description column to add: F3 allows one free-text column per row and `title` is already it.
`help backlog` carries the whole rule as its second example, so a caller reads it rather than discovering it.

A value with no word in it is refused with `C1`, because it is the one filter value that would select everything rather than nothing.

### An open sprint's four written fields move; a closed sprint's do not

`treadling sprint set <sprint> [--title] [--goal] [--start] [--end]` writes what `open` wrote, through one `sprint.set` event, with the same `already` answer, the same `--dry-run`, and the same `--goal=` clearing syntax `set` uses on an item.
A required field refuses an empty value the way `set` refuses clearing `title`.

A closed sprint refuses every one of them with `I2`, naming `reopen` as the way back.
This adds no second door into a closed record.
The captain decision `closed-sprint-member-set` and ADR-0022 make that record what `sprints` reads its tally off, `reopen` already clears every frozen field and is already refused where reopening would drop a member, and that path is unchanged.

## Alternatives considered

**Tombstone the record: keep it in the shard with a marker and hide it from every read.**
Rejected.
It needs a state outside the lifecycle table that all twenty commands, every gate and every projection have to learn to skip, and it buys nothing the log does not already hold.
It also keeps the id taken, so re-filing under the right id is refused, and freeing a mis-filed id is the reason to remove one.

**Keep the record and hide it from every read.**
Rejected, and it is the worst of the three.
`doctor` reads the files rather than the served set, so it would report a record no command serves, which is the exact shape of a finding the store exists to raise.

**Refuse to reuse an id the log has ever named.**
Rejected on cost and on principle.
The cheap half, a keyed `events({entity: id})` on an explicit `--id`, leaves the auto-slug path uncovered unless every `file` scans the whole log, and a rule that holds for one spelling of the same command and not the other is worse than no rule.
The principle is above: a complete log is not a reason to refuse a legal thing.

**Search descriptions as well as titles.**
Rejected on the row grammar, argued above.

**Lower the shared `SLUG` regex from three characters to two.**
Rejected.
It is one character in one file and it changes `id`, `parent_id`, `sprint_id` and every relation target with it, which is a change to what names a record, made as a side effect of a change to what tags one.

**`set <sprint> goal=…` rather than a `sprint set` verb.**
Rejected.
`set` is the item field editor and its whole refusal set, its field dictionary and its `writerOf` routing are an item's; `sprint` is the verb namespace for sprints and already carries `--start`, `--end` and `--goal`.
The `I5` refusal a caller meets first, `sprint-1 is a sprint here, not an item`, already names `treadling sprints sprint-1` and is where a reader learns the namespace.

## Consequences

- The index gains a `labels` column and `INDEX_FORMAT` goes to `6`, which re-derives every row on the next open. The index is a cache and dropping it is the cheapest correct answer, which is what that constant is for.
- The store seam gains `StoreTransaction.removes`, implemented by both stores and therefore covered by the one conformance suite. The overlay hides a removed id from `get`, `list` and `summaries`, so `--dry-run` answers what the real run would.
- `history`'s `what` column gains its second one-sided form. A creation prints `field=value` because it has no before; a removal prints `field=value` because it has no after, and the `op` column tells them apart, exactly as it already does for `item.relation.add` and `item.relation.remove`. Rendering the missing side as `(?)` said the log did not record what the field became, when what it records is that it became nothing.
- `BACKLOG_SHAPE`, `BOARD_SHAPE` and `HISTORY_SHAPE` each gain a property at the end of their order, which [../../STABILITY.md](../../STABILITY.md) makes a non-breaking addition, so none of the three versions moves. `remove.v1.json` is a new schema for a new command.
- The inventory is twenty commands. `--yes` and `--no-input` reach their first `severe` confirmation class, which was reserved for `undo` and is what a removal is.
- `remove` is not `undo`: it takes one named record out and reverses nothing. The README's Status table says so where it lists `undo` as specified and not implemented.

## Departures from the design record

The design record has no removal at all.
It lists `undo` under the commands that reverse a transaction, which is a different thing: `undo` names a transaction and puts back what it moved, and `remove` names a record and takes it out.
Building the second does not build the first and does not make it easier, because the hard half of `undo` is the inverse of every op rather than the deletion of a record.

The design also treated labels as a display field.
Making a field filterable is what turned it into a scan field, and ADR-0014's rule decided the rest: a filter over the whole workspace reads the view, so the field belongs in the view rather than behind a per-record fetch.
