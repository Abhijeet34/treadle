# The domain core

Everything in `src/domain`, and the rule ids its errors name.
Every entry here has a test; nothing lands in this layer without one.

## What it is

Pure functions over values.
No filesystem, no clock, no randomness, no process.
An instant is an argument, a derived fact is an argument, and the caller applies the outcome.
`test/architecture/layering.test.ts` enforces that.

Every fallible function returns a `Result<T>`, which is `{ ok: true, value }` or `{ ok: false, error }`.
A refusal is a value, not an exception, so a caller branches on it.

## Errors

A `DomainError` carries a `code`, a `rule`, a one-sentence `message` naming the entity and the observed value, and the `entities` involved.
The three codes are the ones the output contract maps to an exit status.

| Code | Meaning |
|---|---|
| `VALIDATION` | The input is invalid: a field, a target, an override that is not allowed |
| `GUARD_REFUSED` | A lifecycle rule or a graph rule refused the write |
| `INTEGRITY` | The stored data contradicts itself, which a hand edit or a merge can cause |

## Rule ids

An error names a rule so a caller looks it up instead of parsing the sentence.
The set is closed.

| Id | Rule |
|---|---|
| `G1` | The ready gate passes |
| `G2` | The item is not blocked |
| `G3` | The target column's work-in-progress limit is not exceeded |
| `G4` | The item is in the active sprint, or on the board |
| `G5` | The type's review step decides whether `submit` or `finish` is the legal exit from `in_progress`; `story`, `bug` and `epic` have one |
| `G6` | The done gate passes |
| `G7` | Nothing active is blocked by this one |
| `G8` | An epic reaches `done` only once every child is done or cancelled |
| `T1` | No transition exists on this edge |
| `T2` | The target is not a state |
| `T3` | `on_hold` restores only the state it was held from |
| `T4` | A transition or an override that records a reason was given none |
| `T5` | An override names a guard the edge does not evaluate, or one that cannot be overridden |
| `T6` | An edge that records a closed-set value was given none, one outside the set, or one it does not own |
| `T7` | A reason is longer than `MAX_REASON`, which is 500 characters |
| `R1` | An item cannot relate to itself |
| `R2` | The edge would close a cycle in a directional relation kind |
| `R3` | The relation traversal hit its depth ceiling |
| `R4` | An item already duplicates another, and a duplicate has one original |
| `P1` | The parent and child types are not an allowed pair |
| `P2` | The parent edge would close a cycle, or the stored hierarchy already contains one |
| `P3` | The hierarchy traversal hit its depth ceiling |
| `P4` | The id is not an item in this workspace |
| `I1` | A sprint date is not a calendar day written `YYYY-MM-DD`, or the end is before the start |
| `I2` | The sprint is closed, and a closed sprint's committed set is a record |
| `I3` | The item is committed to another open sprint; an item is in one sprint |
| `I4` | The item cannot enter a sprint: it is done or cancelled, or its ready gate fails |
| `I5` | The id is not a sprint in this workspace, or would name both a sprint and an item |
| `V1` | A field key does not match the record grammar |
| `V2` | A field key names a JavaScript prototype slot |
| `V3` | A field key appears twice in one record |
| `V4` | A required field is missing, or a field value fails its validation |
| `V5` | A field is present that this type does not own |
| `V6` | A gate rule reads a field the scoped type does not have |
| `V7` | A gate uses one rule id twice |

`G8` is this implementation's number for a rule the domain model states without numbering: "an epic cannot reach done while any child is not done or cancelled".
The model's second epic rule, that an epic enters `in_progress` when its first child starts, is an effect rather than a guard and belongs to the application layer.

## Types and the required-field policy

`WORK_ITEM_TYPES` is closed: `epic`, `story`, `task`, `bug`, `spike`, `chore`, `impediment`.

| Type | Required at creation | Fields the type owns beyond the common set |
|---|---|---|
| `epic` | `outcome` | `outcome` |
| `story` | none | `acceptance_criteria` |
| `task` | none | none |
| `bug` | `severity`, `repro_steps`, `found_in` | `severity`, `repro_steps`, `expected`, `actual`, `found_in`, `fix_confirmed` |
| `spike` | `question`, `timebox_hours` | `question`, `timebox_hours`, `findings` |
| `chore` | none | none |
| `impediment` | `severity`, `proposed_resolution` | `severity`, `proposed_resolution` |

