# ADR-0017: An impediment is a work-item type that blocks, required to say what would clear it

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** section 2 of the capability contract for the four absent features

## Context

`status` printed `absent_features sprint board impediment`, the done gate carried `DOD2`, "no impediment is still open against the item", and nothing could ever make it fail: `openImpediments` was a hard-coded zero and `test/domain/gate-remedies.test.ts` declared the check unbuildable.
The store's own commentary in `blockersOf` said impediments were "the caller's to add".
ADR-0015 landed the `blocks` edge, the `G2` refusal it feeds and the `dep` component of `next`, and left the impediment as the first thing to block through it.

Four questions had to be answered, and the contract fixed the shape of the first two.
What an impediment is, and what it must carry when raised.
What resolving one does to the work it held up.
Whether one may block another.
Whether one belongs in a sprint, which is landing beside this record.

## Decision

### A seventh type, on the same machine, where `done` means resolved

`impediment` joins `WORK_ITEM_TYPES`.
It flows through the seven states every item has, and reaching `done` is what resolving it means.
A second state machine for one type was refused for the reason ADR-0010 refused four new states for a resolution and an outcome: every guard, gate, ranking and read would have needed a second code path or a special case, and the one thing an impediment does differently, holding other work up, is a relation and not a state.

It owns two fields and requires both at creation, the way a bug requires `severity`, `repro_steps` and `found_in`: `severity` from the same closed set a bug uses, and `proposed_resolution`, a paragraph of up to 1,000 characters saying what would clear it.
The captain's recorded decision on this capability is that the proposed resolution is what makes an impediment worth filing.
Filing one without it is refused with `V4`, `an impediment needs proposed_resolution at creation`, exit 2.
`severity` is written by `mark` afterwards, as a bug's is; `proposed_resolution` is `set`'s, so it can be revised, and `history` reads the revision as `proposed_resolution=(text:76)->(text:27)` under the convention every prose field has.

It has no review step, so `in_progress` exits through `finish` straight to `done`: what attests the resolution is the blocked work moving, which is the next section.
It is in no `ALLOWED_PARENT_PAIRS` entry, because it is raised against work through `blocks` rather than nested under it.

### It earns its keep through `blocks`, and one that blocks nothing is a finding

An impediment holds work up through the one edge ADR-0015 built: `relation add <impediment> blocks <id>`, stored on the impediment's own record.
No second mechanism exists.
`G2` refuses starting the blocked item, `DOR3` fails its ready gate with the impediment's next move toward `done` as the remedy, `next` leaves it out and names the impediment on `--explain-absence`, and `explain` prints `blocked yes <impediment>`.
All of that was true of any blocker before this record.

The remedy was first written as `treadle transition <impediment> done`, and that line is refused by `T1` from `draft`, `ready`, `in_review` and `on_hold`, which is every state a fresh impediment is in.
It now names the one move the table allows from where the impediment stands, `ready` from `draft`, `in_progress` from `ready`, `done` from `in_progress` and `resume` from a hold, so each refusal hands the reader the next runnable line and the sequence reaches `done` by running them.
`nextTowardDone` in `src/domain/state-machine.ts` reads that move off the transition table, and `test/cli/runnable-lines.test.ts` runs every emitted line from the state that emitted it.

What the type adds is `DOD2`, fed for the first time: the active blockers of an item that are impediments are what the done gate reads, so an impediment raised against work already in progress holds that work from `done` until it is resolved, with the same remedy.
`DOR3` is not evaluated on the done gate, which is why the rule is kept beside it rather than folded into it.

An impediment in any open state whose record carries no `blocks` edge is doctor finding `H27`, on `doctor` and on `explain` of the impediment, and its detail names `treadle relation add <id> blocks <id>` as the line that raises it against something.
The contract's words were "explain should say so plainly", and a finding is how this tool says something plainly: it needs no new result key and it carries its own remedy.
A resolved or cancelled impediment that blocks nothing is history and is not reported.
ADR-0022 later narrowed `H27` off a `draft` impediment as well, once `DOR9` could refuse the same fact at grooming instead.

### Resolving one changes nothing on disk, and the work it held becomes workable

When an impediment reaches `done`, no record is rewritten and no edge is dropped.
`blockersOf` has always treated a terminal blocker as inactive, so on the next read the blocked item's `blocked` line goes to `no`, `DOR3` and `DOD2` pass, `G2` lets it start, and `next` ranks it.
A person remembers nothing: the story that was refused at `ready` with the impediment named moves on the next `transition` after the impediment is done, and the live run under `test/services/impediment.test.ts` proves that sequence end to end.

The edge stays, and `show` on either record still lists it, `blocks <id>` on the impediment and `blocked_by <impediment>` on the work.
That is the record of what was raised against what, and it is what makes `reopen` honest: an impediment reopened because its resolution turned out to be wrong re-blocks the work at once, because nothing was unlinked.
Dissolving the edge on resolution was priced and refused: it would need a write to a second record on every resolution, which is the two-places-for-one-truth shape ADR-0015 refused, and it would make a reopened impediment block nothing.

Cancelling an impediment while work waits on it is `G7`'s refusal, which yields to an override with a reason, as for any blocker.

### An impediment may block an impediment

Real ones nest: the certificate cannot be renewed until legal countersigns the vendor's renewal.
The graph is one graph, `R2` already refuses a cycle naming the path and `R3` bounds the depth at 64, so allowing it costs no rule and refusing it would need a type check in `relation add` that no rule of the domain asks for.
What a chain does is what ADR-0015 said a chain does: the story sees its direct blocker, the inner impediment is itself blocked and left out of `next`, and the outermost one ranks with `d1`, so the chain is freed one link at a time from the end that can be worked.

