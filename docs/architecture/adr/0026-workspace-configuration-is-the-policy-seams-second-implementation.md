# ADR-0026: Workspace configuration is data on the workspace record, and the Policy seam's second implementation

**Status:** Accepted
**Date:** 2026-09-08
**Implements:** T1 of the remaining-surface plan, under the captain decision `remaining-unbuilt-scope`
**Overtaken in part by:** [ADR-0029](0029-the-record-is-the-product-and-the-agile-surface-is-not.md) removes the `point_scale`, `cycle_time_excludes_hold` and `start_requires_sprint` keys; the closed key set, the two gate sections and the compare-and-set still stand

## Context

Six things in this tree waited on workspace configuration by name, and every one of them was a compiled-in constant with a comment saying so.

| Waited on it | Where it said so, before this record |
|---|---|
| the review step, guard `G5`'s input | `src/application/services/context.ts`, "Workspace configuration owns this once `config` lands" |
| the point scale | `validateWorkItem`'s `pointScale` option, [../../DOMAIN.md](../../DOMAIN.md) |
| `next`'s weights | `DEFAULT_WEIGHTS` in `insight.ts` |
| work-in-progress limits, guard `G3` | [0018-the-board-is-a-projection.md](0018-the-board-is-a-projection.md), "`G3` and `G4` stay disarmed" |
| `G4`'s membership test | the same record |
| the Policy seam's second implementation | [../../ARCHITECTURE.md](../../ARCHITECTURE.md), "`validateGate` is what makes a configured gate safe to load, and nothing loads one today" |

DR2 always drew `workspace.md` as carrying "the workspace id, name, flow mode, gates, columns, people, components".
It carried `created_at` alone.

Two doctor findings the domain model specifies, `H03` (an item older than the aging threshold) and `H04` (a column over its limit), are thresholds rather than faults and had no threshold to read.
`H14` (a gate rule reading a field the type lacks) had no configured gate to read one from.

## Decision

### The configuration is optional fields and two sections on the workspace record

The key set is closed and every key is optional; the absence of a key is the compiled-in default, which is what a workspace behaved as before this record existed.
`review_step`, `point_scale`, `next_weights`, `wip_limits`, `aging_days`, `cycle_time_excludes_hold` and `start_requires_sprint` are field lines; `ready_gate` and `done_gate` are H2 sections, because a field value is bounded at 8 KiB and a section at 128 KiB and a gate is a list of rules.
A rule line is `<id> <scope> <check>[:<argument>] <sentence>`, the sentence last because it is the one free-text field, which is the row grammar every other line in this tool follows.

Adding optional fields and named sections to a record file is the additive change [0003-record-format-and-migration.md](0003-record-format-and-migration.md) says never bumps the schema.
`SCHEMA` stays 1 and `INDEX_FORMAT` does not move: the workspace record is read by `identity`, not from the index.

### A configured gate replaces the default gate of that name whole

`evaluateGate` takes any `Gate`, so a configured gate and a built-in gate reach one evaluator and what `explain` prints is exactly what guards `G1` and `G6` decided.
That is what makes this the Policy seam's second implementation rather than a second code path.
`validateGate`'s `V6` and `V7` are what make one safe to load, and they are raised on both sides of the same decode: `config set` refuses the text before the write, and a hand edit of the same text is `H14` on `doctor`.

### A configuration this build cannot read hides content

A key whose value will not parse is a finding on `workspace.md`, `S1` for a value and `H14` for a gate, and `readWorkspace` refuses over it the way it refuses over any quarantined record.
Falling back to the default gate was refused: the file would then say one thing and `transition` enforce another, which is the class of defect this codebase spent two days removing.
`identity` still answers, so `doctor` can run over the file that says it, and it reports the compiled-in default for exactly as long as no other command can run at all.

A key this build does not know is a different question and is carried forward verbatim, the DR3 rule the item and sprint codecs already keep, counted on `config` as `extra` for the reason `show` counts an item's.

### `H03` and `H04` are served content

