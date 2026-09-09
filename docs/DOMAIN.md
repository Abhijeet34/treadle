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
The set is closed: every id below is one an error carries, and no other id reaches a caller.
The interface specification's twelve output-contract requirements are also cited `(R1)` to `(R12)`, in [architecture/adr/0005-output-and-exit-code-contract.md](architecture/adr/0005-output-and-exit-code-contract.md) and in source comments.
That is a second register under one prefix and none of it is ever emitted, so an `R` a caller reads is always a relation rule from the table below.

| Id | Rule |
|---|---|
| `G1` | The ready gate passes |
| `G2` | The item is not blocked |
| `G3` | The target state's work-in-progress limit is not exceeded |
| `G5` | The type's review step decides whether `submit` or `finish` is the legal exit from `in_progress`; `story`, `bug` and `epic` have one |
| `G6` | The done gate passes |
| `G7` | Nothing active is blocked by this one |
| `G8` | An epic reaches `done` only once every child is done or cancelled |
| `T1` | No transition exists on this edge |
| `T3` | `on_hold` restores only the state it was held from |
| `T4` | A transition or an override that records a reason was given none |
| `T5` | An override names a guard the edge does not evaluate, or one that cannot be overridden |
| `T6` | An edge that records a closed-set value was given none, one outside the set, or one it does not own |
| `T7` | A reason is longer than `MAX_REASON`, which is 500 characters |
| `R1` | An item cannot relate to itself |
| `R2` | The edge would close a cycle in a directional relation kind |
| `R3` | The relation traversal hit its depth ceiling |
| `R4` | An item already duplicates another, and a duplicate has one original |
| `R5` | A `blocks` edge out of a done or cancelled item would block nothing |
| `R6` | A record would be removed while another record still names it: a stored relation edge or a child's parent |
| `P1` | The parent and child types are not an allowed pair |
| `P2` | The parent edge would close a cycle, or the stored hierarchy already contains one |
| `P3` | The hierarchy traversal hit its depth ceiling |
| `P4` | The id is not an item in this workspace |
| `V1` | A field key does not match the record grammar |
| `V2` | A field key names a JavaScript prototype slot |
| `V3` | A field key appears twice in one record |
| `V4` | A required field is missing, or a field value fails its validation |
| `V5` | A field is present that this type does not own |
| `V6` | A gate rule reads a field the scoped type does not have |
| `V7` | A gate uses one rule id twice |
| `V8` | A configuration value is not one its key accepts |
| `V9` | An id names one thing, and this one already names another record or another kind of thing |

`G8` is this implementation's number for a rule the domain model states without numbering: "an epic cannot reach done while any child is not done or cancelled".
The model's second epic rule, that an epic enters `in_progress` when its first child starts, is an effect rather than a guard and belongs to the application layer.

## Types and the required-field policy

`WORK_ITEM_TYPES` is closed: `epic`, `story`, `task`, `bug`, `spike`, `impediment`.

`chore` folded into `task` and its name is not reused.
No rule, gate, guard, ranking or read told one from the other: neither required a field at creation, neither owned a field, neither had a review step, and both took the same moves, so the word was the whole difference.
A caller who wants to say maintenance writes `--label chore`, which `backlog --label` filters on.

| Type | Required at creation | Fields the type owns beyond the common set |
|---|---|---|
| `epic` | `outcome` | `outcome` |
| `story` | none | `acceptance_criteria` |
| `task` | none | none |
| `bug` | `severity`, `repro_steps`, `found_in` | `severity`, `repro_steps`, `expected`, `actual`, `found_in`, `fix_confirmed` |
| `spike` | `question` | `question`, `findings` |
| `impediment` | `severity`, `proposed_resolution` | `severity`, `proposed_resolution` |

An epic's `outcome` is the result the epic is for, a text field on the record; it is not the `--outcome` a `release` transition records, which is `failed` or `yielded`, says how one attempt ended, and lives in the event alone.
The two are different things under one word, and nothing but this sentence and the one in the lifecycle section tells them apart.

A `story`, a `bug` and an `epic` have a review step, and no other type does.
That one setting decides `G5`, which is why `in_progress` exits through `in_review` for those three and straight to `done` for a `task`, a `spike` and an `impediment`, and it also scopes `DOD3` and `DOD7`.
`treadle help transition` names the set, and `treadle explain <id>` lists only the moves the item's own type allows.

