# ADR-0018: The board is the backlog grouped by live state, scoped to the open sprint, and it stores nothing

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** section 4 of the shared design for the four absent capabilities

## Context

`status` printed `absent_features board impediment` after ADR-0016 landed sprints.
Guard `G3` reads a column's usage against its limit and guard `G4` reads "in the active sprint, or on the board", and both were handed values that made them pass because no board existed to read.
The shared design fixes three things before this record starts: a board is a projection that stores nothing, it is `backlog` grouped by state and takes every filter `backlog` takes, and it does not render side-by-side columns in a terminal, because five states across 80 cells is sixteen cells each and the product has already fixed one width defect.

What it leaves to this record are the judgement calls: what a board is for, which states get a column and in what order, what a blocked item looks like, and whether the default scope is the open sprint or the whole workspace.

## Decision

### What a board is for, which is not what a backlog is for

A backlog answers "what is there"; a board answers "where is the work stuck".
Grouping by state alone answers neither better than `backlog --state <s>` five times, so the board carries three things a backlog does not, and they are the whole of its reason to exist.

- A `blocked` column on every row, naming the active blockers of that row, derived from the relation graph ADR-0015 stores once.
- Blocked work first in every column, above priority order.
- A default scope of the one open sprint, so the board is the team's current work and not its history.

A reader of `board` learns which rows in each column cannot move and what holds each of them, without running `explain` per row.
That is thin if the workspace records no relations, and the record says so rather than padding: over a workspace with no `blocks` edges the board is the backlog in five sections, with one count per state that `status` already prints.
The second thing that thickens it is the impediment, which raises itself against work through the same `blocks` edge, so an impediment's row and the rows it holds up are on the same board.

### Five columns, in flow order, printed empty; the terminal states are counts

The columns are `draft`, `ready`, `in_progress`, `in_review` and `on_hold`, always, in that order.
An empty column is a fact a team acts on: nothing in review means nothing is about to finish, and nothing in progress on day three of a sprint is the alarm.
A column that appeared only when it held work would make those two facts invisible in exactly the situation that makes them worth seeing.

`done` and `cancelled` are counts on their own lines rather than columns.
Finished work is not stuck anywhere, and over the whole workspace it is the whole history: the corpus the rig measures holds tens of thousands of done items, and a column capped at nine of them says nothing.
Scoped to a sprint, `done n` beside the columns is the number `sprints <id>` also prints, and `backlog --state done --sprint <id>` lists it.

### A blocked row sorts first and names its blockers

Within a column the order is blocked first, then the backlog's own `priority,filed,id`, and the `sort` line says so.
The column is capped at `--limit` rows, and the rows a board reader came for are the ones that cannot move; under priority order a blocked item at priority 4 in a column of twelve would be past the cap and the board would answer its question with nothing.
The `blocked` cell carries the blocker ids, comma-joined, in the graph's order, which is the order `explain` prints them in.

The blocker itself is on the board: an active blocker is by definition not done or cancelled, so it is in one of the five columns of the unscoped board.
Scoped to a sprint it may be outside the scope, in which case the cell names it and `explain <id>` says the rest.
The cell does not carry the blocker's own type or severity, because that is the blocker's row, on this board or on `board --all`.

### The open sprint is the default scope

With no flag the board is the one open sprint, `scope <id> <state> day n/m` says so, and a `whole` line carries `treadle board --all` for the reader who wanted the workspace.
The alternative, the whole workspace by default, shows a team its history mixed with its current work, and `next` already weights membership of an open sprint for the same reason.

`--sprint <id>` is the backlog's own filter, so a closed sprint's board is what still points at it and `sprints <id>` carries what moved on; the two are the same set until the carry-over is committed onward, which is what ADR-0016 asks a team to do.
An id that names no sprint record and that no item's `sprint_id` carries is not a scope with a history to show, so it is `NOT_FOUND` `I5`, the same refusal `sprints <id>` gives, with the near ids beside it, rather than five empty columns; `noSprint` in `sprints.ts` is exported for this and reused rather than answered twice.
`--all` is the whole workspace even while a sprint runs.
`--all` with `--sprint` is refused with `C1` because the two ask different questions.
Two open sprints are refused with `C1` too, naming both and `--all` as the ways out: a tool that picked one would be guessing which team the caller is on.
No open sprint is the workspace, so a workspace that runs no sprints pays nothing for the default.

### One shape, five blocks, three renderings

Each column is a block property of the one `board/1` shape, in flow order, with the backlog's columns plus `blocked`.
That is what makes the human rendering grouped sections with a count per state, `ready  5 of 5` over a table, with no renderer change: a block already closes its group and carries its `shown` and `total`.
The agent rendering is the same rows under `~<state> <shown> <total>` headers, so the grouping key is the block name and a consumer that reads backlog rows reads board rows.
No renderer was touched, and the width contract the suite holds over every golden object at 40, 60, 80, 100 and 200 cells now holds over two board objects as well.

### `--limit` without `--cursor`

