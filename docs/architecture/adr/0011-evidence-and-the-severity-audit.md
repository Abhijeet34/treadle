# ADR-0011: Severity is a read surface and an audited field, and a claim carries a bounded pointer at its evidence

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** sections 3.4 and 4.5 of the `treadle-board-outcomes-retention-b3` audit

## Context

An audit drove the built command surface and found three things, each reproduced with a command whose output it quoted.

Severity reached no read surface.
`show`, `explain`, `backlog`, `status` and `next` printed it zero times for an S1 bug, `show --field severity` was a `C2` refusal naming the six fields the record did carry, and `next` weighted priority only, so an S1 and an S4 at the same priority scored identically.
The field was required at creation, refused if absent, and then shown to nobody.

Severity and priority changes were unaudited.
A `file` event's `after` carried `state` and `type` and nothing else, so `grep -c severity` over a 24-event log returned 0.
A hand edit taking one bug from S1 to S4 and priority 1 to 5 produced no event, no finding and no version bump.

Both prose fields were unbounded in practice.
A 90,000-character description was accepted and landed whole in the shard a reviewer diffs, and `--reason` had no cap at all: 10,000 characters were written to one event line.

The captain's two asks behind them are one idea.
A defect's seriousness has to be markable in a way the history can answer for, and an agent's claim has to carry a pointer at something a third party can open rather than a paragraph asserting the work was done.

## Decision

### Severity reaches every surface a caller reads

`show` carries `sev`, `explain` carries `sev`, `backlog` has a `sev` column and it is in the default column set, and `status` carries a `defects S1 1 S2 1 S3 1` census over open bugs only.
A closed defect's severity is history rather than a queue, which is why the census filters terminal states.

`next` gains a `v` component, printed inside the existing `parts` bundle and with its weight beside the others, so the order stays checkable from the output alone (R11).
An S1 scores 4, an S4 scores 1, anything with no severity scores 0.

The weight is 6, and it is chosen against a bound rather than a taste.
One priority level is 10, so an S1's lift is 4 x 6 = 24, which is 2.4 priority levels and never more.
Priority stays the lever a person sets and severity is the defect-specific tie-breaker under it.

### Every change to severity or priority is an event with a before and an after

`file` events now carry the audited fields the confirmation already prints, so the severity and the priority an item was created with are in the log.
The audited set is `file`'s reported set less the four free-text fields: an event line is read by a machine and diffed by a person, and a 5,000-character repro step in it duplicates the record it was copied from.

`mark <id> [--severity <S1-S4>] [--priority <1-5>] --reason <text>` is the marking mechanism itself.
It moves those two fields and nothing else, records a reason, and writes `before` and `after` keyed by field.
Re-asserting a value the item already carries is the idempotent no-op, and the reason is required only when something actually moves, so a caller is never made to write prose for a write that changes nothing.

The tool cannot stop a hand edit and should not try.
D1 makes the committed file authoritative, so an edit to it is a legitimate edit and the forge's signed commit is what proves its authorship.
What the tool can do is notice that the record no longer agrees with the log, which is doctor finding `H20`: it folds the log forward per field and names both values.
A log that never carried the field raises nothing, because silence there is what a workspace written by an earlier version looks like and is not evidence of an edit.

### Evidence is a bounded pointer list, and the done gate requires one

`evidence` is a list field on every work item, stored as a `## Evidence` section of `- <kind> <ref> <label>` lines and written by `evidence add <id> <kind> <ref> [label]`.
`kind` is closed at `commit`, `pr`, `run`, `test`, `file`, `url`, `report`.
A `ref` is a single line of at most 200 characters and carries no space, because a hash, a path, a run id and a URL do not; a `label` is a single line of at most 120.
An entry is appended and never edited, a duplicate `kind` plus `ref` is refused, and every add is an event carrying the pointer.

`DOD7` is scoped by the review step rather than by three per-type rules, exactly as `DOD3` already is, so the two answer to one setting and together are the anti-attestation pair: a story reaches `done` only when someone other than its maker accepted it and the record points at something a third party can open.
The tool cannot know the evidence is the right evidence. It can refuse the absence of any.

`H21` catches a done item with no evidence, which is what a hand edit or a record closed before this rule looks like.

### The two prose bounds

`description` is 10,000 characters and `--reason` is 500.

10,000 is the threat model's own reading of the field dictionary in finding F10, and the dictionary's row states no number, so nothing is contradicted by adopting it.
The measured argument is the one that decides it: a 30-line description produced a 41-line diff, and a 90,000-character one put the whole essay in the shard a reviewer reads.
500 is `hold_reason`'s bound, which is the one reason field the dictionary already sized, so the two reasons in this tool are now the same size.

Neither bound truncates.
A refused write names the field, the observed length, the limit and the difference, and the shard is left untouched.

## Alternatives considered

### A general `set` command instead of `mark`