A `story`, a `bug` and an `epic` have a review step, and no other type does.
That one setting decides `G5`, which is why `in_progress` exits through `in_review` for those three and straight to `done` for a `task`, a `spike`, a `chore` and an `impediment`, and it also scopes `DOD3` and `DOD7`.
`treadle help transition` names the set, and `treadle explain <id>` lists only the moves the item's own type allows.

An impediment is a blocker as a record of its own: it flows through the same seven states, `done` means resolved, and it holds work up through the `blocks` relation like any other item.
`proposed_resolution` is required because raising one obliges the raiser to say what would clear it; [architecture/adr/0017-an-impediment-is-a-type-that-blocks.md](architecture/adr/0017-an-impediment-is-a-type-that-blocks.md) carries the four decisions around it.

Two of the common fields are conditional rather than free.
`due` is an optional instant on every type, and `resolution` is legal only while the state is `cancelled`; a record carrying one in any other state is `V4`.

A field `set` writes is cleared by an empty value: `set <id> parent_id=` removes the parent, and `set <id> parent_id= assignee=` is one write and one event, with each side recorded as `(unset)` in `history`.
The empty value is the clearing syntax because no field in the dictionary accepts it, so it can never collide with a stored value the way a sentinel such as `-` would on a prose field, and because `labels=` already read as an empty list.
`title` and the fields the type requires at creation refuse it as `V4`, naming the write that fills them.
A field another command owns is cleared by that command: `sprint uncommit` clears `sprint_id`, and a transition off `on_hold` clears the three hold fields.
`file` reads an empty value as the field left unset, so `--set assignee=` files without one and `--set severity=` on a bug is the same `V4` as leaving it off.
`help set` carries the rule as its last example.

`requiredAtCreation(type)` returns the first column and `fieldsOf(type)` returns the common set plus the second.
`validateWorkItem(item, { now, pointScale })` checks both, plus every field's own validation from the field dictionary.
`now` is an argument because a hold expiry has to be in the future and this layer does not read a clock.
`pointScale` is workspace configuration and defaults to `1, 2, 3, 5, 8, 13`.
`storedProse` is set by the store and by nothing else: `description` was narrowed from 100,000 characters to `MAX_DESCRIPTION` after files existed, and applying a write bound on the load path would make a record an earlier version wrote unreadable, which [STABILITY.md](STABILITY.md) says the file format never does.
On that path the store's S5 section ceiling is the bound and a stored value over `MAX_DESCRIPTION` is doctor finding `H18`.

### The bounded fields, and where each number comes from

| Constant | Value | Why that number |
|---|---|---|
| `MAX_DESCRIPTION` | 10,000 characters | Threat-model finding F10's reading of the dictionary; a 30-line description already produced a 41-line diff, and the shard is what a reviewer reads |
| `MAX_REASON` | 500 characters | `hold_reason`'s own bound, so the two reasons in this tool are the same size |
| `MAX_EVIDENCE_ENTRIES` | 20 | About 800 bytes on `show`, which is one `backlog` page, so a fully evidenced item still reads in one screen |
| `MAX_EVIDENCE_REF` | 200 characters, no space | A hash, a path, a run id or a URL; a ref with a space is a sentence wearing a pointer's name |
| `MAX_EVIDENCE_LABEL` | 120 characters | One line naming which of those the ref is, and never the place the explanation goes |

A bound that refuses names the field, the observed length, the limit and the difference.
Nothing here truncates.

A required text field that is only whitespace is refused at write time, because a paragraph that says nothing is not a value: `proposed_resolution is only whitespace, and a text says something or is left unset` is `V4`, checked wherever `text(name, max)` is the field's check.
It is write-time only, the same `storedProse` distinction every narrowed bound here uses, so a value an earlier version stored is still servable.

### Evidence

`EVIDENCE_KINDS` is closed: `commit`, `pr`, `run`, `test`, `file`, `url`, `report`.
An `EvidencePointer` is a `kind`, a `ref` and an optional `label`, and `evidence` is a list of them on every work item.
It is a pointer at an artefact that lives elsewhere, never the artefact, because the store is committed to git and a screenshot in a shard is a binary in a text repository.
[architecture/adr/0011-evidence-and-the-severity-audit.md](architecture/adr/0011-evidence-and-the-severity-audit.md) carries the argument.

Readiness and doneness requirements are not here: they live in the gates, because the model's own design is that the gate is what makes a type's fields bite.

## The lifecycle

