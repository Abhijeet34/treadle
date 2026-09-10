# ADR-0031: The word was the whole difference, a declared kind earns its writer, and a rule no input can fail leaves the gate

**Status:** Accepted
**Date:** 2026-09-09
**Implements:** the keep-list truth audit and the type-vocabulary decision
**Decided by:** firstmate on 2026-09-08, under the captain's instruction to think critically and act, and to build no bulk. The captain's own approval covered folding `chore` into `task`; keeping `story` and `task` as two types was firstmate's call on the evidence.

## Context

A truth audit of treadling's own claims found, among the rows it named, three shapes a caller could hit but no argument had ever settled: a second work-item type with no rule, gate, guard, ranking or read that told it from the first; a closed set of relation kinds where half had no command able to write them; and two definition-of-ready rules that no record could ever fail. Each is a decision this record makes, not a correction of a defect; the other rows the audit found are bug fixes and are not argued here.

## Decision

### `chore` folds into `task`

No rule, gate, guard, ranking or read told a `chore` from a `task`: neither required a field at creation, neither owned a field beyond the common set, neither had a review step, and both took the same moves through the state machine. The word was the whole difference, and a label carries a word: a caller who means maintenance writes `--label chore`, which `backlog --label` already filters on. The `epic > chore` hierarchy pair goes with it, because `epic > task` already covers what it allowed.

The id a `chore` record held is not reused. Type has no writer once a record exists, so this is a record migration and not a field retirement: `RETIRED_FIELDS` in the item codec retires a field *key* and can never reach a *value* of a closed set, so a stored `chore` cannot be reinterpreted in place. The migration is remove then file under the same id, driven through the tool itself, which is how treadling's own `.work` record moved: `chore` filed, removed, and refiled as `task` with its label, doctor clean over 8 items and 94 events and `history` keeping the whole original life across the seam.

### Every declared relation kind gets a writer, and `split_from` is removed

Three of the six kinds the domain model declared resolved to nothing in `relation add` and `relation remove`, so a `caused_by` edge reached a record only through a text editor and then bound removal rule `R6` with no command able to unbind it. `caused_by` and `discovered_from` are facts an agent holds at the moment of filing: this bug was caused by that change, this was discovered while doing that. Recording them is the tool's purpose, so both gained a writer. `split_from` went with the split feature, which was never built; a record still carrying it is quarantined as the unknown kind it now is, with `doctor` naming the file and the line, and since the tool is unreleased and no command could ever have written one, only a hand edit can have produced it.

### `DOR1` and `DOR2` leave the default ready gate

`DOR1` read "the item has a title" and `DOR2` "the fields the type requires at creation are present". No input could fail either: the store refuses a record whose heading is not `# <slug>: <title>` as `S1`, and quarantines one missing a creation-required field as `V4`, both before any gate reads the item. Two rules that always pass are two rules in every denominator, so `explain` reported six decided rules as `rules 8/8 pass`. Their ids are not reused, the way `DOR5`'s was not when estimation left. The `type_required_fields` check stays, because a workspace gate may configure a rule that runs it even though the default gate no longer does.

## Consequences

`WORK_ITEM_TYPES` is six rather than seven, and every document that counted the union of fields over the types, the type list itself, or the relation-kind set had to move with it. `relation add`/`relation remove` write five of five declared kinds rather than three of six. `explain` reports `6/6` over the default ready gate rather than `8/8`.
