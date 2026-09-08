# ADR-0028: A retrospective is a record of its own kind, frozen at the instant it happened

**Status:** Accepted
**Date:** 2026-09-08
**Implements:** section 2.7 of the domain model, under the captain decision `remaining-unbuilt-scope` and the decision `ceremony-set`

## Context

DR2 drew `ceremonies/YYYY-MM.md` and [ADR-0002](0002-storage-layout.md) recorded it as unwritten for want of a domain type.
The layout has carried an empty directory name ever since, and two of the doctor's remaining findings, `H31` and `H32`, wait on the record existing.

Two questions had to be answered, not one.
The design record asked only which ceremonies get a record and answered "standup and retro" by comparing the three ceremonies to each other.
The prior question is whether a ceremony record earns its place in a tool where an agent reads the board, and asking it changes the answer.

A standup answers what changed, what is next, and what is blocked.
`history` is what changed, `next` and `board` are what is next, and `explain` names what is blocked and by which item, with impediments doing the blocking through a real edge rather than through prose.
A standup record would be prose duplicating four live surfaces, validated by nothing and read back by nothing, going stale the moment the board moves.
A review record is the same defect in a different place: an item reaching `done` through its gates is the acceptance, and a second record of it is a second place the two can disagree.

A retrospective is the one that survives the question.
What went badly and what the team will change is a judgement about the process, and no transition, event or projection reconstructs it at any cost.
It also produces something the store can hold honestly: the actions are chores, chores are work items, and a record that names the items it produced is a link the tool can keep true rather than prose it merely stores.

## Decision

**A retrospective is a record kind of its own, the third after the item and the sprint, and it is the only ceremony that gets one.**

The precedent that holds is [ADR-0016](0016-sprints.md), not [ADR-0017](0017-an-impediment-is-a-type-that-blocks.md).
The test both applied is whether the thing is work someone does, moving through the seven states, with `done` meaning something.
An impediment is: someone resolves it, it has an assignee and an estimate and a sprint.
A retrospective is not.
It is never `in_progress`, it has no ready gate and no done gate, nothing estimates or assigns it, `next` would have nothing to rank and the board nothing to show, and the one thing that made the impediment cheap as a type, holding work up through an edge every item already has, has no analogue: a retrospective holds nothing up.
As a type it would cost what ADR-0010 priced for an eighth state: every read in the tool would grow a `type != retro` clause.

The record lives in `ceremonies/YYYY-MM.md`, sharded by the month of `filed_at` exactly as items are, because DR2 drew that file and ADR-0002 says the layout still covers it.
It carries `type: retro` and `state: recorded` as constants, `filed_at`, `version`, an optional `sprint_id`, an optional `actions` list, and the two prose halves as the `Went well` and `Went badly` sections.
`type` and `state` are constants rather than omissions: the grammar's damaged-heading resynchroniser keys on four mandatory field lines, and relaxing that per record kind is a change to the one rule that closed axis A5.
The sprint record pays the same price with `type: sprint`.

A retrospective's actions are chores filed in the same transaction and named once, on the retrospective.
Relations target items only (`P4`), and one fact in two places is the shape every record here refuses.
`S17`'s referrer set therefore gains a fourth entry, a retrospective's action list, so removing such a chore is refused under the rule that already refuses removing a closed sprint's member.
The write that introduces an action naming nothing is refused too, with `S10`, which is `parentMissing`'s shape from the other side; an action id the stored record already carries is `H32` for `doctor` to report rather than a refusal, for the reason ADR-0025 gives about `H30`.

Ids share the one namespace with items and sprints.
`file`, `sprint open` and `slugFor` all treat a ceremony id as taken, `notFound` and `noSprint` route one, and `history <id>` answers from the log for it, by the mechanisms ADR-0022 and ADR-0023 built for sprint ids.
The log is keyed by entity id alone, so two kinds sharing an id would share their trail.

`ceremonies [<id>]` reads, and the verb that files one is `ceremony retro`, which is the `sprint`/`sprints` split the inventory already uses.

## Alternatives considered

**An eighth work-item type.** Refused: every read would need to exclude it, and the property that made the impediment cheap as a type has no analogue here.

**A ceremony family with three kinds, or one kind and room for two more.** Refused, and this is the decision that shaped the code.
Building a general ceremony abstraction with one implementation is the speculative shape this codebase refuses everywhere else.
There is no `CeremonyType` union with one member, no `kind` discriminator, and no dispatch on it: `type: retro` is a constant in the codec exactly as `type: sprint` is.
If a standup record is ever wanted for a team that does not read boards, it is a task on top of this one, and its design will be better for having one real case first.

**Reading the retro-to-chore link off the record's `actions` field under the write lock.** Refused on cost.
`S17` runs on every removal inside the critical section, and that read is a scan that decodes every ceremony in the store.
The link is stored as its own `ceremony_actions` rows with an index on the item, which makes it the lookup `items_parent` already serves for the parent edge.

**Refusing a retrospective whose action list names a record the store no longer holds, on every write.** Refused for ADR-0025's reason: it would refuse the remedy along with the defect, since the fix for a dangling action is itself a write to that record.

## Consequences

A third record kind in both store implementations under the one conformance suite, and `--dry-run` refuses what the real write would.
`INDEX_FORMAT` moves to 7, which drops and re-derives the index rather than migrating it; the index is a cache, so dropping it is the cheapest correct answer.
`Finding.kind` gains `ceremony`, derived from the file the finding was read out of, and a damaged ceremony record therefore hides content: it is quarantined at its line and `readWorkspace` refuses over it with `S1`, which is what every command does over a hole in any other record file.
`LAYOUT` gains `ceremonies`, so a symbolic link there is `S15` before anything under it is opened.

Every command now reads the ceremony set, as it already reads the sprint set, because the id namespace is resolved against all three kinds.
That is the cost ADR-0016 accepted for sprints and it is accepted here on the same evidence: a retrospective is filed once a sprint, so the set is tens of records against tens of thousands of items.
A workspace that files retrospectives far more often than it opens sprints would make this a per-month query rather than a whole read, and the layout is already sharded for it.

The write path does not widen the lock.
A ceremony write takes the same shard read, the same compare-and-set and the same journal an item write takes, and the fourth referrer is one indexed lookup inside the critical section that already ran three.

## Departures from the design record

The design record recommended standup and retro and drafted an ADR for a three-kind `ceremony` type.
That recommendation is superseded by the decision `ceremony-set`, and the departure is the whole shape of the record: one kind, no family, no `type` union.

`plan` and `refine` produce no record either, and that part of the design record stands: `plan` became `sprint commit` in ADR-0016, and `refine` is `gate ready` over a scope.

The draft numbered itself ADR-0026. That number was taken by workspace configuration while this work was queued behind it, so this record carries the next free number instead.

## What would reopen this

A retrospective that acquires a lifecycle, such as an action list a team wants to move through states as one thing rather than as chores.

A measurement showing the whole-set read costing something a real workspace notices, which turns the read into a query over the shard the caller asked for.