An impediment is a blocker as a record of its own: it flows through the same seven states, `done` means resolved, and it holds work up through the `blocks` relation like any other item.
`proposed_resolution` is required because raising one obliges the raiser to say what would clear it; [architecture/adr/0017-an-impediment-is-a-type-that-blocks.md](architecture/adr/0017-an-impediment-is-a-type-that-blocks.md) carries the four decisions around it.

Two of the common fields are conditional rather than free.
`due` is an optional instant on every type, and `resolution` is legal only while the state is `cancelled`; a record carrying one in any other state is `V4`.

A field `set` writes is cleared by an empty value: `set <id> parent_id=` removes the parent, and `set <id> parent_id= assignee=` is one write and one event, with each side recorded as `(unset)` in `history`.
The empty value is the clearing syntax because no field in the dictionary accepts it, so it can never collide with a stored value the way a sentinel such as `-` would on a prose field, and because `labels=` already read as an empty list.
`title` and the fields the type requires at creation refuse it as `V4`, naming the write that fills them.
A field another command owns is cleared by that command: a transition off `on_hold` clears the three hold fields.
`file` reads an empty value as the field left unset, so `--set assignee=` files without one and `--set severity=` on a bug is the same `V4` as leaving it off.
`help set` carries the rule as its last example.

`treadle help file`, `treadle help set` and `treadle help show` print that table, generated from these two records rather than transcribed, so a caller who has to name a field reads the dictionary on the page that takes the name instead of learning it from a `V5` refusal one field at a time.

`requiredAtCreation(type)` returns the first column and `fieldsOf(type)` returns the common set plus the second.
`validateWorkItem(item, { now })` checks both, plus every field's own validation from the field dictionary.
`now` is an argument because a hold expiry has to be in the future and this layer does not read a clock.
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

Every length in this table, every count a refusal prints, and every `<n> chars` and `(text:<n>)` marker a read surface writes count the same unit: JavaScript string length, which is UTF-16 code units.
A character outside the Basic Multilingual Plane therefore counts as two, so `"ααααα 🙂"` is seven code points and counts eight.
One unit is used everywhere on purpose, so the number in a refusal is the number the bound compares and the number an echo prints; naming it here is cheaper than a per-surface conversion that would leave the four disagreeing.
`H18`'s 10,000 and `T7`'s 500 are the same unit.

A required text field that is only whitespace is refused at write time, because a paragraph that says nothing is not a value: `proposed_resolution is only whitespace, and a text says something or is left unset` is `V4`, checked wherever `text(name, max)` is the field's check.
It is write-time only, the same `storedProse` distinction every narrowed bound here uses, so a value an earlier version stored is still servable.

### Evidence

`EVIDENCE_KINDS` is closed: `commit`, `pr`, `run`, `test`, `file`, `url`, `report`.
An `EvidencePointer` is a `kind`, a `ref` and an optional `label`, and `evidence` is a list of them on every work item.
It is a pointer at an artefact that lives elsewhere, never the artefact, because the store is committed to git and a screenshot in a shard is a binary in a text repository.
A `url` ref begins `http://` or `https://` and a `pr` ref is a URL, a number, `#<number>` or `<owner>/<repo>#<number>`; the other five kinds are a hash, a path, a run id, a test name and a report name, which no pattern separates from a typo, so they carry the ref bounds alone.
Both shape checks are write-time only, so a record stored before them still reads.
[architecture/adr/0011-evidence-and-the-severity-audit.md](architecture/adr/0011-evidence-and-the-severity-audit.md) carries the argument.

Readiness and doneness requirements are not here: they live in the gates, because the model's own design is that the gate is what makes a type's fields bite.

## The lifecycle

Seven states: `draft`, `ready`, `in_progress`, `in_review`, `done`, `on_hold`, `cancelled`.
Blocked is not one of them.
It is derived from the relation graph and shown beside the state, never in place of it.

`TRANSITION_TABLE` holds twenty-three edges: the twenty-two the model draws, and `release`.
`treadle help transition` prints them, one row per edge name with the states it runs between, the guards on it and whether it requires a reason, and names the closed sets `--resolution`, `--outcome` and `--override` take.

`release` runs from `in_progress` back to `ready`, requires a reason, and evaluates no guard.
It is the exit an attempt that ended without the work being done had nowhere to record: a hold leaves `next`, which ranks `ready` only, and a cancel leaves the queue.
The item returns to the queue and the event carries `outcome`, one of `failed` or `yielded`.

