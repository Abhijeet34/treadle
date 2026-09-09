# ADR-0033: A current value can be arranged, and the log is what happened

**Status:** Accepted
**Date:** 2026-09-09
**Implements:** defects E1 and E2 of the end-to-end drive against `31aa1ac`, both reproduced before this record was written

## Context

Two priority-zero defects were measured, and they are one defect twice: a check read the state the files hold now, where the question it was asking is about something that happened.

**E1.** `DOD3` is the human-in-the-loop rule, and its actor half compared the caller against the `assignee` the record holds.
`assignee` is a field one `set` writes.
The refusal printed `fix treadle set <id> assignee=<name>`, and running that line is the whole exploit:

```text
$ treadle transition launder done                # agent-7 is the assignee and the reviewer
err GUARD_REFUSED
"cause the done gate fails: DOD3
fix treadle set launder reviewer=<name>
$ treadle set launder assignee=bob               # the actor-half fix line
ok set
$ treadle transition launder done
ok transition
state in_review -> done
guards G6 pass
```

Two writes by the agent that did the work, and the story is `done` with `reviewer: agent-7`, accepted by agent-7.
`doctor` was worse than silent: `H19` fired on the honest agent that had named a real reviewer because the refusal told it to, and said nothing about the laundered record, because the launder rewrote the very field `H19` reads.

**E2.** A shard cut mid-file turned ten records into seven.
`doctor` printed `clean checked 7 items and 11 events` at exit 0, `status` printed `items 7 findings 0`, and `history` for a vanished id printed the sentence a deliberate `remove` earns.
One lost record was reported, and only because it happened to hold a relation edge: the removal boundary this audit already kept covers EDGES (`recorded`, `#logRemoved`), and nothing read the log's set of filed-and-not-removed ids against the ids the store serves.
`H31` cannot see it either, because a record that is not served has no version to fall short of.

## Decision

### The check reads the log, and the field stays the field

The question `DOD3` asks is "did the person who did the work accept it".
Who did the work is not a field; it is a history, and the record carries only the last frame of it.
So the gate takes `workedBy`, folded off the item's own events: every name the log records as its `assignee` while its state was `in_progress`, `in_review` or `on_hold`.
No later write takes that back, which is exactly what the reassign launder needed.

The alternative considered was the narrower one the drive's report proposed: read the assignee at the instant the item entered `in_review`.
It is one frame instead of the whole trail, and one frame is defeated the same way the first was, by moving the reassign one write earlier - assignee `agent-7` through `in_progress`, reassigned before the submit, accepted by `agent-7`.
The trail costs the same to fold and closes both.

Reading the log does not replace the field test; it joins it.
An event log that says nothing about who held the item leaves `workedBy` empty and the rule decides on the field alone, exactly as it did before, which is how a workspace written by an older build keeps answering.

### Who ran the commands is not in the trail

Adding the actor of the move into `in_review` closes one launder more: an actor that never takes the field can file the item, assign the record to somebody else, carry it through review itself, and accept it.
It is left open, deliberately.
`DOD3`'s own sentence says "the assignee is not the one accepting", and the check has to decide exactly what the sentence promises - that rule is why the sentence names the caller at all.
Adding the submitter would also refuse a third party who accepts work the record attributes to somebody who is not them, which the rule has always allowed and which the repository's own fixtures drive.
The residual is real and it is named here rather than closed by widening a rule past its own prose: a record whose `assignee` names a worker who never touched it is a lie the files agree with, and no gate reading those files can see it.

### The remedy is the accept, run by the reviewer

`treadle set <id> assignee=<name>` was argued for on the grounds that a remedy is a command line the caller can run and no command makes the caller a different person.
The first half is right and the second half is the reason the line was wrong: a human-in-the-loop rule is not satisfiable by the caller alone, so a fix line that the caller can satisfy alone is a fix line that defeats the rule.
The refusal now prints `treadle transition <id> done --actor <reviewer>`, with the reviewer the record names filled in.
That is a line, it is runnable from where the item stands, and the person it is for is not the person reading it.
An agent that types it anyway is recorded as `agent` under a human's name, which is a trace the log holds and the reassign left nothing of.

Two bounds on it.
It is printed only when the named reviewer is not themselves in the trail, because a remedy is a promise that running it clears the rule; where the reviewer did the work too, the caller is sent back to `set <id> reviewer=`, which is the truth about such a record - it names a reviewer and has none.
And a reviewer is a caller-written line of up to 200 characters, so the name is printed only when it is one shell word and the placeholder stands in for anything else.

### `H19` loses its `reviewer` arm and `H34` takes over

`H19` reported an assignee writing `reviewer`, as a compensating control for a gate that read the name and never who wrote it.
That gate is closed now: no name written into that field lets the worker accept.
What the arm still did was fire on the honest path - naming a real reviewer is what the refusal itself prescribes - so it is removed, and `H19` is again what ADR-0011 argued: the assignee writing a marker field.

`H34` is `DOD3`'s load-time twin, the pair this codebase already keeps for `G3`/`H04` and `DOD7`/`H21`: a done record whose accept was run by somebody the log says held it while it was worked.
It reads the same fold the gate reads, so the guard and the finding cannot disagree about who did the work.
What reaches it now is a record closed before this rule, a hand-written event line, or a `review_step` widened after the accept.

### `H33` asks the log which records should be here

The store's promise is that damage never silently changes which records exist.
It kept that promise for a record it could see and refuse; it could not keep it for a record that is not in the file at all, because nothing compared the file set to anything.
`H33` is that comparison: the log filed an id, recorded no removal of it, and no record here carries it.

The one thing that makes an absence legitimate is an `item.remove`, which says out loud what went and why (ADR-0024).
The boundary is read in log order rather than by comparing instants, which is where it departs from `#logRemoved`'s rule: instants are second-granular, a record filed and removed inside one second carries two lines with the same `at`, and an instant comparison then has to break the tie by guessing - getting `remove` then `file`, the migration the tool offers for a field no command writes, wrong in the silent direction.

`history` gains the other half, because a finding nobody runs `doctor` for is not the read an agent makes: a record `remove` took now says so, and one that went without a removal event says that instead and names `H33`.
Those two sentences were one sentence, and it was the removal's.

## Cost

The audit's per-item state grows by one small object and, for an item that was ever assigned while being worked, one `Set` of the names in its trail - typically one entry.
`#logLife` holds one entry per id the log filed and the records did not supply, which on an undamaged workspace is empty.
Nothing here re-reads the store or walks the log a second time: both folds ride the one event pass ADR-0021 already pays for.

`transition` reads the item's own events on one edge and no other: `DOD3` is scoped to the review step and evaluated by `G6`, which sits on the edges into `done` alone.
`explain` pays nothing at all - it already read that log for the entry event and the per-item audit, and the read moved above the gates rather than being added.
Measured on the drive's own eight-item workspace, an accept costs one `events({entity})` scan of the log it was already going to append to.

## Consequences

- An agent that did the work cannot close it, whatever the record says about who is assigned now.
- A workspace that lost records says so, at exit 7, naming each id and the instant it was filed.
- `doctor` raises fifteen findings; `docs/architecture/adr/README.md` carries the table and `test/architecture/documented-numbers.test.ts` holds every document that counts them to what the code raises.
- A record whose `assignee` names somebody who never touched it is still accepted by a third party, which is the residual named above.
- `status` still reports `findings 0` over a workspace `doctor` reports on, and still says so in its own `audit` line. That is the orientation cost the drive filed as E5 and this record does not move it.
