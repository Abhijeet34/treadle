# ADR-0016: A sprint is a period with a committed set, kept in one file, and its close records the carry-over

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** DR2's `sprints.md`, and section 3 of the shared design for the four absent capabilities

## Context

`status` printed `absent_features sprint board impediment relation` on every invocation.
Items already carried `sprint_id`, `backlog --sprint` filtered on it, `explain` printed it, and `next` weighted `spr 8` on it, while no command could check that the value named anything.
Guard `G4` reads "the item is in the active sprint, or on the board" and was handed `true` because neither existed.

The shared design fixes three things before this record starts: a sprint is not an item, it lives in one `sprints.md` in the record grammar the shards use, and committing an item that sits in another open sprint is refused.
What it leaves to this record are the judgement calls: what a close does to unfinished work, whether a sprint reopens, what a cancelled item does to the committed set, and what a date means.

## Decision

### Not an item, and not a state machine

A sprint is `open` or `closed`, and nothing else about it moves.
It has no gates, no severity and no review, so it does not go through the seven item states; giving it that machine would put it through states none of which mean anything for a period.
`src/domain/sprint.ts` is its dictionary and its rules, and `validateSprint` is the whole of what a record must satisfy.

### One file, the same grammar, its own index table

Every sprint is a record in `sprints.md` beside `items/` and `events/`, in the grammar `parseFile` already reads: `# <id>: <title>`, field lines, and the goal as a `## Goal` section.
A sprint spans months, so a month key would be a lie about it, and there are tens of sprints where there are tens of thousands of items, so the file is read whole.
Each record carries `type: sprint` beside `state`, `filed_at` and `version`, which are the four field lines the grammar's damaged-heading resynchroniser keys on, so a hand edit that reshapes a sprint heading is quarantined loudly exactly as an item's is.

The store fingerprints, indexes and quarantines it the way it does a shard: `sprints.md` is in the freshness pass, its rows live in a `sprints` table that carries the record text and the two columns the one read orders on, and a record the dictionary refuses is a finding at its line that hides it from every read.
`INDEX_FORMAT` moved from `4` to `5` for the table.
A sprint write goes through the same journal as the shard a commit touches, so a commit of three items and the events that record it land whole or not at all.

### The committed set is what points at the sprint, and the close writes the one thing that cannot be derived

An item carries `sprint_id`, so the set committed to an open sprint is the set of items that point at it.
Storing that list on the sprint record as well would be one fact in two places, and the two would diverge on the first hand edit.
`commit` and `uncommit` therefore write items and never the sprint, and `open`, `close` and `reopen` write the sprint and never an item.

The close writes `carried`, the ids of every committed item whose work was still open, in id order.
That list cannot be derived later: the items it names are committed onward to the next sprint and stop pointing back, and the number a team looks at is exactly the one that would then be gone.
After a close the committed set of a sprint is the union of what still points at it and what it carried, so `sprints <id>` answers "what did we commit, what did we finish, what did we not" whether or not the carried work has moved on.

### What closing does to work that did not finish

An unfinished item is left pointing at the closed sprint, and the sprint names it under `carried`.
Three shapes were possible.
Moving the items to the next sprint needs that sprint to exist at close time, which is the wrong order for a team that closes on Friday and plans on Monday, and it turns a one-record write into a write per item.
Unassigning them loses the last fact the item's own record held about where it was planned, and `backlog --sprint` would stop showing the work the sprint did not finish.
Leaving them where they are costs one write, keeps `backlog --sprint <closed>` honest about what the sprint held, and puts the question a reader asks on one line: `carried` on `sprints <id>`.

What stops the leftover from being mistaken for live planning is the ranking.
`next`'s `spr` component measures membership of an open sprint, and only an open one: an item left behind in a closed sprint scores `s0` until it is committed onward, which is what carry-over asks a team to do, and committing it to the next open sprint is allowed because the refusal is for a second *open* sprint.

### A sprint can be reopened, and the reopen clears what the close recorded

A sprint closed by mistake, or closed a day early, is corrected with `sprint reopen`, because the alternative is a hand edit that `doctor` then reports.
The reopen puts the record back to `open` and removes `closed_at` and `carried`; the carry-over is recomputed by the next close, and the reopen event carries the list it cleared, so the log keeps what the record no longer says.
Carried items that were committed onward in between stay where they went: an item is in one sprint, and the reopened sprint's committed set is whatever points at it now.

### A cancelled item stays in the committed set

Cancellation is finished work that stopped, not work that carries over.
The item keeps its `sprint_id`, so it stays in the committed set with its own state saying `cancelled`; `sprints <id>` counts it on its own line, and the close does not name it under `carried`.
A committed set that shrank on every cancellation would make the commitment meaningless as a record, which is the defect the shared design names.

### Dates are calendar days, read in UTC, inclusive at both ends

`start` and `end` are written `YYYY-MM-DD` and are refused unless they name a real day (`2026-02-30` is refused rather than read as the second of March, rule `I1`) and `end` is on or after `start`.
A sprint boundary is a planning fact, "Monday to the Friday after next", not an instant, and an instant would put the same start at 01:00 for one reader and 19:00 the previous day for another.
The day is read in UTC because every instant the store writes is UTC, and a `day` line that differed between two machines in two zones is the disagreement the rule exists to remove.
`day n/m` is 1 on `start` and `m` on `end`, both inclusive, and is not clamped: `day 16/12` is the fact a reader of an overrunning sprint needs, and `day 0/12` says the sprint starts tomorrow.
`--start` defaults to the UTC date of the clock; `--end` is required, because the length of a sprint is the one thing a tool cannot guess for a team.

