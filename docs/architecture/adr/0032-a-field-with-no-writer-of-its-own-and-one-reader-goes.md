# ADR-0032: A field with no writer of its own and one reader records nothing, so `reporter` goes

**Status:** Accepted
**Date:** 2026-09-09
**Implements:** the keep-list truth audit, which named `reporter` and registered no decision for it
**Decided by:** firstmate on 2026-09-09, on the audit's recommendation; the note that voided the audit's `hold_until` cut, because PR #77 built that field's reader, confirmed in the same pass that this cut still stands

## Context

`reporter` was a common field of every work-item type, meaning "who asked for this".
Nothing in the tool ever filled it.
`file` has no `--reporter` flag and never set it from the actor, so the only way a record acquired one was `treadle set <id> reporter=<name>`, the generic editor that writes any field the dictionary does not reserve.
Nothing read it either, beyond printing it back: `show` carried it as one column, and that was the whole of its life.
It reached no gate, no guard, no ranking clause, no `doctor` finding and no filter.
treadle's own workspace, fifteen items at the time of the audit, has never carried one.

The fact `reporter` would have recorded is already recorded.
Every `item.file` event names the actor who filed the record, `history` prints that actor, and `explain` reads the same log.
So the field was not a second source for who asked; it was an empty slot beside an answer the log already gives.

That is the defect class this repository keeps finding in its own surface: a promise on the record that nothing keeps.
A reader who sees `reporter` in `show <id> --help` or in the field dictionary reasonably concludes the tool tracks who requested the work, and it does not.

## Decision

`reporter` is removed from the field dictionary, the `WorkItem` type, the record grammar's field order, `show`'s shape, `file`'s reported set and `AUDITED_FIELDS`.

A stored record that carries the key is not rewritten and not refused.
The key joins `RETIRED_FIELDS` in the item codec as a pure removal, the same treatment ADR-0029's five fields got: it is read as nothing, never carried into `extra`, and disappears on the next ordinary write with no user action and no migration command.
A record nobody writes again keeps the line forever and still serves, which is what D1 requires of a file a person may have hand-edited.

`show` moves from schema version 2 to 3, because removing a field from a result object is a breaking change under `docs/STABILITY.md` and a shape change bumps that shape's version.
No other command's shape moves: `file`'s `REPORTED` set feeds the `set` list rather than a declared property, and `AUDITED_FIELDS` decides what an event line carries rather than what a schema declares.

## Consequences

A workspace gate may no longer configure a rule over `reporter`.
`config set ready_gate "R1 all field_present:reporter ..."` is refused as `V6` before the write, which is the same refusal any field outside a type's dictionary already meets, and a configured gate already stored against it becomes `H14` on load rather than a crash.
Two suites configured their gates over `reporter` for exactly the reason it was a bad field to keep, that it was common to every type and nothing else in the tool contended for it; both now configure over `assignee`.

`reporter` joins `test/architecture/retired-names.test.ts`, so no comment, document, fixture or argv may spell it again where it would resolve to nothing.

If "on whose behalf" is wanted later, it returns as one build carrying its writer and its reader in the same change: a `file --reporter` flag with a default from the actor, and at least one read surface that acts on the value rather than echoing it.
That is the shape the audit's `hold_until` decision named as the way a deferred capability comes back, and it is the shape this record would accept.

## Alternatives

**Build the reader and the writer now.**
Refused for the same reason the field is going: nothing has asked for it.
The event log already answers who filed a record, so the build would have to justify a second, weaker answer that only a hand-written `set` ever fills.

**Keep the field and document it as caller-managed.**
Refused.
A dictionary entry is a promise that the tool understands the field; `extra` is the mechanism this format already has for a key the build has no meaning for, and it costs the caller nothing.
