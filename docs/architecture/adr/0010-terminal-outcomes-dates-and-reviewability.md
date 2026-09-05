# ADR-0010: A resolution and an attempt outcome instead of four new states, one due date, and two reviewability controls

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** sections 3.1, 3.3 and 3.5 of the board audit, which no design record precedes

## Context

The captain asked for a record that "updates upon success/defer/rejected/failed", for "dated activities" that show "target date/eta", and said the committed files are "not easily reviewable and maintainable with fear of context churn, context rot, ai slop creeping in".

Mapped onto the model that existed, two of those four words already had answers and two did not.
Success is `done`, which the done gate decides.
Defer is `on_hold` with `--until`, which the field dictionary already distinguishes from a hold with no date.
Rejected had half an answer: refused back to the maker is `rework`, and refused outright was a `cancel` with no way to say it was a rejection rather than a duplicate.
Failed had none: an attempt that ended without the work being done had two legal exits, `on_hold`, which leaves `next` because `next` ranks `ready` only, and `cancelled`, which leaves the board.

For dates, only `epic.target_date` existed, and nothing read it.

## Decision

### Terminal outcomes are a resolution and an event key, not four states

`resolution` is a closed enum on the work item: `wont_do`, `duplicate`, `superseded`, `cannot_reproduce`, `rejected`.
The `cancel` transition requires one, every other transition refuses one, `revive` clears it, and the field dictionary refuses the field on any state but `cancelled`.
`--reason` stays and stays free text; the resolution is the machine-readable half, so `backlog --state cancelled --resolution duplicate` counts without parsing prose.

`release` is one new edge, `in_progress` to `ready`, reason required, no guards, carrying `outcome: failed | yielded` in the event and nothing on the record.
The failure is a fact about the attempt rather than about the item: the item goes back to the queue with its version bumped, and the log says who tried and why it did not take.

Both are on one rule id, `T6`, because they are one rule: an edge that records a closed-set value refuses to be taken without one, and refuses one it does not own.

`done` carries no resolution.
`Done` would be the only value ever set, and a field with one value is a byte on every finished row for nothing.

### One `due` instant, one derived `overdue`, and three reads that act on it

`due` is an optional instant on every type, replacing the epic-only `target_date`.
`overdue` is derived on read exactly as `blocked` is: true when `due` has passed and the state is not terminal.
Nothing auto-transitions, because 2.2's rule is that a silent state change is what the audit log exists to prevent.

Three reads act on it, which is what stops the field being decoration.
`show` prints `due` and the whole days it is past.
`status` prints an `overdue` count and a `health` block naming each finding.
`next` gains a `u` component with its weight printed beside the other five.

`H17` is the finding: an overdue item assigned to nobody.
The design gives findings like this to `doctor`, which is not built; `status` carries them until it lands, and `healthFindings` is the function `doctor` will consume unchanged.

ETA is not a field.
The Kanban Guide's Service Level Expectation is computed from cycle time, and the cycle-time metric is specified and unbuilt, so a declared ETA today would be a claim with no evidence behind it.

### Two reviewability controls that cost nothing on a read

`init` writes `events/*.jsonl merge=union linguist-generated=true`, so a forge collapses the event log in a diff and the review surface is the shard.
The log stays committed and authoritative; only the default rendering of a diff changes.
Measured on a sixty-item board, a record is 143 bytes and an event 298, so the log is 7.7 times the record bytes per mutation and is most of every pull request that nobody reads.

A generated id stops at the last whole word under 32 characters rather than at byte 24.
The dictionary allows 64.
Cutting at 24 produced `saml-login-for-enterpris` and `checkout-drops-the-sessi`, and an id is the thing every command, diff and event names.

## Alternatives considered

### `rejected` and `failed` as states

