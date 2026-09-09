# ADR-0035: A verdict that records nothing and a rendering for a person go, and F4 closes with the second

**Status:** Accepted
**Date:** 2026-09-10
**Implements:** the captain's criterion of 2026-09-10, that treadle ships only what moves an agent's task and decision load into a file that survives a crash, and lets it plan without losing track of time, resources, goal or capabilities
**Closes:** threat-model finding F4, CSV formula injection, which was open against the export this record removes

## Context

`.work` held two items that had been queued long enough to be worth judging rather than scheduling: `gate-command`, a task in `ready`, and `export`, a story in `draft`.
Neither had been argued against the criterion above, because the criterion was written after both were filed on 2026-09-04.

Read against it, `gate-command` argues against itself.
Its own description, the last thing written on it:

> explain already prints the failing rules of both gates, and gate is the cheap single-gate form: one verdict, no record. ... This stays open because a verdict-only read is still the one shape the inventory lacks.

A caller who wants to know what the ready or done gate will decide runs `treadle explain <id>`, which prints the failing rules of both gates and reads the same evaluator.
So the whole of what `gate` would add is a narrower answer to a question the tool already answers, and the reason given for keeping it open is a gap in the command inventory rather than a caller who cannot get the answer.
It writes no event, so nothing it printed survives the process that printed it.
That is the one thing the criterion asks a command to do, and it is the one thing this command was specified not to do.

`export` had already lost the half that carried the risk.
[ADR-0029](0029-the-record-is-the-product-and-the-agile-surface-is-not.md) declined CSV rather than guarding it, and the item's own description records what that left:

> Threat-model finding F4 is the CSV export's formula guard, and ADR-0029 declines CSV rather than guarding it, so F4 closes by absence. What is left is --out md: scalars as a list, every block as a GFM table, no truncation, pipes escaped.

The records are already human-readable Markdown, committed to git, and that is the design D1 states rather than an accident of the format.
A fourth rendering that turns one command's result into a second kind of Markdown serves a person pasting output into a document.
It moves no load off an agent and it survives no crash, because the thing that survives a crash is the record file the agent already wrote.

## Decision

**Both items are cancelled with resolution `wont_do` and removed from `.work` through the tool, and neither surface is built.**

`treadle transition <id> cancelled --resolution wont_do --reason <this record>` records the decision on the record, and `treadle remove <id> --reason <this record> --yes` takes it out of its shard while the append-only log keeps every event it earned, which is [ADR-0024](0024-a-record-leaves-the-store-and-the-log-keeps-it.md)'s rule.
`treadle history gate-command` and `treadle history export` still answer after the removal, with the actor and the reason on every line.

**Threat-model finding F4 closes by absence.**
The finding is that a CSV export is quoted but not formula-guarded.
CSV was declined by ADR-0029 and Markdown goes with this record, so there is no export at all: no command writes a file for another program to read, and `RENDERINGS` is closed at the three that ship.
F4 joins F1, F7 and F11 as a finding closed by removing its surface rather than by guarding it, so it names this record beside the regression test that keeps the surface absent, which is `test/render/conformance.test.ts`.
The register in `test/security/findings.test.ts` moves to thirteen of thirteen closed.

**The README's Status rows move from Queued to Declined**, each naming this record, and the two figures that counted those items move with them.

Nothing under `src/` changes.
Closing F4 needs no code, because the code that would have carried the risk was never written.

## Consequences

The command inventory keeps a verdict-only read as a shape it does not offer, deliberately.
That is now a decision with a record rather than an item somebody could pick up, which is the difference between a gap and a queue.
If a caller appears who needs a verdict without the failing rules `explain` prints, the argument to reopen is that caller and not the shape of the inventory.

`.work` holds six items and every one of them is `done`, so the workspace has no open work for the first time.
Nine items have now left it through `treadle remove`, and the log answers for each.
`treadle backlog` prints an empty open list rather than a queue of two, which is the honest read: nothing here is waiting on somebody.

`SECURITY.md` no longer names an open finding, and the sentence that invited a report against F4 goes with it.
A CSV or Markdown export that carries an attacker's content into a formula stays in the in-scope list, because the boundary it names would apply the day an export is built.

Four of the thirteen findings are now closed by removed surface rather than by a guard, which is a third of the threat model.
`docs/VERIFICATION.md` already states what that kind of closure proves and does not: the tests prove the surface is absent from this tree, not that a guarded export would be safe.
Building one later reopens F4 in the same change, and this record is where that argument starts.

## Alternatives

**Build `gate` anyway, because the inventory lacks the shape.**
Refused.
A missing shape is not a caller, and the shape is a subset of one `explain` already serves.
The help page that once named `gate` was corrected before this record, so nothing in the tool points at a command that does not exist and no caller is stranded by the decision.

**Build `--out md` and skip the CSV half.**
Refused on what it would serve rather than on what it would cost.
The rendering is a small build and the seam is already there, which is exactly why it kept surviving a queue: it was cheap, not needed.
The output an agent parses is the line format, the output a person reads is the human rendering, and the durable artefact is the committed record.

**Leave F4 open and cut only the items.**
Refused as the state the register was already in and the one this pass exists to end.
F4 has been waiting on a feature that was never going to carry CSV since ADR-0029, so "open" recorded a queue position rather than a risk.
A finding kept open against nothing is worse than one closed with its reason, because a reader budgets attention for it.

## Departures from the design record

Neither surface leaves a hole in a design record, which is why this record departs from none of them.

DR5 and [ADR-0005](0005-output-and-exit-code-contract.md) name three renderings and one result object, and `RENDERINGS` still declares exactly those three.
`--out md` was a fourth that this repository proposed for itself and filed as a story, so removing it returns the contract to what the design already said rather than departing from it.

`gate` was named by `transition`'s own help page in an earlier build and by nothing else in the tool.
That page was corrected before this record, so the only departure it could have recorded had already been made and is not this record's to claim.