Seven states: `draft`, `ready`, `in_progress`, `in_review`, `done`, `on_hold`, `cancelled`.
Blocked is not one of them.
It is derived from the relation graph and shown beside the state, never in place of it.

`TRANSITION_TABLE` holds twenty-three edges: the twenty-two the model draws, and `release`.

`release` runs from `in_progress` back to `ready`, requires a reason, and evaluates no guard.
It is the exit an attempt that ended without the work being done had nowhere to record: a hold leaves `next`, which ranks `ready` only, and a cancel leaves the board.
The item returns to the queue and the event carries `outcome`, one of `failed` or `yielded`.

Two edges record a value from a closed set, and `T6` is the one rule over both.
`cancel` requires a `resolution` from `wont_do`, `duplicate`, `superseded`, `cannot_reproduce`, `rejected`, and stores it on the record; `release` requires an `outcome` from `failed`, `yielded`, and stores it only in the event.
Every other edge refuses either.
[architecture/adr/0010-terminal-outcomes-dates-and-reviewability.md](architecture/adr/0010-terminal-outcomes-dates-and-reviewability.md) carries why this is not four new states.
`evaluateTransition(context, request)` returns one of three outcomes.

- `already` when the request names the state the item is already in. Nothing is written and no event is produced.
- `allowed` with the transition name, the resolved target and every guard result. A guard result carries the value it saw (`4/5` for a column limit), not merely its verdict.
- `refused` with a `DomainError` naming the first failing rule, a message listing every failure, and the full guard list.

`legalTargetsFrom(item)` lists the states this particular item may move to now, with `resume` resolved against `held_from`.

`resume` is not a state.
It restores the state the item was held from, so an `on_hold` item's only non-terminal target is that state; asking for any other is `T3`.
The model names `hold_reason` and `hold_until` and does not name a field to keep the held-from state in, so `held_from` is this implementation's storage of the rule.

G2, G3 and G7 yield to an explicit override that carries a reason.
G1, G4, G5, G6 and G8 never do: the answer there is to fix the item.

## Hierarchy

One parent per item, unlimited children, six allowed type pairs: epic to story, epic to task, epic to chore, story to task, story to bug, spike to task.

`setParent` refuses an unknown id (`P4`), a disallowed pair (`P1`) and an edge that closes a cycle (`P2`).
`set <id> parent_id=<id>` and `file --parent <id>` run it before they write, so each refusal is an exit status: `P1` and `P2` are `GUARD_REFUSED`, and a parent naming no record is `NOT_FOUND` with the nearest ids beside it.
The fix lines name the types that may parent the item, `backlog --type epic` for a task, because the id the caller chose is the one that was just refused.
Before the write paths called it, both commands wrote the edge unchecked: `set draft-task parent_id=draft-task` exited 0, and `doctor` reported the cycle as `S12`, the finding for a hand edit.
No pair in the table can form a cycle on its own, so the cycle check exists for a graph that a file or a merge already left a bad edge in.
That is not hypothetical: the committed files are authoritative, so a hand edit never passes through a write, which is why the load-time check below stays beside the write-time one.
A chain that already closes a cycle above the chosen parent is refused as `INTEGRITY` with `doctor` as the fix, because the write that made it is not this one.

`rollUp(graph, id)` walks the subtree and returns points, done points, progress, direct child counts and descendant counts.
Points are summed over every non-cancelled descendant, and a cancelled descendant is excluded together with its own subtree.
Progress is `null` rather than a division by zero when nothing in the subtree is estimated.

`findParentCycle(parentOf)` is the load-time check, returning the path that closes the cycle.
It takes the parent edges alone rather than a whole graph, because every node has at most one parent and no other column decides the answer, which is what lets the store read it as two index columns.
`cycleAbove(id, parentOf)` is the same walk from one node, for a caller that knows which edges moved.
`MAX_HIERARCHY_DEPTH` is 64, and every traversal carries a visited set and that ceiling.

## Dates

`due` is the only date a person sets on a work item, and nothing in this layer writes it.
`isOverdue(item, now)` is true when `due` has passed and the state is not terminal, and `daysOverdue(item, now)` is the whole days past it, clamped to `MAX_OVERDUE_DAYS`, which is 30.
A terminal item is never overdue: the date said when the work was wanted and the work has stopped.
The clock is an argument, as everywhere in this layer.