Two edges record a value from a closed set, and `T6` is the one rule over both.
`cancel` requires a `resolution` from `wont_do`, `duplicate`, `superseded`, `cannot_reproduce`, `rejected`, and stores it on the record; `release` requires an `outcome` from `failed`, `yielded`, and stores it only in the event.
That `outcome` is the attempt's, and it is not the epic's `outcome` field: `history` prints `outcome=failed` for the event and `set` writes `outcome=` for the epic, so a reader tells them apart by which one carries a state change.
Every other edge refuses either.
[architecture/adr/0010-terminal-outcomes-dates-and-reviewability.md](architecture/adr/0010-terminal-outcomes-dates-and-reviewability.md) carries why this is not four new states.
`evaluateTransition(context, request)` returns one of three outcomes.

- `already` when the request names the state the item is already in. Nothing is written and no event is produced.
- `allowed` with the transition name, the resolved target and every guard result. A guard result carries the value it saw (`4/5` for a column limit), not merely its verdict.
- `refused` with a `DomainError` naming the first failing rule, a message listing every failure, and the full guard list.

`legalTargetsFrom(item, reviewStep)` lists the states this particular item may move to now, with `resume` resolved against `held_from` and the `in_progress` exit resolved against the type's review step (G5).

`resume` is not a state.
It restores the state the item was held from, so an `on_hold` item's only non-terminal target is that state; asking for any other is `T3`.
The model names `hold_reason` and `hold_until` and does not name a field to keep the held-from state in, so `held_from` is this implementation's storage of the rule.

G2, G3 and G7 yield to an explicit override that carries a reason.
G1, G5, G6 and G8 never do: the answer there is to fix the item.

## Hierarchy

One parent per item, unlimited children, five allowed type pairs: epic to story, epic to task, story to task, story to bug, spike to task.

`setParent` refuses an unknown id (`P4`), a disallowed pair (`P1`) and an edge that closes a cycle (`P2`).
`set <id> parent_id=<id>` and `file --parent <id>` run it before they write, so each refusal is an exit status: `P1` and `P2` are `GUARD_REFUSED`, and a parent naming no record is `NOT_FOUND` with the nearest ids beside it.
The fix lines name the types that may parent the item, `backlog --type epic` for a task, because the id the caller chose is the one that was just refused.
Before the write paths called it, both commands wrote the edge unchecked: `set draft-task parent_id=draft-task` exited 0, and `doctor` reported the cycle as `S12`, the finding for a hand edit.
No pair in the table can form a cycle on its own, so the cycle check exists for a graph that a file or a merge already left a bad edge in.
That is not hypothetical: the committed files are authoritative, so a hand edit never passes through a write, which is why the load-time check below stays beside the write-time one.
A chain that already closes a cycle above the chosen parent is refused as `INTEGRITY` with `doctor` as the fix, because the write that made it is not this one.

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

## Relations

Five kinds, each with a defined inverse, and `relation add` writes every one of them while `relation remove` takes every one back off.
Three of the six the set used to declare had no writer at all, so a `caused_by` edge reached a record only through a text editor and then bound the removal rule `R6` with no command able to unbind it.
`caused_by` and `discovered_from` are facts an agent holds at the moment of filing and gained the writer; `split_from` went with the split feature, and a record still carrying one is quarantined as the unknown kind it now is, with `doctor` naming the file and the line.
[architecture/adr/0015-relations-stored-once-and-the-guard-they-feed.md](architecture/adr/0015-relations-stored-once-and-the-guard-they-feed.md) carries the record of the earlier decision.

| Kind | Inverse | Directional |
|---|---|---|
| `blocks` | `blocked_by` | yes |
| `duplicates` | `duplicated_by` | yes |
| `caused_by` | `causes` | yes |
| `discovered_from` | `led_to` | yes |
| `relates_to` | `relates_to` | no, symmetric |

`addRelation` refuses a self-edge (`R1`), for every directional kind an edge that would close a cycle (`R2`), a second `duplicates` edge out of an item that already duplicates one (`R4`), and a `blocks` edge whose source is already done or cancelled (`R5`).
It takes the same `stateOf` reader `blockersOf` takes, because `R5` is the write-time half of the fact `blockersOf` applies on every read: a terminal blocker is inactive, so such an edge is written inert and the target reads `blocked no`.
The edges a resolved impediment still carries were written while it was live, so `R5` refuses the write and never the stored edge.
The domain model requires cycle detection on the blocking graph and the hierarchy by name; the other directional kinds get the same treatment because a cycle in "caused by" or "discovered from" is not a thing the domain can mean.
`relates_to` is symmetric, stored once in id order, and unchecked, because a cycle in it says nothing.

