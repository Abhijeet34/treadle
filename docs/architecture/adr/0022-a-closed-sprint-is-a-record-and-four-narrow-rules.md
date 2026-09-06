# ADR-0022: A closed sprint's tally is frozen at close, and four seams where the tool was too narrow or too quiet

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** rows 3, 11, 12, 13 and 16 of the full audit

## Context

Five findings from one audit meet where sprints, relations and impediments do.
Four are the same shape: a rule written narrowly, shipped, and then found not to cover the thing it was named for.
The fifth is the opposite, a rule that was right and a tool that said nothing about what it had accepted.

A sprint closed with one item carried, that item committed to the next sprint and finished there, reported `1/1` on both sprints.
`committedTo` unions the ids the close recorded with the items pointing at the sprint now, and `tallyOf` read their current state, so one item was counted done twice and every velocity figure after the first carry-over was wrong.

`doctor` exited 7 with `H27 ... the impediment is draft and blocks nothing` between `file` and `relation add`, which are the two commands ADR-0017 accepted and which `help file`'s own example prescribes in that order.
A CI job running `doctor` therefore failed between two lines the tool told the caller to type, and exit 7 is also what a corrupt store returns.

`evaluateCommit` reads the ready gate and never the state, so a `draft` item with complete fields commits to a sprint.
`board` then filed it under draft, `status` counted it `0/1`, and `next` refused to rank it: the sprint held work the tool would not suggest and nothing said why.

`treadle show sprint-1` and `explain sprint-1` answered `NOT_FOUND` with "is in no record here; this workspace holds N items" while `history sprint-1` answered from the same id, because `notFound` searched item ids only.
`sprints <id>`, the read that works, was named in no refusal.

`addRelation` checked no state, so a `blocks` edge out of a done or cancelled item was accepted and inert: `explain` on the target said `blocked no` while the caller believed they had blocked something.
Separately, `duplicates` fed `R4` and `show` and nothing else, so a copy could be groomed, started and committed to a sprint beside its original.

## Decision

### A closed sprint answers from the tally its close recorded

The captain's recorded decision on this capability is to freeze the tally at close: store the done count beside the carried list, and count a carried item as done only in the sprint where it was finished.
The sprint record gains `done` and `done_points`, written by every close and cleared by a reopen, validated like `carried` as set only on a closed sprint.
`tallyOf` takes the sprint as well as the items and reads those two numbers when the sprint is closed and carries them; everything else in the tally stays derived.

Both numbers are stored, not only the count, because velocity is read in points as often as in items and freezing one of the two would have left the headline figure rising after the close.
`committed`, `cancelled` and `points` stay derived: `evaluateCommit` refuses a terminal item, `uncommit` refuses a closed sprint, and the items a close carried are restored by `committedTo`, so the committed set of a closed sprint does not move on its own.

A sprint closed by a build older than these fields carries neither, and reads live exactly as it did.
That is the whole of the migration: absent means not recorded, and no file is rewritten.

Velocity is a historical record. A figure that rises after the period it describes is not one.

### `H27` reports a raised impediment, and `DOR9` refuses to raise one that holds nothing up

`H27` no longer fires on a `draft` impediment.
`file` lands an impediment in `draft`, so the finding can no longer fire between the two prescribed commands, and a CI job that runs `doctor` after each of them sees exit 0 at both points.

That alone would have moved the complaint one state along, so the refusal was added where the tool can make one: `DOR9`, scoped to `impediment`, fails the ready gate while the record carries no `blocks` edge, with `treadle relation add <id> blocks <id>` as its remedy.
Grooming is where an impediment stops being a record someone is writing and becomes one raised against work, so that is the move to refuse.

This makes the pair the same one `R2` and `H25` already are: a write-time guard for what the tool is asked to do, and a load-time finding for what a hand edit or a `relation remove` left behind.
`doctor`'s exit 7 now means the files say something no write path would have accepted, which is the only thing it should have meant.

The two-command shape stays.
ADR-0017 refused a `--blocks` flag on `file` because `relation.ts` is the one writer of the `relations` field, and that reason is untouched by this finding: what was measured is that `doctor` was wrong between the two commands, not that the two commands lose impediments.

### A sprint admits ungroomed work and stops being silent about it

The defect is the silence, not the admission.
`I4` is unchanged: a `draft` item whose fields are complete still enters a sprint.
What changes is that five surfaces now name those ids instead of leaving a reader to infer them from a tally.
`notGroomed(items)` in `src/application/services/context.ts` is the one derivation, and `next` ranks `ready` only, so the list it returns is exactly the committed work `next` will not suggest.

`sprint commit` and `file --sprint` say it at the moment of committing, on a `not_ready` key and a `note` that names the grooming line for the first id.
`sprints <id>` and `status` carry `not_ready`, absent when there is nothing to say, which is the shape `overdue` and `defects` already have and what keeps the orientation call its current size for a workspace with none.
The key is last in all four shapes' property order, because the compact line rendering is a projection of that order, so an append is the one addition docs/STABILITY.md calls non-breaking and no schema version moves; `fbab9fb` set that precedent when it appended the `sprints` block to `status`.
`board` needed no change: it has listed the ids in its `draft` column, scoped to the open sprint, since ADR-0018, which is what made this defect visible in the first place.

Refusing was priced and refused.
Planning a sprint with work that is not refined yet is ordinary practice, and `file --sprint` files in `draft` by construction, so a refusal would have made that flag refuse every item it can ever file: one command becomes three, and a shipped flag becomes dead, which is a worse outcome than the defect.
The write-time refusal pattern this record uses for `R5` and `DOR9` is right where the tool would otherwise accept a write that means nothing. This is not that shape, because the write means exactly what it says.