A board has five columns and no single order to resume from, so a cursor means nothing on it, while an uncapped column over 50,000 items is unusable.
The command inventory derives every flag verdict from attributes rather than from a per-command table, so the board adds one attribute, `capped`, that grants `--limit` alone; `--cursor` is refused by the matrix as it is on `show`.
The cap is per column, nine rows by default as `backlog`'s page is, and the block header carries the column's total; `backlog --state <s>` walks a column whole.

### Guards `G3` and `G4` stay disarmed

The board stores nothing, so there is no membership to lack and no column limit to be over.
`G4`'s "on the board" is therefore true of every item, and `G3`'s column is absent, which the domain reads as no limit.
Arming either takes a stored fact, a work-in-progress limit per column or a board membership, and that is workspace configuration, which is `config`, specified and not built.
`transitionContextFor` says this where it hands the guards their values.

## Alternatives considered

### A single block with a `state` column and a `columns` block of counts

One block would make the agent rendering a sorted backlog and leave the human rendering to group rows itself, which is renderer code the contract's width rule would then have to be re-proved over.
Five blocks of one shape are the grouped sections for free.

### Literal columns side by side

Refused by the shared design before this record, and the arithmetic holds: five columns at 80 cells leave 16 cells each, under the 16-cell floor at which the human renderer already stacks a title on its own line.

### Every state as a column, `done` and `cancelled` included

Simpler to state and useless over the workspace, where a `done` column capped at nine rows out of thousands is noise beside a count that says the same thing.

### An `overdue` column

The board could carry days overdue beside `blocked`; both are derived on read from what the view holds.
It is left out: `status` counts the overdue and names the unassigned ones under `H17`, `next` weights them, and a column nobody asked for costs every row's width.
Adding it is a column in `BOARD_COLUMNS` and one line in the row builder when a caller asks.

### A stored board with limits and membership

That is the design's `config` and would arm `G3` and `G4`.
The shared design refuses it for this record, and a projection that stores nothing is the one that is easiest to delete if a stored board replaces it.

## Consequences

**Positive**

- `status` no longer names `board` under `absent_features`.
- The read every command performs did not move: the rig's `workspace` operation at 50,000 items peaks at 166.5 MiB before and 166.8 MiB after, and the read budget's worst-of-four figure at 170,496 and 170,768 KiB, twenty cold samples each, two runs of `npm run bench -- --scales 1000,50000` taken one after the other on 2026-09-06 at 1-minute loads of 4.49 to 4.43 and 9.17 to 8.83. Axis A1 is 289 of 289 writers persisted and zero crashed on both.
- A blocked row is visible as such on a list surface for the first time; before this, `explain <id>` per item was the only way to find one.
- `backlog`'s column refusals are one function, `columnRefusal`, shared by both lists.
- The per-item blocker walk `activeBlockers` performs is done once for the whole graph in `activeBlockerIndex`, so the board is linear in items plus relations rather than their product.

**Negative**

- The bundle grew from 317,716 to 325,186 bytes against the 512,000 budget, and `help` gained a nineteenth command; the top-level page's six examples now tour `board` and no longer `set`.
- A board over 50,000 items costs what a backlog over them costs, because both are the one read every command performs plus a sort: peak RSS through the service in a cold process over the rig's 50,000-item corpus, five samples each, is 168,336 to 170,752 KiB for `board` (median 169,728) against 169,680 to 170,928 for `backlog` on the same tree (median 170,576) and 170,544 to 171,456 for `backlog` on the tree before it (median 171,088), measured 2026-09-06 while the rig's own run was loading the machine, which moves a time and not a peak.

**Neutral**

- The `absent_features` line is gone from the `status` shape, and `STATUS_SHAPE` is v2 with `schemas/status.v1.json` replaced by `schemas/status.v2.json`. This record originally kept it declared, on the ground that removing a property is a breaking change under `docs/STABILITY.md`; what that reasoning missed is that the key was never computed. It was the string literal `absent_features: 'board'` in the result builder, hand-edited by each of the four pull requests that landed relation, sprint, impediment and board, and this record's own change deleted the last write. A declared key nothing can write is a promise to every consumer that the tool does not keep, and there is nothing in a workspace to compute it from: every other key in the shape is a fact about the store the caller passed, and this one was a fact about the build, which `treadle --contract` and `help` already answer off the command inventory. Removing it is breaking and is treated as breaking, on the precedent #26 set for `backlog` v1 to v2: the shape's version moves, the old schema file goes, and `docs/STABILITY.md`'s pre-1.0 policy carries it in the release notes.

## Departures from the design record

- **DR6's `G3` and `G4` are still not evaluated.** The design reads a board as a place with columns that have limits; this record builds the projection and leaves both facts to `config`.
- **The design gave the board no `blocked` column and no blocked-first order.** Both are this implementation's answer to what a board is for.

## What would reopen this

- A caller asking for a work-in-progress limit, which is a stored fact and arms `G3`.
- A team running two open sprints that wants a default rather than a refusal, which is a `status --sprint` and a board that reads it.
- A workspace where the blocked-first order hides the priority order a reader wanted, which is a `--sort` on `backlog` and `board` both.
