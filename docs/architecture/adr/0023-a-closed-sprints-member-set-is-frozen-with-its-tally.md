# ADR-0023: A closed sprint's member set is frozen with its tally, and a membership test asks the whole store

**Status:** Accepted
**Date:** 2026-09-07
**Implements:** the sixteen findings of the round-five adversarial audit
**Superseded by:** [ADR-0029](0029-the-record-is-the-product-and-the-agile-surface-is-not.md), which removes the surface this record designed

## Context

ADR-0022 froze `done`, `done_points` and `cancelled` at close and said, in the same breath, that "`committed`, `cancelled` and `points` stay derived".
The fifth adversarial round measured what that leaves.

`sp1` closed with six members: one done at 5 points, one cancelled, four carried.
`sprints sp1` read `committed 6`, `done 1`, `cancelled 1`, `pts 5/8`.
Then two legal moves, each of which a team makes without thinking:

```text
$ treadle transition gamma-task draft --reason "back on"   # revive the cancelled member
$ treadle sprint commit sp2 gamma-task
$ treadle transition alpha-task in_progress --reason regressed   # reopen the done member
$ treadle sprint commit sp2 alpha-task
$ treadle sprints sp1
committed 4
done 1
cancelled 1
pts 5/3
```

Four committed, one done, one cancelled, four carried.
Five done points out of a total of three.

The cause is in two lines.
`committedTo` recomputed the set as "the items pointing at the sprint, plus the carried list", and a member that was terminal at close is in neither of those once it moves on; `carryOver` excludes it by definition, and `commit` re-points it.
`points` was summed live over whatever that produced while `done_points` stayed frozen beside it.
The reopen guard tested the `carried` list alone, so nothing anywhere noticed the member leaving.

The tool's own `I2` refusal says "a closed sprint's committed set is a record" and this ADR's predecessor is titled on it.
The code did not deliver what both already promise.

The same round found the same mistake in a second place.
`doctor` asked "is this id in the set the store SERVES", and a record the store holds and refuses to serve is not in that set.
So one quarantined sprint record made every item pointing at it report `H26 ... no sprint record carries that id`, and the remedy printed beside it was `sprint open --id sp2`, which over a file that already carries `sp2` leaves two of them and an `S3`.
A reader following the tool's own advice would have made the damage strictly larger.

## Decision

### The member list and every tally freeze together at close

The sprint record gains `finished`, the members that were done or cancelled at the close, and `points`, the total over the whole set.
With `carried`, which is every member that was not finished, `finished` is the committed set; the two are disjoint by construction, `membersOf` unions them, and `validateSprint` refuses a record that names an id in both.
Both are written by every close and cleared by a reopen, validated like `carried`: set only on a closed sprint, ids only, no repeat.

Storing the two halves rather than one whole list is a ceiling rather than a taste.
A whole list repeats every carried id, which is the "one fact in two places" the sprint module's own header refuses.
And a field value is bounded at 8 KiB, so one combined list halved the number of members a sprint could close with.
`finished` is stored as a `## Finished` section, one id per line, because it grows with the whole sprint while `carried` is bounded by the work the sprint left open: with the 8 KiB field ceiling, a 300-item sprint finished to the last item could not be closed at all, measured as `finished is 11698 bytes, over the 8192 byte ceiling`.
A section's ceiling is 128 KiB, and one id per line is what a reviewer reads in a diff.

`committedTo` reads that set for a closed sprint and never recomputes.
`tallyOf` counts `committed` as that set's own size, so a member whose record was later deleted by hand does not shrink a count the frozen numbers are still measured against; `doctor` reports that separately as `H28`.
A reopen destructures `finished` and `points` away with the rest, which is what returns the sprint to a live one, and is refused as before once a carried item has been committed onward.

The marker for "this close froze a complete record" is `points`, not either list.
An empty list is written to no record at all, because the grammar refuses an empty field value and an empty section says nothing, so a sprint closed over no work carries neither.
Reading that absence as "an older build closed this, count live" let a hand edit point an item at such a sprint and read `committed 1` under a frozen `done 0`.
`points` is written by every close this build performs and by none before it, so it is the field that says the record is complete.
A record with no `points` reads live, which is what it always did.

`sprints <id>` prints `members`, the two stored lists as the one set they record, so a reader can see what the four numbers describe.
`backlog --sprint` filters on the item's current `sprint_id` and `board --sprint` shows the live state of what still points at the sprint; for a closed sprint each now prints a `note` saying so and naming `treadle sprints <id>` as the record.
Three commands answer three different questions about one sprint, and each says which.

The close event carries the whole frozen record on both sides, so a reading of the log alone recovers the tally.
A list of more than one id prints as `(list:<n>)` in `history`'s `what` cell, because that cell joins its own `field=value` pairs with commas and `carried=(unset)->t-four,t-three` read as two pairs.

### A membership test asks whether the store HOLDS the id, not whether it serves it

`Finding` gains `kind`, `item` or `sprint`, derived by the store from the file it was reading and carried through the port.
`doctor` builds two held sets from the findings it already prints and tests "served or held" before raising `H26` or `H24`.
The two kinds stay apart: reading them as one flat set turned a true `H26` into silence, because a quarantined item is not a sprint and a `sprint_id` naming one is still wrong.

An id another record still names is not free either.
A record deleted by hand leaves its neighbour's `blocks` edge and its sprint's `carried` and `finished` lists pointing at the id, and refiling the same title reissued it: the new draft read `blocked yes item-aa` on an edge it never had.
`file` now treats every such id as taken, so a derived slug skips it and an explicit `--id` is refused with `I5` naming the record that still names it.

### `doctor`'s exit reads what a finding hides