`healthFindings(items, now)` returns `H17` for every overdue item assigned to nobody, in id order, each naming the rule, the record and the instant it saw.
A due date nobody owns is a date nothing acts on, which is the whole reason the field is worth its bytes.

## Sprints

A sprint is a period with a committed set, and not a work item: it is `open` or `closed`, and nothing else about it moves.
`Sprint` carries `id`, `title`, `state`, `filed_at` (the instant it was opened), `version`, `start` and `end` as calendar days, and on a closed sprint `closed_at` and `carried`, the ids of the items still open when it closed.
`goal` is optional and bounded at `MAX_GOAL`, which is `MAX_REASON`.
`validateSprint` checks the dictionary; `isCalendarDate` refuses a date the calendar does not have, so `2026-02-30` is `I1` rather than the second of March.

The committed set is not a field.
An item carries `sprint_id`, so what is committed to an open sprint is what points at it, and `carried` is the one list a close writes because the items it names move on and stop pointing back.
`carryOver(items)` is what a close records: every committed item whose state is not terminal, in id order, so a cancelled item stays in the set and is not carried.

`dayOfSprint(sprint, now)` reads the UTC date of the instant against `start` and `end`, both inclusive: `day` is 1 on the start date and `days` is the length, and neither is clamped.
`evaluateCommit(context)` decides whether one item enters one sprint and returns `already`, `allowed` or `refused` with `I2`, `I3` or `I4` and the remedies.
The ready gate is the item's own definition of "can be picked up", and a sprint is where work is picked up, so the same verdict decides both.
[architecture/adr/0016-sprints.md](architecture/adr/0016-sprints.md) carries every judgement call.

## Relations

Six kinds, each with a defined inverse, and `relation add` writes three of them: `blocks`, `duplicates` and `relates_to`.
The other three load and show from a record that carries one and gain a writer with a decision; [architecture/adr/0015-relations-stored-once-and-the-guard-they-feed.md](architecture/adr/0015-relations-stored-once-and-the-guard-they-feed.md) carries why.

| Kind | Inverse | Directional |
|---|---|---|
| `blocks` | `blocked_by` | yes |
| `duplicates` | `duplicated_by` | yes |
| `caused_by` | `causes` | yes |
| `discovered_from` | `led_to` | yes |
| `split_from` | `split_into` | yes |
| `relates_to` | `relates_to` | no, symmetric |

`addRelation` refuses a self-edge (`R1`), for every directional kind an edge that would close a cycle (`R2`), and a second `duplicates` edge out of an item that already duplicates one (`R4`).
The domain model requires cycle detection on the blocking graph and the hierarchy by name; the other directional kinds get the same treatment because a cycle in "caused by" or "split from" is not a thing the domain can mean.
`relates_to` is symmetric, stored once in id order, and unchecked, because a cycle in it says nothing.

Writing an edge twice is idempotent: the second call returns `added: false` and the same graph.

A successful `addRelation` also returns `read`, the ids whose outgoing edges the cycle check consulted.
The writer hands those to the store as the transaction's read set, and the store refuses the write with `S10` if any of them moved between the read and the lock, so two commands that each passed the check against the other's absence cannot close a cycle between them.

An edge is stored once, as a `relations` entry on its source record, and `relationGraphFrom(items)` is the load path that reads every record's entries into one graph.
It refuses nothing: a stored cycle is `findRelationCycle`'s to report and an edge to a missing record is the caller's finding.
The field's own validation refuses a self edge, a repeated edge and more than `MAX_RELATION_ENTRIES`, which is 50, because those need no other record to see.

`blockersOf(graph, stateOf, id)` returns the blockers that are still active, meaning their source is neither done nor cancelled, and is known to the caller: a blocker nobody can finish holds nothing.
The derived blocked flag is that list being non-empty.
An impediment is an item, so one raised against the item is in that list through the same `blocks` edge, and is inactive once it is done or cancelled.

`relationsOf(graph, id)` reports outgoing edges under their own kind and incoming edges under the inverse, so a derived value is never printed under a raw field's name.

`MAX_RELATION_DEPTH` is 64, and `findRelationCycle(graph, kind)` is the load-time check.

## Gates

A gate is a named, ordered list of rules.
A rule is an id, a human sentence, a scope (`all` or one type), and one check from a closed set.
`evaluateGate(gate, context)` evaluates the rules in scope for the item's type, in the gate's own order, and returns per rule a pass or a fail with the reason and what would satisfy it.
The verdict passes only when every rule passes.