### Its severity reaches the ranking on the impediment's own row

The contract asked that an S1 impediment blocking a story be a stronger signal than an S4 one, and named the `dep` component as where that lands.
`dep` is not extended, and the reason is that the blocked story is never ranked: `next` leaves out an item with an active blocker because `G2` would refuse the start the list invites, so no component on the story's row can carry the signal.
The row that can is the impediment's own, once it is `ready`, and both components it needs are already there: `v` is its severity and `d` is the number of active items it holds up.
Measured in the live run, an S3 impediment blocking one item scores 17, `d1` at weight 5 plus `v2` at weight 6, and an S1 blocking one item scores 29, so the S1 outranks the S3 by 12 points and resolving it is what the list puts first.
Weighting `d` by the blocker's severity as well would count `v` twice on one row.

### It may belong to a sprint

Nothing refuses `sprint_id` on an impediment, and that is the decision rather than an omission.
Resolving one is work someone does, with an assignee and an estimate, so it is committed to a sprint the way a task is; the `spr` weight then lifts it as it lifts any committed item, which is right, because an impediment the team committed to clearing is the one it said it would clear.
When a sprint closes with the impediment unresolved it carries over, and that carry-over is exactly the number the sprint work says a team looks at.
The sprint capability is landing beside this record and nothing here reads its files; `G4` reads membership through the same `iterationMember` input it always had.

### `proposed_resolution` is read back in three places

This project has twice shipped a field that could be written and never read, and `test/architecture/field-visibility.test.ts` now holds every field to a surface.
`proposed_resolution` prints on `show <id>` cut at 64 cells, whole under `show <id> --field proposed_resolution`, and the refusal a caller meets when they try to start blocked work names that command: a `G2` refusal on an item an impediment blocks carries `fix treadle show <impediment> --field proposed_resolution` as its first fix line, before the override.
The refusal is where a person wants it read back, because that is the moment they are deciding whether to resolve the impediment or work around it.

### A refusal on `G1` or `G6` hands over the gate's own remedies

`transition <story> ready` on blocked work was refused with `the ready gate fails: DOR3` and one fix line, `treadle explain <story>`, and the impediment was named only at the end of that second command.
The gate rules' remedies are command lines, which `test/domain/gate-remedies.test.ts` holds, so a refusal on `G1` or `G6` now carries them as fix lines ahead of `explain`: the story is refused at `ready` with `fix treadle transition cert-expired ready` on the refusal itself, the impediment being in `draft`.
Every other guard's remedy is a command line too, and the refusal prints the first failed guard's: a story leaving `in_progress` for `done` fails `G5` and carries `fix treadle transition <story> in_review`, which used to be prose inside the cause and on no fix line.
That is error prose and a fix list, which `docs/STABILITY.md` names as not breaking.

### `status` no longer lists `impediment` as absent

`absent_features` is `board`.

## Alternatives considered

### A `blocked` state, or a state machine of its own

Refused above.
ADR-0010's pricing of an eighth state stands: eight edges, every guard and every read touched, for a nuance the relation graph already carries.

### Dissolving the edge when the impediment is resolved

Refused above: a write to a second record on every resolution, and a reopened impediment that blocks nothing.

### A `--blocks <id>` flag on `file`

Raising an impediment is two commands, `file` and `relation add`, and between them `doctor` once reported `H27` until ADR-0022 narrowed the finding off a `draft` impediment.
One command would be kinder, and it was not done because `relation.ts` is the one writer of the `relations` field (ADR-0015) and a second writer inside `file` is the shape that rule exists to refuse.
It reopens when the two-command shape is measured to cost something a caller notices.

### Weighting `dep` by the blocker's severity

Refused above: it double-counts on the one row that carries the signal.

## Consequences

- `impediment` joins the closed type set, with `severity` and `proposed_resolution` required at creation; `proposed_resolution` is a `## Proposed resolution` section on the record.
- `GateContext.blockers` carries each blocker's type, state and review step as a `GateItem`, `DOD2` reads the impediments among them, and its remedy is the impediment's next move toward `done`, never a move the table refuses from where it stands.
- `H27` joins the doctor's finding ids.
- `show` gains a `proposed_resolution` text property, placed after `findings` and before the `evidence` block, which is where every text the field sweep appended went.
- A `G1` or `G6` refusal carries the failing gate rules' remedies as fix lines, and a `G2` refusal on work an impediment blocks carries `treadle show <impediment> --field proposed_resolution`.
- The view every command reads is unchanged in shape: `type`, `severity` and `relations` were already summary columns, and `proposed_resolution` is read on demand by `wholeItem`, so no `INDEX_FORMAT` bump and no new column (ADR-0014).

## Departures from the design record

The domain model's impediment was an entity of its own beside sprints and ceremonies, with a store file of its own, `impediments.md`, which ADR-0002 recorded as not written.
It is a work-item type in the month shards instead, because everything an impediment needs, an id, a state, a severity, an assignee, a sprint, an event log and a `blocks` edge, is what a work item already has, and a second entity would have needed a second store, a second read path and a second place for `blocked` to be derived from.

## What would reopen this

A team for whom `file` then `relation add` is measured to lose impediments between the two commands, which is the `--blocks` flag above.
A workspace whose impediment chains are deep enough that ranking the outermost one first is wrong, which would be a measurement on a real backlog.
A second type that needs a field required at creation and a finding when it stands alone, which would be the moment to name that pattern rather than repeat it.