A team must be able to read "three committed, one not ready" without inferring it. That is a reporting duty, not a rule.

### `notFound` searches the sprint ids too

A sprint is a record with an id, so an id-taking read that cannot find an item now looks at the sprints before it says the id names nothing.
An exact hit is a refusal that says `<id> is a sprint here, not an item, and show reads items`, with `treadle sprints <id>` and `treadle backlog --sprint <id>` as its fix lines.
A near miss reaches the `near` list beside the item ids, so a mistyped sprint id gets the same two-step correction a mistyped item id gets.

`show` and `explain` refuse rather than answer, because `show` is the item read and `sprints` is the sprint read, and one command rendering two record shapes would be two answers behind one name.
A refusal that names the read that works is the whole of what the caller was missing.

### `R5` refuses a `blocks` edge that would block nothing, and `duplicates` earns `DOR10`

`addRelation` takes the same `stateOf` reader `blockersOf` takes, and refuses a `blocks` edge whose source is already done or cancelled.
That edge is inert on every read by `blockersOf`'s own rule, so accepting it wrote a record whose only effect was to make the caller believe something they had not done.
The previous round's note on the result was the tool saying so and letting the write land; a caller who reads `changed 1` has been told the write happened, which it had.
`R5` refuses the write and never the stored edge: the edges a resolved impediment still carries were written while it was live, and ADR-0017 depends on them staying.

`duplicates` earns exactly one more rule, and it is `DOR10`: the ready gate fails while the item duplicates another the store holds.
One rule reaches all three surfaces the finding named, because they all read the same verdict.
Grooming is refused by `G1`, starting is refused because the item cannot reach `ready` to be started, and `sprint commit` is refused because `evaluateCommit` reads the ready gate.
Its remedy is `treadle transition <id> cancelled --resolution duplicate --reason "<why>"`, which is what the `duplicate` resolution has been in the closed set for since ADR-0010.

`DOR10` passes when the original is an id the store does not hold.
A dangling edge is `H24`'s finding and its remedy is `relation remove`, and a gate rule that read the raw edge would have held the copy at `draft` for ever on a record nobody can move, which is the trap `blockersOf` documents for blockers.
`DOR9` and `DOR10` both pass on a done or cancelled item, because the remedy each names is a move the transition table refuses from there and finished work is history under both rules.

A relation kind that decides nothing is a label. This one decides one thing, and once is enough.

## Alternatives considered

### Deriving the closed tally from `carried` instead of storing it

A carried item is non-terminal by definition, so counting a closed sprint's done items as "done and not carried" fixes the reported double count in three lines and adds no field, no validation, no codec and no migration.
It was refused because it does not freeze: an item reopened out of `done` while still pointing at the closed sprint drops that sprint's count, which is the same defect in the other direction, and the recorded decision is to freeze the tally rather than to patch its worst path.

### Refusing a `draft` item at `I4`

Refused above, on the flag it would have killed.
It was written and measured first: with the refusal in place, `holds file --sprint to the same rules as commit` fails and the flag's every invocation exits 3.

### A severity split on `doctor`'s exit code

`H27` between two prescribed commands could have been answered by making some findings advisory and exiting 0 on them.
Refused: `doctor`'s contract is that the table is the answer and the status is the verdict, and a second class of finding makes the status mean "some of what I found" on every call, for one finding that should not have fired at all.

### `file --blocks <id>`

Refused again, on ADR-0017's own reason, which this finding does not touch.

### Extending `duplicates` to a guard, the ranking and a list as well

Refused: the ready gate already reaches every surface the finding named, and three more rules would have been three more places for the same fact to be decided.

## Consequences

- The sprint dictionary gains `done` and `done_points`; `SPRINT_FIELDS`, `validateSprint`, the sprint codec's `FIELD_ORDER` and the field-visibility sweep all carry them, and a close prints both on its `set` list.
- `tallyOf` takes the sprint, and `sprints` and the sprint list read a closed sprint's completion off the record.
- `H27` no longer fires on a `draft` impediment; `DOR9` and `DOR10` join the default ready gate, and `blocks_something` and `not_a_duplicate` join the closed set of check kinds.
- `GateContext` gains `duplicateOf`, derived in `gateContextFor` from the item's own `duplicates` edge and resolved against the view.
- `addRelation`'s signature gains the `stateOf` reader, and `R5` joins the relation rule ids.
- `not_ready` joins the `sprint`, `file`, `sprints` and `status` shapes, appended last in each, which the output-schema rule in docs/STABILITY.md makes a non-breaking addition; `I5` is the rule on a refusal that names a sprint where an item was wanted.
- `notFound` reads `view.sprintById`, so every command that refuses an unknown id through it routes a sprint id.

## Departures from the design record

The design record for sprints said the committed set is derived and the carry-over is the one thing a close records.
Two things are recorded now, and the second was found the same way the first was: by asking what a read of a closed sprint says once the work has moved on.
The principle is unchanged and its application was incomplete, which is the distinction the record is worth keeping for.

## What would reopen this

A workspace whose closed sprints need their `points` denominator frozen as well, which would be a team editing estimates on finished work and a measurement rather than a guess.
A team measured to commit ungroomed work and never groom it, which is the case where naming the ids is not enough and a refusal earns the flag it costs.
A team for whom `file` then `relation add` is measured to lose impediments between the two commands, which is ADR-0017's `--blocks` flag and not this record.
A second relation kind that needs a gate rule, which would be the moment to name the pattern rather than repeat it a third time.
