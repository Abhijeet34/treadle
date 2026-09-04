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
| `G5` | The type's review step decides whether `submit` or `finish` is the legal exit from `in_progress` |
| `G6` | The done gate passes |
| `G7` | Nothing active is blocked by this one |
| `G8` | An epic reaches `done` only once every child is done or cancelled |
| `T1` | No transition exists on this edge |
| `T2` | The target is not a state |
| `T3` | `on_hold` restores only the state it was held from |
| `T4` | A transition or an override that records a reason was given none |
| `T5` | An override names a guard the edge does not evaluate, or one that cannot be overridden |
| `R1` | An item cannot relate to itself |
| `R2` | The edge would close a cycle in a directional relation kind |
| `R3` | The relation traversal hit its depth ceiling |
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

`G8` is this implementation's number for a rule the domain model states without numbering: "an epic cannot reach done while any child is not done or cancelled".
The model's second epic rule, that an epic enters `in_progress` when its first child starts, is an effect rather than a guard and belongs to the application layer.

## Types and the required-field policy

`WORK_ITEM_TYPES` is closed: `epic`, `story`, `task`, `bug`, `spike`, `chore`.

| Type | Required at creation | Fields the type owns beyond the common set |
|---|---|---|
| `epic` | `outcome` | `outcome`, `target_date` |
| `story` | none | `acceptance_criteria` |
| `task` | none | none |
| `bug` | `severity`, `repro_steps`, `found_in` | `severity`, `repro_steps`, `expected`, `actual`, `found_in`, `fix_confirmed` |
| `spike` | `question`, `timebox_hours` | `question`, `timebox_hours`, `findings` |
| `chore` | none | none |

`requiredAtCreation(type)` returns the first column and `fieldsOf(type)` returns the common set plus the second.
`validateWorkItem(item, { now, pointScale })` checks both, plus every field's own validation from the field dictionary.
`now` is an argument because a hold expiry has to be in the future and this layer does not read a clock.
`pointScale` is workspace configuration and defaults to `1, 2, 3, 5, 8, 13`.

Readiness and doneness requirements are not here: they live in the gates, because the model's own design is that the gate is what makes a type's fields bite.

## The lifecycle

Seven states: `draft`, `ready`, `in_progress`, `in_review`, `done`, `on_hold`, `cancelled`.
Blocked is not one of them.
It is derived from the relation graph and shown beside the state, never in place of it.

`TRANSITION_TABLE` holds the twenty-two edges the model draws.
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
No pair in the table can form a cycle on its own, so the cycle check exists for a graph that a file or a merge already left a bad edge in.
That is not hypothetical: the committed files are authoritative, so a hand edit never passes through a write.

`rollUp(graph, id)` walks the subtree and returns points, done points, progress, direct child counts and descendant counts.
Points are summed over every non-cancelled descendant, and a cancelled descendant is excluded together with its own subtree.
Progress is `null` rather than a division by zero when nothing in the subtree is estimated.

`findHierarchyCycle(graph)` is the load-time check, returning the path that closes the cycle.
`MAX_HIERARCHY_DEPTH` is 64, and every traversal carries a visited set and that ceiling.

## Relations

Six kinds, each with a defined inverse.

| Kind | Inverse | Directional |
|---|---|---|
| `blocks` | `blocked_by` | yes |
| `duplicates` | `duplicated_by` | yes |
| `caused_by` | `causes` | yes |
| `discovered_from` | `led_to` | yes |
| `split_from` | `split_into` | yes |
| `relates_to` | `relates_to` | no, symmetric |

`addRelation` refuses a self-edge (`R1`) and, for every directional kind, an edge that would close a cycle (`R2`).
The domain model requires cycle detection on the blocking graph and the hierarchy by name; the other directional kinds get the same treatment because a cycle in "caused by" or "split from" is not a thing the domain can mean.
`relates_to` is symmetric, stored once in id order, and unchecked, because a cycle in it says nothing.

Writing an edge twice is idempotent: the second call returns `added: false` and the same graph.

`blockersOf(graph, stateOf, id)` returns the blockers that are still active, meaning their source is neither done nor cancelled.
The derived blocked flag is that list being non-empty, or an open impediment naming the item; impediments are the caller's to add, because the impediment entity is not in this layer yet.

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

`validateGate(gate)` refuses a duplicate rule id (`V7`) and a rule that reads a field the scoped type does not have (`V6`), which is what makes a workspace-configured gate safe to load.

The check kinds are `field_present`, `field_is_true`, `field_non_empty_list`, `list_all_ticked`, `type_required_fields`, `estimate_set`, `no_active_blocker`, `parent_present`, `child_present`, `no_open_child`, `no_open_impediment` and `reviewer_distinct_from_assignee`.
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