`set <id> <field>=<value>` is the `field-edits` story, and it is filed.
It is a wider surface than the captain's ask and it would have to decide, per field, whether a reason is required.
`mark` is two fields, one rule and one audit, and `set` can absorb it later by routing those two fields through the same event.

### Severity as another priority level

Collapsing S1 into priority 1 would remove a field and a column.
It also removes the distinction the domain model draws: priority is what a person decides to work on next and severity is what the defect does to a user, and a production S1 nobody has prioritised yet is exactly the case the census on `status` exists to surface.

### Refusing a hand edit rather than reporting it

Nothing in this tool can refuse an edit to a committed file, and a design that pretends otherwise is worse than one that does not.
`H20` reports; git and the pull request review decide.

### A `notes` or `comments` stream beside the evidence list

Rejected by the capability audit before this task and reopened by nothing here.
It is the prose door this change closes, wearing a different name.

## Consequences

**Positive**

- A triaging caller sees severity on the first command they run, and `next` orders defects by it.
- A lowered severity has an actor, an instant, a reason and a before value, or it has a finding.
- `doctor` exists, which is the first read that reports `findings()` as rows a caller can act on rather than as the count `status` has always printed.
- The cheapest way to say "I tested it" is `evidence add x run 8813 "722 pass"`, which is one command with three bounded arguments, and the paragraph has nowhere to go but the file the pointer names.

**Negative**

- `backlog`'s default row is one cell wider, and a non-bug row carries a dash there.
- An agent that wants to close a story or a bug now has to have produced something to point at.
- `doctor` reads the whole event log, which no other read does. It is the audit command and that is its job; every other command still reads the index.

**Neutral**

- `mark` and `evidence add` are two more mutating commands, both of which take `--dry-run` and `--preview` from the flag matrix with no per-command rule.

## The bound that could not be applied where it was written

Narrowing `description` from 100,000 to 10,000 is a narrowing after files exist, and `docs/STABILITY.md` says the one thing the file format never does is stop reading a file an earlier version wrote.
The first build applied the bound in `validateWorkItem` with no mode, and a 42,000-character description that a hand edit wrote made the record unservable: `show` exited 4 with a `CONFLICT`, and `doctor` reported `checked 0`.

So the bound is a write-time rule.
`ValidateOptions.storedProse` is set by the store's codec and by nothing else, and on that path the store's own S5 section ceiling of 128 KiB is the bound.
A stored value over the write bound is `H18`, and the record still serves.

That leaves one gap, stated rather than hidden: the store would encode a 42,000-character description if something handed it one, because it cannot tell a new value from a carried one.
The application layer is the only writer and it validates first, and `H18` is the backstop.

## Where this meets ADR-0010

ADR-0010 landed first and built three of the same audit's other proposals, so four things in this record sit beside one of its.

- **Rule ids.** `T6` is ADR-0010's, one rule over both closed-set values a transition carries. The reason bound here is `T7`.
- **Finding ids.** `H16` is the store's and `H17` is ADR-0010's, raised by `status`, which has the clock. `H18` to `H21` are raised by `doctor` and by `explain`, which have the event log. The table in the ADR index says which raises which.
- **`next` carries two new components, not one.** `u` is days past the due date at weight 4 and `v` is severity at weight 6, and both print with their weights. They answer different questions: a date the workspace agreed is a commitment, and a severity is what the defect does to a user. Neither can outrank a priority step on its own.
- **The audited event fields follow the dictionary.** ADR-0010 replaced the epic-only `target_date` with a common `due`, so `AUDITED_FIELDS` records `due` and no longer names `target_date`. It stays `REPORTED` less its six free-text fields, which is one rule rather than two lists to keep in step.

`H20` deliberately does not cover `due` or `resolution`. It is scoped to what `mark` moves, and a date is not a severity marker; widening it is a decision for whoever wants it, not a side effect of a merge.

## Departures from the design record

- **The `file` event carries the audited fields, not every field.** The audit's section 4.5 says "every field it set". The six free-text fields of `REPORTED` are excluded, because part two of the same audit is about keeping prose out of the committed files and a 5,000-character repro step in an event line is the same defect one file over.
- **`H19` is a finding about the assignee marking their own item, and it does not refuse.** The audit names it and this build agrees: the log says who, and the person reading the pull request decides.
- **`doctor` ships as a read command with four findings, not the whole doctor the domain model specifies.** `H10`, `H12`, `H15` and the rest need entities that do not exist yet. The four here are the ones this change created a reason for.
- **The audit sequences this work after `field-edits` and `relations`.** It shipped ahead of both, because `mark` needs neither: the two fields it moves are already in the dictionary and the event it writes is the shape `transition` already uses.

## What would reopen this

- `history <id>` landing, which is the reader the event log's new fields were widened for; `H20` becomes a line in a timeline rather than a finding on its own.
- A workspace-configured gate wanting `DOD7` off for a type that has a review step, which is a configuration key rather than a rule change.
- A second field worth auditing the way severity and priority are, which is the point at which `mark` should become the two-field face of `set` rather than its own command.