Writing an edge twice is idempotent: the second call returns `added: false` and the same graph.

A successful `addRelation` also returns `read`, the ids whose outgoing edges the cycle check consulted.
The writer hands those to the store as the transaction's read set, and the store refuses the write with `S10` if any of them moved between the read and the lock, so two commands that each passed the check against the other's absence cannot close a cycle between them.
The guards and gate rules that read a neighbour carry the same read set: `guardReads` in `src/application/services/context.ts` names every item on a `blocks` edge with the item, every child and the original it duplicates, at the version the decision read, and `transition` hands it to the store.
Without it a start decided against a done blocker landed after that blocker was reopened, and an accept landed after a done child was.

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

`DOR1` and `DOR2` are gone and their ids are not reused, the way `DOR5` went with estimation.
They read "the item has a title" and "the fields the type requires at creation are present", and no input could fail either: the store refuses a record whose heading is not `# <slug>: <title>` and quarantines one missing a creation-required field, both before a gate reads it.
Two rules that always pass are two rules in every denominator, so `explain` reported six decided rules as `rules 8/8 pass`.
The `type_required_fields` check stays, because a workspace gate may configure a rule that runs it.

Default ready gate:

| Id | Scope | Rule |
|---|---|---|
| `DOR3` | all | Nothing active is blocking the item |
| `DOR4` | story | The story has at least one acceptance criterion |
| `DOR6` | bug | The bug records what was expected |
| `DOR7` | bug | The bug records what actually happened |
| `DOR8` | epic | The epic has at least one child story |
| `DOR9` | impediment | The impediment says what it holds up |
| `DOR10` | all | The item is not a copy of another item |

Default done gate:

| Id | Scope | Rule |
|---|---|---|
| `DOD1` | all | Every child is done or cancelled |
| `DOD2` | all | No impediment is still open against the item |
| `DOD3` | all | A reviewer other than the assignee is named, and the assignee is not the one accepting, when the type has a review step |
| `DOD4` | story | Every acceptance criterion is ticked |
| `DOD5` | spike | The spike records its findings |
| `DOD6` | bug | The fix is confirmed |
| `DOD7` | all | The item points at evidence, when the type has a review step |

`DOD2` reads the item's active blockers of type `impediment`, so an impediment raised against work in progress holds that work from `done` until it is resolved; its remedy is the impediment's next move toward `done` from the state it is in, the same move `DOR3` names for any blocker and `DOD1` for an open child.
`nextTowardDone(state, reviewStep)` reads that move off the transition table along the edges that need no reason, and `advance(item)` prints it as a command line: `done` is reachable from two states only, and a remedy is run from wherever the blocker stands.
A guard's `remedy` is a command line under the same rule, and `overrideCommand` prints the override line for the three guards that take one.
`DOD7` is scoped by the review step rather than by three per-type rules, exactly as `DOD3` is, so the two answer to one setting.
`DOD3` reads two facts and not one: the `reviewer` named on the record, and the actor running the move.
Reading the field alone made the review step a field to fill in, since the assignee wrote any name into it and then took their own work to `done`; the rule is the human in the loop, so it asks who is asking.
An evaluation given no actor decides on the field alone, which is what a gate read without a caller has always done.
Together they are the anti-attestation pair: the item was accepted by someone other than its maker, and the record points at something a third party can open.

What that actor is worth, said here because `DOD3` is the rule that spends it, is bounded and it is easy to over-read.
The actor is declared by whoever ran the command, from `--actor` or `TREADLE_ACTOR`, and is recorded as given; the tool verifies no identity and has no way to.
A mutation naming nobody is refused, so no event is unattributable, and that refusal is the thing most likely to be misread: it makes the recorded name look checked, and nothing checks it.
What is unforgeable is one layer out.
`D1` makes the committed file authoritative, so a hand edit to it is a legitimate edit and the forge's signed commit is what proves its authorship; `treadle help` says the same sentence to a caller, and `src/application/services/doctor.ts` argues it beside `H20`, the audit that notices a record disagreeing with the log that recorded the value.