Default ready gate:

| Id | Scope | Rule |
|---|---|---|
| `DOR1` | all | The item has a title |
| `DOR2` | all | The fields the type requires at creation are present |
| `DOR3` | all | Nothing active is blocking the item |
| `DOR4` | story | The story has at least one acceptance criterion |
| `DOR5` | story | The story is estimated in points |
| `DOR6` | bug | The bug records what was expected |
| `DOR7` | bug | The bug records what actually happened |
| `DOR8` | epic | The epic has at least one child story |

Default done gate:

| Id | Scope | Rule |
|---|---|---|
| `DOD1` | all | Every child is done or cancelled |
| `DOD2` | all | No impediment is still open against the item |
| `DOD3` | all | A reviewer other than the assignee accepted it, when the type has a review step |
| `DOD4` | story | Every acceptance criterion is ticked |
| `DOD5` | spike | The spike records its findings |
| `DOD6` | bug | The fix is confirmed |
| `DOD7` | all | The item points at evidence, when the type has a review step |

`DOD2` reads the item's active blockers of type `impediment`, so an impediment raised against work in progress holds that work from `done` until it is resolved; its remedy is the impediment's next move toward `done` from the state it is in, the same move `DOR3` names for any blocker and `DOD1` for an open child.
`nextTowardDone(state, reviewStep)` reads that move off the transition table along the edges that need no reason, and `advance(item)` prints it as a command line: `done` is reachable from two states only, and a remedy is run from wherever the blocker stands.
A guard's `remedy` is a command line under the same rule, and `overrideCommand` prints the override line for the three guards that take one.
`DOD7` is scoped by the review step rather than by three per-type rules, exactly as `DOD3` is, so the two answer to one setting.
Together they are the anti-attestation pair: the item was accepted by someone other than its maker, and the record points at something a third party can open.

`validateGate(gate)` refuses a duplicate rule id (`V7`) and a rule that reads a field the scoped type does not have (`V6`), which is what makes a workspace-configured gate safe to load.

The check kinds are `field_present`, `field_is_true`, `field_non_empty_list`, `list_all_ticked`, `type_required_fields`, `estimate_set`, `no_active_blocker`, `parent_present`, `child_present`, `no_open_child`, `no_open_impediment`, `reviewer_distinct_from_assignee` and `evidence_present`.
A workspace gate composes those; there is no custom predicate, because a gate is loaded from a text file and a text file cannot carry one.

## Records, and the two security findings that land here

`buildRecord(entries)` is the one door parsed input walks through into this layer.
It returns a `Map`, and it refuses `__proto__`, `constructor` and `prototype` by name.

Both controls are deliberate, and the reason is that either alone is one refactor away from failing.
The record field-key grammar is `[a-z_][a-z0-9_]*`, and all three of those keys match it, so a committed file can carry one as an ordinary-looking field name.
A `Map` has no prototype chain to poison; the deny-list means a later change back to a plain object cannot silently reopen the hole.
`validateFieldKeys` applies the same check to a record that already exists, which is the load-time half.
That is threat-model finding F6.

Every graph traversal in this layer carries a visited set and a stated depth ceiling, and reports a cycle as a named refusal rather than recursing into it.
Write-time cycle detection cannot see an edge that a hand edit or a git merge put in the file, and the roll-up runs over exactly that data.
That is threat-model finding F8.

Both were shown to fail before they passed: with the deny-list deleted, three of the nine F6 tests go red; with the visited set and the ceiling deleted, the hierarchy suite does not terminate and is killed at 45 seconds.

## Text safety

`findUnsafeCharacter(value, mode)` and `isSafeText(value, mode)` are the one home of the character class a stored value may not carry: Unicode `Cc`, `Cf`, `Cs`, `Zl` and `Zp`, with `line` refusing newline and tab as well and `text` allowing both.
U+200D ZERO WIDTH JOINER is permitted between two `Extended_Pictographic` characters, so a family emoji in a title survives and a joiner anywhere else does not.
A refusal names the character, as `U+2069 POP DIRECTIONAL ISOLATE`, because by definition a person cannot see it in the file.

The class lives here rather than in the store, even though the store is the boundary that applies it, because `validateWorkItem` applies it too and two copies would drift.
That is threat-model finding F5, and [architecture/adr/0003-record-format-and-migration.md](architecture/adr/0003-record-format-and-migration.md) carries the reasoning for the class over the seven code points the audit named.