The verdict was "the table is not empty", so a git checkout with `autocrlf` exited 7, which is also what a truncated shard exits, and a CI job could not tell them apart.
The exit now reads `hidesContent`, the same predicate that decides whether a read over the store is refused, so the one status meaning "no answer over this store is whole" is decided in one place.
A table carrying only `SERVED_ANYWAY` rows prints them, says so on a `serving` line, and exits 0.
An audit finding is always over a served record and always counts.

Two new rules join the audit, both of which reached `sprints` output as facts and neither of which any write path produces.
`H28` is a `carried` or `finished` id no record here carries.
`H29` is a frozen tally larger than the set it was counted over: `done` or `cancelled` above the member count, the two together above it, or `done_points` above `points`.

### `explain` and `transition` read one table

`explain`'s `moves` block gains a `records` column: the values the edge writes and refuses to be taken without, spelled as the flag that carries each.
`edgeRequirements` in `src/domain/state-machine.ts` returns the guards and the records of one edge, and both `explain` and the evaluator read it, so the two cannot drift.
Before this, `explain` printed guard ids alone and said `-` on eight of the thirteen transition names, each of which `transition` then refused with `T4` or `T6` for a value the row never mentioned.
An agent that reads `explain` before acting, which is the whole point of the command, paid one refusal per move.

`explain` also prints `rules <passing>/<evaluated> pass`.
The `gates` block shows the failing rules and is the one block in the tool whose unshown rows no page or flag can fetch, so `~gates 0 8` could not be told from eight rows withheld.

### A line carrying a value the tool did not choose is marked

`ColumnSpec`, the `list` property and the `scalar` property each gain `data`, which is the contract's `marked-scalar` kind: the `"` marker without the free-text column's placement rule.
Every `set` list is marked, because `set <field> <before> -> <after>` ends in a value a caller wrote.
`history`'s `what`, `show`'s `ref` and its `evidence` scalar, and `doctor`'s `id` and `where` are marked columns, each of them a projection of bytes read from a file.
`guardCell` still holds every one of them to a single field, so nothing moves placement.

`--limit` was already refused for anything but a whole number of at least 1 by the entry-point work of PR #52, and `status` keeps its cheap structural `findings` count and adds an `audit` line naming the check it did not run.

## Alternatives considered

### Carried plus pointing, or pointing only, as a closed sprint's set

Both were rejected because each revokes something treadle has already published.
`I2`'s own refusal text and ADR-0022's title both say the committed set is a record; neither alternative can be true at the same time as that sentence.
The velocity figure a team reads at a retrospective is the artefact, and one that moves afterwards is worse than none, because it is read as history.

### Running the audit inside `status`

`status` reads `findings 0` where `doctor` exits 7, and the honest fix is either to count what `doctor` counts or to name the set.
Counting it would put the orientation call at `doctor`'s cost, 3,522.8 ms against `workspace`'s 478.6 at 50,000 items in `bench/budgets.json`, a 7.4x regression on the one command meant to be cheap.
A partial audit over what the view already holds is the same lie in a smaller size.
So the line says what it did not do, and names the command that does it.

### Switching the character counts to code points

`47 chars`, `(text:47)`, `H18`'s 10,000 and `T7`'s 500 all count UTF-16 code units, so an emoji counts twice.
Changing the unit changes what those bounds accept, which `docs/STABILITY.md` treats as a change to the command-line surface, and it would have to move together across the field dictionary, the store grammar and the echo sites or leave the four disagreeing.
One unit is used everywhere and `docs/DOMAIN.md` now names it.
The number in a refusal is the number the bound compared.

## Consequences

- The sprint dictionary gains `finished` and `points`; `SPRINT_FIELDS`, `validateSprint`, the codec and the field-visibility sweep all carry them, and a close prints both on its `set` list. `finished` is the sprint record's second section, beside `Goal`.
- `Finding` gains `kind`, derived in `ShardedStore.findings()` from the file rather than stored, so the index needs no schema change.
- `H28` and `H29` join the doctor rule ids; `auditSprint` is the audit's first per-sprint pass and runs after the record pass, because it needs the item ids.
- `doctor` exits 0 on a table whose every row is `SERVED_ANYWAY`, under a `serving` line. Under `docs/STABILITY.md` this removes a non-zero exit from a case, which is not a breaking change; the inventory's exit table and the two documents that quoted the old sentence are updated.
- `note` joins the `backlog` and `board` shapes, `members` the `sprints` shape, `rules` the `explain` shape, `audit` the `status` shape and `serving` the `doctor` shape, each appended last among the non-block properties, which the output-schema rule in `docs/STABILITY.md` makes a non-breaking addition.
- `explain`'s `moves` block gains a third column, and `guardsOnEdge` in the service layer is gone: it was a second copy of the `G8` rule with nothing holding the two together.
- `backlog --sprint <unknown>` now refuses with `I5`, as `board --sprint` already did.
- `sprint commit` and `sprint uncommit` refuse a repeated id with `C1`. Two writes of one record inside one transaction made the store answer `S10 ... unknown moved it`, naming a concurrent writer that never existed.
- `blockersOf` returns nothing for an item that is itself terminal, and `activeBlockerIndex` carries the same clause. Finished work is not held up by anything, and a blocker revived afterwards used to put a `done` item at `blocked yes` with two gate remedies.
- `relation remove` on an edge that is not stored says `no <kind> edge between <a> and <b> is stored here`. The kind is a stored token, not an English verb, and splicing it into one produced "does not blocks".

## Departures from the design record

ADR-0022 said the committed set stays derived, and this record reverses that clause.
The principle it argued from is unchanged and is the reason for the reversal: a closed sprint is a record, and a set that is recomputed is not one.
What the earlier record got wrong was the scope of "derived", not the goal, which is why it is marked overtaken in part rather than rewritten.