`validateGate(gate)` refuses a duplicate rule id (`V7`) and a rule that reads a field the scoped type does not have (`V6`), which is what makes a workspace-configured gate safe to load.

The check kinds are `field_present`, `field_is_true`, `field_non_empty_list`, `list_all_ticked`, `type_required_fields`, `no_active_blocker`, `parent_present`, `child_present`, `no_open_child`, `no_open_impediment`, `blocks_something`, `not_a_duplicate`, `reviewer_distinct_from_assignee` and `evidence_present`.
A workspace gate composes those; there is no custom predicate, because a gate is loaded from a text file and a text file cannot carry one.

## Workspace configuration

The key set is closed and every key is optional; the absence of a key is the compiled-in default in the third column, so a workspace nobody has configured behaves exactly as one written before this existed.
[architecture/adr/0026-workspace-configuration-is-the-policy-seams-second-implementation.md](architecture/adr/0026-workspace-configuration-is-the-policy-seams-second-implementation.md) is the record; `treadle config` prints every key with the value in force and whether it came from the file or the default.

| Key | What reads it | Default |
|---|---|---|
| `review_step` | guard `G5`, `DOD3` and `DOD7` | `story, bug, epic` |
| `next_weights` | `next`'s ranking | `pri=10, age=1, dep=5, asg=8, due=4, sev=6` |
| `wip_limits` | guard `G3`, and doctor `H04` | `-`, meaning no state is limited |
| `aging_days` | doctor `H03` | `0`, meaning no threshold |
| `ready_gate` | guards `G1` and `G6`, and `explain` | the default ready gate above |
| `done_gate` | the same | the default done gate above |

A limit of zero is unlimited and a threshold of zero is no threshold, which is what `TransitionContext` documented before either was configurable.
`-` is how a list that names nothing is written, because the record grammar refuses a field line with an empty value and a workspace that reviews no type has to be tellable from one that never said so.

A gate is stored as an H2 section, one rule per line, spelled `<id> <scope> <check>[:<argument>] <sentence>` with the sentence last because it is the one free-text field.
A configured gate replaces the default gate of that name whole and reaches the same `evaluateGate`, so what `explain` prints is what `G1` and `G6` decided.
`config set` takes the same rules on one line separated by `|`, which is the list syntax `set <field>=` already takes.

## Records, and the two security findings that land here

`buildRecord(entries)` is the one door parsed input walks through into this layer.
It returns a `Map`, and it refuses `__proto__`, `constructor` and `prototype` by name.

Both controls are deliberate, and the reason is that either alone is one refactor away from failing.
The record field-key grammar is `[a-z_][a-z0-9_]*`, and all three of those keys match it, so a committed file can carry one as an ordinary-looking field name.
A `Map` has no prototype chain to poison; the deny-list means a later change back to a plain object cannot silently reopen the hole.
`validateFieldKeys` applies the same check to a record that already exists, which is the load-time half.
That is threat-model finding F6.

Every graph traversal in this layer ends on a visited set rather than recursing into a cycle, and reports it as a named refusal; the walk a write runs above its chosen parent carries `MAX_HIERARCHY_DEPTH` as well.
Write-time cycle detection cannot see an edge that a hand edit or a git merge put in the file, and every walk in this section runs over exactly that data.
That is threat-model finding F8.

Both were shown to fail before they passed: with the deny-list deleted, three of the nine F6 tests go red; with the visited set and the ceiling deleted from the parent walk, the two bounded-walk tests go red, one of them after 2.1 seconds of unbounded growth ending in `RangeError: Invalid array length` out of `ancestors`.

## Text safety

`findUnsafeCharacter(value, mode)` and `isSafeText(value, mode)` are the one home of the character class a stored value may not carry: Unicode `Cc`, `Cf`, `Cs`, `Zl` and `Zp`, with `line` refusing newline and tab as well and `text` allowing both.
U+200D ZERO WIDTH JOINER is permitted between two `Extended_Pictographic` characters, so a family emoji in a title survives and a joiner anywhere else does not.
A refusal names the character, as `U+2069 POP DIRECTIONAL ISOLATE`, because by definition a person cannot see it in the file.

The class lives here rather than in the store, even though the store is the boundary that applies it, because `validateWorkItem` applies it too and two copies would drift.
That is threat-model finding F5, and [architecture/adr/0003-record-format-and-migration.md](architecture/adr/0003-record-format-and-migration.md) carries the reasoning for the class over the seven code points the audit named.