Both are thresholds a team set over records the store serves whole, so `hidesContent` puts them beside `H16` and `S12` and `doctor` exits 0 on them.
A `doctor` that exited 7 for a slow story would tell a CI job that a slow story is the same event as a truncated shard.

### The workspace record is written under the same compare-and-set as every other

It gains an optional `version` field, absent on every workspace written before this and read as zero.
`config set` names the version it decided against, so two writers racing refuse the second with `S10` naming who moved it, rather than one rewriting the whole record over the other.

### The point scale is a write-time bound

A workspace that widens its scale writes an estimate an older compiled-in scale does not carry; applying the write bound on load would quarantine the record the tool had just written.
So the load path holds `points` to a whole number and the write path holds it to the scale, which is the same `storedProse` distinction every narrowed bound in the field dictionary already uses.

### `config` reads and `config set` writes, under one command word declared `mutate`

The interface specification's design bug DB-1 says a command word is always a read or always a mutation.
This departs from it: one word covers both, and the effect is declared `mutate` because the envelope has to be able to carry a transaction id (R4) and a command that can write may not under-declare it.
The bare read answers `changed 0` with no transaction, which is the envelope `sprint set` gives when nothing moved.

## Alternatives considered

**A second port method for the configuration, beside `identity`.**
Refused: the identity and the configuration are one record in one file, and two methods would stat and parse `workspace.md` twice on every command.

**Falling back to the compiled-in gate when a configured one will not load.**
Refused above: it makes the file and the enforcement disagree silently, which is worse than a refusal that names the line.

**Refusing an unknown key in the file.**
Refused: DR3's forward-compatibility rule is that an older tool writing a newer file loses nothing it did not understand, and the item and sprint codecs both keep it. The key set is closed where a caller types a key, which is `config set`, and the silence a carried-forward key would otherwise leave is closed by the `extra` count.

**Scoping `G3`'s column count to the whole workspace always.**
Refused: [0018-the-board-is-a-projection.md](0018-the-board-is-a-projection.md) scopes the board to the one open sprint, and a limit a team reads off `board` has to be the limit `G3` enforces. Two open sprints is a scope the board refuses to choose between and a guard may not refuse a move over, so that case falls back to the workspace, which is the wider count and refuses sooner rather than later.

## Consequences

- `StoreIdentity` carries the workspace record whole: id, name, path, `version`, `config` and the `extra` count. Both store implementations answer it and the overlay stages a workspace write, so `--dry-run` of `config set` reads back what the real write would leave.
- `StoreTransaction` gains an optional `workspace` write. It is a single value rather than a list, because there is one such record per store.
- `doctor` raises fourteen findings rather than twelve, and two of them exit 0.
- The domain gains one rule id, `V8`, for a configuration value a key does not accept.
- `explain` and `doctor` take a clock, because two of their findings are about elapsed time. `status` already took one for `H17`.
- The bundle grew from 419,191 to 448,772 bytes, which is [0027-the-bundle-budget-moves-once-with-the-measurement-that-moved-it.md](0027-the-bundle-budget-moves-once-with-the-measurement-that-moved-it.md)'s first measured input.
- `history` learns the configuration keys and one marker, `(rules:n)`, for a gate: a rule ends in a sentence and a sentence carries spaces, which the row grammar gives to one column and that column is the actor.

## Departures from the design record

The design left the review step, the point scale and the weights as three separate consumers and did not say where the values live in the type system; they are one `WorkspaceConfig` on the view, so a later task reads one field rather than three.

The design named nine keys and did not say how an empty list is spelled.
The record grammar refuses a field line with an empty value ("an absent field is an absent line"), so a workspace that reviews no type and one that never said so would have been the same file.
An empty list is written `-`, which is this tool's own unset marker on every other surface.

DB-1 is departed from for `config`, stated above rather than left to be noticed.

## What would reopen this

A key that wants a flag or an environment variable: the `source` column already has room for the word and the interface's four-link precedence is designed, so adding one is additive rather than a change to this record.

A configured gate that wants to add to the default rather than replace it. That is a second composition rule and a second thing a reader has to hold, and it is not designed here.
