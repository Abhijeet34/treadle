# ADR-0003: One Markdown record grammar, explicit typed fields, and `migrate` as the only rewrite

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** DR3 of the system design record, under decision D1

## Context

The committed file is the artifact a team reviews in a pull request and edits by hand, so the format has to read well as a diff and parse without ambiguity.
The reference implementation this product replaces inferred an item's state from a section heading, and renaming that heading dropped every item under it while the command exited zero.
That is the failure the format exists to make impossible.

The format also has to survive version skew in both directions.
A colleague on a newer version writes a field this version has never heard of, and this version must not delete it.

## Decision

A record file is a `schema: <n>` line, then a sequence of records.
A record is a `# <slug>: <title>` heading, a block of `key: value` lines, and H2 sections for multi-line text.

```text
schema: 1

# treadle-store: Land the store layer

type: story
state: ready
filed_at: 2026-09-01T10:00:00Z
version: 3
points: 5
labels: store, durability

## Description

The store layer, per DR2 to DR4.

## Acceptance criteria

- [x] Records are sharded by month
- [ ] The index rebuilds from a fingerprint
```

Six rules carry the weight.

1. **A record starts at a line beginning `# ` at column 0.** That is the resynchronisation point. A `# ` line whose text is not `<slug>: <title>` ends the previous record and is quarantined by line number, and every other record in the file keeps serving.
2. **Every semantic value is a field, never a heading and never a position.** `state: ready` is the state. The file's order and its section names carry nothing the lifecycle reads, so a cosmetic rename cannot move an item.
3. **A single-line value carries no character from the safe-text class**, and a section body carries none of it but newline and tab. The class is Unicode `Cc`, `Cf`, `Cs`, `Zl` and `Zp`; see below.
4. **A body line may not begin with `#` at column 0.** The write path refuses one by name, because such a line would re-parse as a heading. On read the segment split quarantines it rather than silently re-homing it.
5. **An absent optional field is an absent line**, never an empty value, so a diff never shows a field appearing with nothing in it.
6. **Encoding is UTF-8 with LF.** A file read with CRLF parses with the CR stripped and is reported as finding `H16`; the next write to it normalises the whole file.

Events are a different format on purpose: JSON Lines, keys in the fixed order `id, at, actor, actor_kind, entity_kind, entity, op, before, after, guards, cmd, txn`, no whitespace, `merge=union` in `.gitattributes`.
An event is machine-written and never hand-edited, and the record grammar would cost lines that no reader of a log wants.

### The two round-trip properties, held over generated documents

Byte-exactness is a property, so it is tested as one rather than against three fixtures.

- **A file the tool has not mutated re-renders byte for byte.** Each record keeps its original bytes and is never re-rendered, and a quarantined segment keeps its bytes too. Held over 400 generated documents, each mixing valid records, malformed segments and preamble lines, with a second assertion that every segment came back as either a record or a quarantine and none was dropped.
- **A rendered record is a fixed point of parse and render.** Held over 1,200 generated records, comparing bytes and then comparing the recovered id, title, ordered fields and sections.
- **A work item survives encode, render, parse and decode unchanged.** Held over 800 generated items across all six types. This is the one that catches field-level loss, which the byte properties cannot.

A mutated record re-renders from its fields, with known fields in the field dictionary's order and unknown fields after them in their original relative order.

### Unknown lines, in the only two forms a newer tool writes

A newer version writes either a field key this version does not know or an H2 section this version does not know.
Both are carried verbatim through every mutation: unknown field keys land in the item's `extra` map and are re-emitted after the known fields, and unknown sections stay on the stored record and are re-attached when the record is rewritten.
A line that matches neither form is not something a newer tool writes; it is corruption, and it is quarantined.

### Schema versioning

- Every file's first line is `schema: <n>`, and the tool has one compiled-in number.
- A file with a higher number is refused on read as `SCHEMA_NEWER` (`S8`) naming the file and both numbers, and every other file keeps serving. A merge that brought in one newer file disables one month, not the store.
- A file with a lower number is readable, and a write to it is refused as `SCHEMA_OLDER` (`S9`) with `migrate` named in the message, because writing it would rewrite the whole file as a side effect of a one-record change.
- Adding an optional field or a section name does not bump the number. Unknown-line preservation covers that in both directions.

