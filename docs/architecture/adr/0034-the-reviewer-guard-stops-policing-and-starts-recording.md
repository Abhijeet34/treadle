# ADR-0034: The reviewer guard stops policing and starts recording

**Status:** Accepted
**Date:** 2026-09-10
**Implements:** the four-eyes decision taken by firstmate under the captain's standing routine authority for treadle, 2026-09-10

## Context

`DOD3`'s actor half never engaged on the cheapest version of the thing it was written to refuse.

One actor files an item, works it, submits it, names a reviewer who never touches it, and accepts it.
`workedBy` records a name only while `trail.assignee` is set, so an item nothing was ever assigned leaves the trail empty, the rule compares the caller against nothing, and the accept passes at `guards G6 pass`.
`H34` read the same trail and was silent for the same reason, so `doctor` printed `clean checked 1 item and 8 events` at exit 0 over the whole shape.

ADR-0033 closed the harder version of this, where the work was laundered through a reassignment.
Never naming an assignee at all is one command shorter and equally effective, and `test/cli/shift-walk.test.ts` had already characterised the gap in two tests whose own names said the rule was armed in one case and disarmed in the other.

So the guard refused a laundered record and passed the naive one, which is the worst ordering a rule can have: it is a tax on the caller that writes the fields honestly.

## Decision

### The accept stops refusing on actor identity

Neither enforce the actor half nor delete the protection.

Enforcing it means every item must involve a second actor.
That contradicts what treadle is for: a fleet of agents that critique and correct their own work, where one agent taking an item the whole way is the normal shape and not a fault.
Deleting the rule outright drops the field half, which does work in the one case where an assignee was named.

The rule is refusing the wrong thing.
treadle is a record of what happened, not a policeman of how it happened.
`DOD3` keeps the two facts it can read off the record - a reviewer is named, and it is not the assignee - and stops reading who is running the move.
Its sentence loses the clause the check no longer decides, because a rule's prose is printed by `config` and `explain` and a clause with no verdict behind it is a promise nothing keeps.

What goes with it: `GateContext.actor`, `GateContext.workedBy`, the `Asker` that `transition` and `explain` threaded them through, `foldWorkTrail`, `workedBy`, the `handOver` remedy and the `explain` argument that existed only to feed the rule.
The accept no longer reads the item's event log at all.

### `H34` reports single-actor completion

What was never acceptable is the audit reporting such a record clean, which tells a reader a second pair of eyes has been over the work.

`H34` becomes that report: a done record whose whole log names one actor is reported as single-actor completion, in the words a reader needs and with no remedy, because there is nothing to fix.
It is decided against the set of actors the log names for the record, which is one field on the audit's per-item entry and replaces the trail of who held the item when.
That set answers the question directly - how many people did this record pass through - and it sees the unassigned record the trail could not.

It stays scoped to the workspace's `review_step`, which is the setting that says this type is meant to get a second look.
A type nobody asked for review on would earn the line on every item and say nothing by saying it everywhere.

The finding counts events dated before an `item.remove` too, the way `H31`'s counter already does.
An id removed and refiled inherits the old record's actors, so the count can only run high, and running high is the direction that reports nothing rather than reporting a second actor who never existed.

### The change is smaller than what it replaces

That was the constraint the decision was accepted against, and it is the one measurement that says whether this is a record or another enforcement surface.

`src/**/*.ts`, 63 files before and 63 after, counted with `find src -name '*.ts' -exec cat {} + | wc -l`.

| tree | lines |
|---|---|
| before (`e2860bb`) | 15,208 |
| after | 15,036 |
| net | -172 |

No file was added and none was removed, so the whole of it is deletion from files that stay.

## Cost

Measured on an Apple M2, in process, one workspace per sample, seven samples, median reported.
The workspace holds one story carried to `in_review` with a reviewer named and evidence attached, and its log is padded to 6,000 events, which is the event count ADR-0033's 1,000-item corpus carried.
The accept is run by the named reviewer in both trees so that the timed command is identical; the submit is the control, an edge that read no log in either tree.

| operation | before (`e2860bb`) | after |
|---|---|---|
| accept | 43.04 ms | 15.95 ms |
| submit (control) | 22.67 ms | 17.70 ms |

The accept returns to the control.
ADR-0033 measured that read as one linear pass at about 5.2 microseconds an event and named it the price of the rule; the rule is gone, so the price is refunded, and an accept over the bench's largest corpus no longer carries the 2.6 s of log read that record extrapolated.

`doctor` is unchanged in shape: the actor set is folded on the one event pass ADR-0021 already pays for, and it replaces a fold of the same order that was already there.

## Consequences

- An agent that did the work can close it, and the record says that is what happened.
- `DOD3` still refuses a record naming no reviewer, and one naming the assignee as reviewer.
- `doctor` raises fifteen findings, the same count as before, because `H34` changed what it reports rather than joining or leaving the set.
- A workspace of single-actor work now exits 7 on `doctor` where it exited 0. `test/cli/shift-walk.test.ts` is one agent's whole shift and reports three of these, which is the honest reading of that shift.
- The residual ADR-0033 named is unchanged and is now the whole of what the rule cannot see: a record whose `assignee` names a worker who never touched it is a lie the files agree with.