### What may enter a sprint

Three refusals, each a rule id, all evaluated by `evaluateCommit` in the domain and applied by `sprint commit` and by `file --sprint`.

- `I2`: the sprint is closed. Its committed set is a record; the remedy is `reopen` or an open sprint.
- `I3`: the item sits in another open sprint. An item is in one sprint; the remedy is `uncommit` or closing the first.
- `I4`: the item cannot be worked, because it is `done` or `cancelled`, or because its ready gate fails. A sprint is where work is picked up, and the ready gate is the item's own definition of "can be picked up", so the same rule decides both; a draft story with no acceptance criterion can exist and can never enter a sprint, which the README promised before any of this was built.

`sprint_id` is owned by `sprint commit` in the field dictionary's `writerOf` table, so `set <id> sprint=` refuses with the owning command, as `severity` refuses with `mark`.
`file --sprint <id>` still works and is held to the same three rules, which narrows what the flag accepts: it stored any string before.
That is the one change here that `docs/STABILITY.md` counts as breaking, and it is recorded as such.
`uncommit` out of a closed sprint is `I2` too, because the way out of a closed sprint is into the next one.

### Guard G4 stays disarmed

`G4` reads "in the active sprint, or on the board", and only the sprint half exists.
Armed alone it would refuse `start` on every item in a workspace that runs no sprints, which is every workspace before this change and most after it.
It stays `true` in `transitionContextFor` until `board` can answer the other half; `board` follows this record and the hand-off is named in the code.

### Where a sprint reaches a read

- `sprints` lists every sprint with its dates and `done/committed` items and points; `sprints <id>` prints the record, the tally, `carried` and the goal.
- `status` prints an open sprint as a `sprints` block, last, with `day`, items and points; the block is absent when nothing is open, so the orientation call costs the same bytes it did.
- `history <sprint>` prints the sprint's own log, and the `what` column reads `state=open->closed,carried=(unset)->a,b` under the convention every op inherits.
- `doctor` and `explain` report `H26` for an item whose `sprint_id` names no sprint record, which no write path produces any more and a workspace written before this change may hold.
- `backlog --sprint` and `explain`'s `sprint` line are unchanged.

## Alternatives considered

### The committed list on the sprint record

Simpler to read and one more list to keep in step with fifty thousand records.
Refused as a fact in two places; the one list the record keeps is the one that has no other home.

### A sprint as an item type

It would have inherited the store, the index and every read for free, and it would have had a ready gate, a done gate, a severity column and a `blocked` line, none of which mean anything for a period.
The shared design refuses it and this record agrees.

### Close moves the unfinished items to the next sprint

Argued above: the wrong order for a team that closes before it plans, and a write per item where the record needs one.

### No reopen

A closed sprint would be a record nothing could correct, and the correction would then be a hand edit to a committed file that the doctor reports and the log does not explain.
One verb and one cleared list is cheaper than that.

## Consequences

Every figure is a cold process per sample, seven samples, both trees interleaved over their own copy of the 50,000-item corpus, on Node 24.11.1, with `process.resourceUsage().maxRSS` read by the child; the machine was at a 1-minute load of 17.15 before and 19.41 after, which does not move a peak-memory figure.

**Positive**

- The read every command performs did not move: `readWorkspace` at 50,000 items is 166,624 KiB before and 167,376 KiB after at the median, inside the base's own 165,568 to 169,568 spread over seven samples, and `get` is 101,312 against 101,424 KiB. The view holds the sprints whole, and a sprint record is a few lines.
- At the command surface through the bundle, the figure the read budget is judged on, `treadle show` at 50,000 items is 129,312 KiB before and 128,832 KiB after at the median of seven interleaved cold samples (before 128,368 to 129,712, after 127,904 to 130,224), read the same way from inside the process.
- `next`'s `spr` weight measures something: a ready item in an open sprint scores `s1`, and one in a closed sprint or in none scores `s0`.
- `status` no longer lists `sprint` under `absent_features`.

**Negative**

- The bundle grew from 260,395 to 298,925 bytes, against the 512,000 budget.
- `file --sprint` refuses what it used to store, which is the breaking change above.
- An index an older build wrote is dropped and re-derived on the first open, as every `INDEX_FORMAT` bump does.
- `readWorkspace` makes one more store call, `sprints()`, which is one query over a table of tens of rows.

**Neutral**

- A workspace with no `sprints.md` behaves as before; the freshness pass names the file and the stat skips it.

## Departures from the design record

- **DR2's `sprints.md` is written, and `impediments.md` and `ceremonies/` still are not.** ADR-0002 recorded all three as unwritten for want of a domain type; the sprint has one now, and the other two wait on their own records.
- **DR6's G4 is still not evaluated.** The design reads it as one guard over two facts; this record supplies one of the facts and refuses to arm half a guard.
- **The design gave the sprint no `carried` field.** It is this implementation's storage of the carry-over the shared design requires a close to record.

## What would reopen this

- A team running more than one open sprint that wants `status` to say which is theirs, which is a `--sprint` on `status` and not a change here.
- A sprint count that makes reading `sprints.md` whole cost a visible figure, which is about a thousand sprints and would be a `state` filter on the `sprints` table.
- `board`, which answers G4's other half and decides whether the guard is armed.