This is the shape the captain's four words suggest and it is the one that makes the machine unenforceable.
The table has 23 edges after this change.
Two more states need an entry edge each, a hold and resume path each, and a cancel each, so at least eight more; the board maps each column to exactly one state (C.2), so both need a column decision; and each of the fourteen specified metrics needs a ruling on whether the new state counts as finished.
A resolution field adds no edge and touches no metric formula.

Atlassian draws the same line: "A work item's status indicates its current place in the space's workflow" and "A work item resolution is usually set when the status is changed", with `Done`, `Won't do`, `Duplicate` and `Cannot reproduce` as the defaults.
A state is where an item can go next; a resolution is why it stopped.

### `failed` as a resolution rather than an edge

A resolution stops the item, and a failed attempt should not.
The work is still wanted; the person or agent holding it is finished.
Recording the failure as a resolution would put the item in `cancelled` and take it off the board, which is the outcome the edge exists to avoid.

### A `doctor` command for `H17`

`doctor` is specified and unbuilt, and building it to carry one finding would be a command with one caller.
`status` already prints the `findings` count and is the orientation call, so the block goes there and `doctor` consumes the same function when it lands.

## Consequences

- The state machine has 23 edges and `TRANSITIONS` names thirteen.
- `T6` joins the domain's closed rule set; `H17` is the second finding id borrowed from the design's doctor namespace, after `H16`.
- The event schema gains `outcome`, appended after `reason` in DR3's fixed key order. ADR-0003 already records that appending a key is not a schema bump.
- `target_date` is read as `due` by `decodeItem` and never carried into `extra`, so a stored record is read under the new key and the next write to it renders the new key. No file is rewritten to change a name.
- Nothing is published, so narrowing `epic.target_date` into the common `due` is a release note rather than a break.

Measured on the golden 24-item workspace, in the `agent/1` rendering:

| Read | Before | After | Why |
|---|---|---|---|
| `status`, nothing overdue | 440 B | 440 B | both new lines are absent when there is nothing to say |
| `status`, one overdue item nobody owns | 440 B | 513 B | `overdue 1` and a three-column block naming the record |
| `show`, an item with no due date and no resolution | 273 B | 273 B | an absent optional field is an absent line |
| `show`, a cancelled item | - | +19 B to +22 B | one `resolution` line, whichever value it carries |
| `show`, an item two days past its date | - | +35 B | `due` and `overdue` |
| `next` | 350 B | 365 B | `due 4` in the weights line and `/u0` in each of three rows |
| `explain`, an item in progress | 354 B | 362 B | one row in the moves block for the new `release` edge |
| `backlog` | 717 B | 717 B | no column changed |

## Departures from the audit's own pricing

- **The audit priced 3.3 at "13 bytes on status and show".** Measured, it is zero on both until a date passes, 15 on `next` rather than 3 because R11 requires the weight to be printed beside the component, and 73 on `status` once a finding exists. The finding's row is three columns rather than a sentence, which is what keeps that number down.
- **The audit priced 3.1 at "0 on non-cancelled rows".** That holds for `show` and `backlog`. It missed `explain`, which gains 8 bytes on an item in progress because the new edge is a legal move and `explain` lists them.
- **`overdue` is a named line rather than the fourth glyph in B.3's precedence table.** No glyph column is built: the human rendering emits no `!`, `~` or `^` today. Adding a precedence table for one signal would be the table's first entry and its only caller.
- **The `.gitattributes` line is written by `init` only.** An existing workspace does not gain it until someone edits the file. Rewriting a workspace's files on read would be a mutation on a read path, which nothing in this store does.

## What would reopen this

- A fifth resolution value that is not a reason for stopping. The set is closed on the argument that a resolution says why work stopped; a value that says something else means the field is being used for two things.
- `doctor` landing, which takes the `health` block off `status` and gives `healthFindings` its intended home.
- A measured case where an attempt outcome has to be queried rather than read in the log. It is an event key today precisely because it describes an attempt and not an item; a filter over it would mean it belongs on the record after all.
