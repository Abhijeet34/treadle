# ADR-0029: The record is the product, and the agile surface around it is removed

**Status:** Accepted
**Date:** 2026-09-08
**Implements:** the captain's statement of purpose, under the decision `cut-the-agile-surface`
**Supersedes:** [ADR-0016](0016-sprints.md), [ADR-0018](0018-the-board-is-a-projection.md), [ADR-0022](0022-a-closed-sprint-is-a-record-and-four-narrow-rules.md), [ADR-0023](0023-a-closed-sprints-member-set-is-frozen-with-its-tally.md), [ADR-0028](0028-a-retrospective-is-a-record-of-its-own-kind.md), and the point-scale key of [ADR-0026](0026-workspace-configuration-is-the-policy-seams-second-implementation.md)

## Context

Six records above this one built a sprint, a board, a retrospective and an estimate, and each of them was argued well against the record before it.
None of them was argued against what the tool is for, because that had not been written down.

It has been now, and it is narrower than what was built:

> Our goal is not to create a rally or kanban board, but on similar concept a tool which helps user-agent interactions, decisions, tasks be recorded properly at a place and not be lost during work, agents to drive and steer the records as in needed with human in feedback loop.

Read against that sentence, the four surfaces are the same feature four times over: each computes something about the work that the work itself does not say.
A sprint is a time box and a tally. Story points are a number nothing enforces. A board is a projection of state. A retrospective is a ceremony.
None of them records an interaction, a decision or a task, and none of them helps an agent steer or a human review.

Every one of them also cost something to keep.
`sprints.md` was a second record kind with its own codec, its own index table, its own compare-and-set path and its own five referential rules; the retrospective was a third, with two more.
`board` was a fourth read over the same records `backlog` already reads.
The point scale was a workspace-configurable bound with a live defect behind it, recorded below.

The audit that measured this is `treadle-shape-and-use-review-c9`, and the captain chose "cut all of it" over three narrower options on 2026-09-08.

## Decision

**What ships is the record and the rules around it. Everything that computed a figure over the records rather than recording one is removed.**

Removed, with what each was:

| Removed | What it was | What replaces it |
|---|---|---|
| `sprint`, `sprints`, the `sprints.md` record kind, `sprint_id`, `carried`, `finished`, rules `I1` to `I5`, guard `G4`, `H26`, `H28`, `H29`, `next`'s `spr` weight, `status`'s sprints block, `backlog --sprint`, `start_requires_sprint` | a time box with a committed set and a frozen tally | nothing; a label on a record says the same thing without a second record kind to keep true |
| `ceremonies`, the `ceremonies/YYYY-MM.md` record kind, `CeremonyWrite`, the `S3` and `S10` clauses it needed, `S17`'s fourth referrer | a retrospective record no command ever wrote | nothing; no writer existed |
| `board` | the backlog grouped by live state, scoped to the open sprint | `backlog --state <s>`, and the `blocked` column `backlog` gains next |
| `points`, `hours_estimate`, `timebox_hours`, `point_scale`, `DOR5`, `status`'s `points` and `done_points`, the `pts` column, `file --points` | an estimate nothing enforced and a scale that could refuse a record already written | nothing |
| `component` | a one-value label | `labels` |
| `--preview`, `--color`, `--no-input` | a mode that evaluated nothing, a flag no renderer read, a flag no prompt read | `--dry-run` for the first; the other two did nothing |
| `cycle_time_excludes_hold` | a configuration key with no reader | nothing |
| `T2`, the `T3` `held_from` branch, `Store.list` and its implementations, seven test-only exports | code no input could reach | nothing |

What is not removed is everything that records something: the seven work-item types and their required fields, the lifecycle and its remaining guards, the ready and done gates and the configuration that steers them, the review step and its evidence, holds and resolutions and reasons, relations, the event log and `history --txn`, `next`, `explain`, `doctor`, `remove`, and the whole store.

**A record written before this build keeps its retired fields, and reads.**
The item codec already carried an unknown field key into `extra` and wrote it back unchanged (DR3), and `sprint_id`, `points`, `hours_estimate`, `timebox_hours` and `component` become unknown keys the moment they leave the dictionary.
So a workspace written by the build before this one loads, serves and round-trips every one of them; `show` reports them as an `extra` count rather than printing values this build cannot validate, and the next write to that record carries them forward.
That is the file-format promise in docs/STABILITY.md kept by the mechanism that was already there, and it is what makes a removal of five fields a change no workspace has to migrate for.
treadle's own `.work` store is not exempt from this: its records were filed before this build and keep `points` as a retired key for exactly this reason, the same `extra` path a stranger's workspace takes.

**`I5` becomes `V9`.** Four of the five `I` rules were the sprint's and went with it, and the fifth was never about sprints: it is the rule that an id names one thing, which `file` raises for a taken id and `history --txn` raises for an event id given where a transaction was wanted. Both branches survive the cut, so the rule moves into the `V` namespace `docs/DOMAIN.md` already owns rather than being the last inhabitant of a namespace that is otherwise empty.

**Every result shape that lost a key gains a version.**
Fourteen schemas move: `backlog` to v3, `status` to v3, and `config`, `evidence`, `explain`, `file`, `init`, `mark`, `next`, `relation`, `remove`, `set`, `show` and `transition` to v2.
docs/STABILITY.md makes removing a field from a result object breaking, and pre-1.0 that is a minor bump with a release note rather than a reason not to do it.

## Consequences

The bundle is 367,388 bytes against 476,647 before, measured by `npm run build` on the same tree: 109,259 bytes, 22.9 percent of the product, for capability the purpose does not ask for.
Seven source files, four schemas and six test files leave the tree entirely.

Four things a caller could do are gone and are not coming back under another name: a time box, a velocity tally, a state-grouped overview in one call, and an estimate.
The last of them was already the weakest: `points` was validated against a scale and read by exactly one gate rule and one sort column, and no guard, gate or refusal anywhere else in the tool consulted it.

`git` holds all of it. If the purpose changes, the argument in the six superseded records is still the argument, and the code is one `git show` away.

### The two live defects this closes

Neither is fixed. Both are answered by the surface not existing.

`treadle config set point_scale "1, 2"` made every later write to every item off the new scale fail `V4`, and neither `doctor` nor `explain` said why: the write path applied the scale and the load path did not, so a record the tool had written became one it refused to write again. The key is gone, so the sequence cannot be typed.

`treadle ceremonies` read a record kind no command in the build could write. The command is gone.

### What the cut costs the benchmark

Axis A2 puts a fixed 25-question set to the command surface, and five of those questions were answered or part-answered by a sprint or a board.
They score `none` now, each with a note saying the capability was removed and why, which is the axis's own convention for a question the inventory can offer nothing for.
That is a real drop in a measured number, and it is the honest one: the tool answers fewer scrum-master questions because it is not a scrum tool.

### Departures from the design record

The design records DR2 and DR5 name `sprints.md`, `ceremonies/YYYY-MM.md`, a board layout and a points field.
This record departs from all four, and from the interface specification's flag matrix by three flags.
The design was written before the purpose was, which is the whole of the reason.

`ADR-0002`'s storage layout is unchanged for the files that remain: month-sharded items, an append-only log, a derived index. What leaves is two of the four things it drew.