`migrate` itself is not built on this branch; the refusal that makes it necessary is, and it names the command.

## Alternatives considered

### JSON, one file per item

Zero parser code, and it fails ADR-0002 on file count.
A multi-line description inside a JSON string is one 2 KB line in a pull request, which fails "reads well in a diff" for exactly the field people review.

### YAML front matter

No parser in the Node standard library, and the `yaml` package is 686 KB against a zero-runtime-dependency budget.
A subset parser that is not real YAML invites an editor's YAML mode to mis-highlight it.

## The safe-text class, and why it is a class

Threat-model finding F5: the design rejected U+202A to U+202E and nothing else.
The isolate controls U+2066 to U+2069 passed, and a stored lone U+2069 POP DIRECTIONAL ISOLATE closes the isolate wrapper the renderer itself opens, so the control that exists to confine reordering is defeated by the content it wraps.
The implicit marks U+200E, U+200F and U+061C passed, and so did U+200B and U+FEFF.

Naming those seven would have left the next one open.
The rule is the class: Unicode general categories `Cc` (control), `Cf` (format), `Cs` (unpaired surrogate), plus `Zl` and `Zp`.
`Cf` is what makes it whole, because it carries every bidi control, the zero-width set, U+FEFF, U+00AD, and the U+E0000 tag block, which hides text from a reader completely and which the audit did not name.

One carve-out: U+200D ZERO WIDTH JOINER is permitted between two `Extended_Pictographic` characters, so a family emoji in a title survives and a joiner anywhere else does not.
A refusal names the offending character (`U+2069 POP DIRECTIONAL ISOLATE`), not the class, so a person can find it in a file where by definition they cannot see it.

The class lives in `src/domain/text.ts` rather than in the store, because `validateWorkItem` and the store boundary must not be able to drift apart.

## Prototype-slot field keys

Threat-model finding F6: the key grammar `[a-z_][a-z0-9_]*` matches `__proto__`, `constructor` and `prototype`, so a committed file can carry one as an ordinary-looking field name.
The domain core already refuses all three by name and returns a `Map`, and the parse path routes every field key through that same door (`buildRecord`), so a record carrying one is quarantined as `V2` and the file's other records keep serving.

The event log is the second half.
`JSON.parse` makes `__proto__` an ordinary own key, which is harmless until something merges it into a target, and the design had no rule against that sink.
Rather than hope no merge is ever written, every object rebuilt from a line has a null prototype, the three keys are refused by name at any depth, and nesting past 32 levels is refused before the walk.

## Consequences

**Positive**

- A record is diff-legible, and a reviewer can tick an acceptance criterion in a pull request because it is a GitHub task list.
- A corrupt record costs itself. The measured case: one heading renamed in a shard, every other record served, the bad one reported with its file and line.
- An older tool reading a newer file loses nothing it did not understand.

**Negative**

- The grammar is this project's own, so a parser in another language needs this document.
- A reviewer who writes `[X]` rather than `[x]` has ticked nothing, and the record is refused by name rather than silently mis-read.

## Departures from the design record

- **The safe-text class replaces DR3 rule 7's list.** Stated above; it is the F5 fix, and it is wider than the fix the audit proposed because `Cf` covers the tag block the audit did not reach.
- **An unrecognised task-list marker is a named record refusal, not a doctor finding.** DR3 puts it in the doctor, which does not exist yet. Refusing by name keeps the "zero silent drops" property today, and the doctor can downgrade it to a finding when it lands.
- **A malformed line inside a record is quarantined rather than preserved.** DR3 says unknown lines are preserved, which is right for the two forms a newer tool actually writes and wrong for a line that matches nothing in the grammar. Both forms are still preserved; the third is reported.
- **The record grammar is about 260 lines, not the 150 DR3 estimated.** The difference is the ceilings, the safe-text checks and the quarantine paths, none of which the estimate included.
