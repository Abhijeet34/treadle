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

Seven rules carry the weight.

1. **A record starts at a line beginning `# ` at column 0, or at a line a hand edit reshaped into one.** That is the resynchronisation point. A `# ` line whose text is not `<slug>: <title>` ends the previous record and is quarantined by line number, and every other record in the file keeps serving. A line that carries `<slug>: <title>` after a run of at most three spaces and six hashes is a heading an edit damaged, and it resynchronises there too, so that demoting `# ` to `## `, indenting it or dropping its hash cannot make the record above absorb the record below. Two conditions keep prose out: the candidate must be followed by a record's mandatory field block, and inside a record's own field block a line is a candidate only once that record's four mandatory fields have been read, so `state: ready` is never mistaken for a boundary.
2. **Every semantic value is a field, never a heading and never a position.** `state: ready` is the state. The file's order and its section names carry nothing the lifecycle reads, so a cosmetic rename cannot move an item.
3. **A single-line value carries no character from the safe-text class**, and a section body carries none of it but newline and tab. The class is Unicode `Cc`, `Cf`, `Cs`, `Zl` and `Zp`; see below.
4. **A body line may not begin with `#` at column 0.** The write path refuses one by name, because such a line would re-parse as a heading. On read the segment split quarantines it rather than silently re-homing it.
5. **An absent optional field is an absent line**, never an empty value, so a diff never shows a field appearing with nothing in it.
6. **Encoding is UTF-8 with LF.** A file read with CRLF parses with the CR stripped and is reported as finding `H16`; the next write to it normalises the whole file.
7. **A name names one thing.** An id that appears on two records in one file names neither: both are quarantined as `S3`, so no reader and no write can resolve it by document order. A section name that appears twice in one record is quarantined as `S1` on the same reasoning, because `decodeItem` reads a section by name and would otherwise take the last one silently. The parser publishes one id-to-chunk map, and every reader and the write path resolve an id through it.

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
- Rules 1 and 7 did not bump the number either, and the reason is worth stating because a grammar change normally would. Neither rule changes how any file this tool wrote parses: the write path has never produced a duplicated id, a duplicated section name or a heading outside `# <slug>: <title>`. What they change is the reading of a file a hand edit damaged, which had no defined meaning before and now has a quarantine. Bumping the number would make every existing workspace read-only behind a `migrate` command that is not built, to no reader's benefit.

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
- A corrupt record costs itself at the store, and costs the answer at the command surface. The store quarantines the record, keeps its bytes for the round trip, serves every other record to `get` and `list`, and writes beside it without touching it, so nothing is lost and fixing the one record is the whole repair. No command answers over that store: `readWorkspace` in `src/application/services/context.ts` is the one read every command builds on, and it refuses a view any finding says is missing a record, naming the first record's file, line and reason and counting the rest. `doctor` is the one caller that reads through the refusal, because its answer is that list. The measured case: one heading renamed in a shard, `doctor` reports the record with its file and line and exits 7, and every other command refuses with the same file and line until it is fixed.
- Damage to a heading is loud rather than silent, which is the property the Context section claims. It cannot be prevented: within a multi-record file the boundary is a line, and a line is the thing a person reformats. The prevention that would work is one record per file, where the filesystem owns the boundary, and ADR-0002 priced and rejected it on freshness, at 296 ms across 50,000 per-item files against 0.27 ms across 24 shards. So detection it is, and the detector is redundancy the format already carries: a record's mandatory field block. A checksum would fire on every legitimate hand edit, a record count in the header would fire on every legitimate record a person adds by hand and would name the file rather than the record, and the index cannot be the detector because it is derived, gitignored and absent from a fresh clone.
- An older tool reading a newer file loses nothing it did not understand.

**Negative**

- The grammar is this project's own, so a parser in another language needs this document.
- A reviewer who writes `[X]` rather than `[x]` has ticked nothing, and the record is refused by name rather than silently mis-read.
- A section body line reading `some-slug: some text` at column 0, directly above what looks like a record's mandatory field block, is read as a damaged heading and the record is quarantined. That shape is what a swallowed record looks like, so the false positive and the true positive are the same bytes; the refusal names the record and the line.
- A command run against a store that holds a record it cannot serve exits 7, `INTEGRITY`, naming the record's file and line, where a lookup of that id exited 4 and every other command exited 0 with the record missing from its count. Under `docs/STABILITY.md` that is a new non-zero exit for a case that used to succeed; nothing is released yet, so it costs a release note rather than a bump.
- One bad record stops the workspace until it is fixed. That is the price of refusing over a partial answer, and it is the price `git` already charges for the same conflict in the same file; `doctor` names the record, and the store still serves and writes every other one, so the repair is the one record.

## Departures from the design record

- **The safe-text class replaces DR3 rule 7's list.** Stated above; it is the F5 fix, and it is wider than the fix the audit proposed because `Cf` covers the tag block the audit did not reach.
- **An unrecognised task-list marker is a named record refusal, not a doctor finding.** DR3 puts it in the doctor, which does not exist yet. Refusing by name keeps the "zero silent drops" property today, and the doctor can downgrade it to a finding when it lands.
- **A malformed line inside a record is quarantined rather than preserved.** DR3 says unknown lines are preserved, which is right for the two forms a newer tool actually writes and wrong for a line that matches nothing in the grammar. Both forms are still preserved; the third is reported.
- **The record grammar is about 260 lines, not the 150 DR3 estimated.** The difference is the ceilings, the safe-text checks and the quarantine paths, none of which the estimate included.
- **Rule 1 resynchronises on a damaged heading, and rule 7 exists at all.** Both are corrections to this record, not to the design.
  The first shipped version of rule 1 made `# ` at column 0 the only resynchronisation point, which meant the Context section above was false about the code beneath it: measured over a two-record file, six single-line edits to a heading, among them demoting it to `## `, dropping its space and dropping its hash, moved the record below into the record above with every command exiting zero, and the absorbing record's own `Description` silently became the absorbed record's prose.
  The benchmark rig reproduced one of the six as a silent drop in 206 damaged stores on every run, which is why comparison axis A5 was scored `MISSED` against a target of zero silent drops.
  Rule 7 is the same correction for identity: an id was resolved in three places that tie-broke differently, two taking the first record in document order and one the last, and they agreed only because every read went through the index, which nothing enforced.
- **Rule 7 is held at one door, not per command.** The third correction to this record, and the third instance of one defect.
  Rules 1 and 7 as first built made the parser loud: a duplicated id and a damaged heading each became a finding with a file and a line.
  What they did not say was where a command reads the findings, and the answer was one place: `show` looked an absent id up in them and refused by name, which is the single-item path.
  The list path never asked.
  `backlog`, `status` and `next` counted what `list` served and printed the count as the truth, so a merge that left its conflict markers in `items/2026-09.md` quarantined three records and `backlog` answered `items 1 of 1` with exit 0, while `show` on one of the three refused correctly with the file and the line.
  A finding carrying no id at all, a shard over its ceiling or without its schema line, reached no path, because a lookup by id cannot find a file.
  The check now lives in the one read every command is built on, `readWorkspace`, which refuses the view rather than serving it with a hole; there is no second path to forget, and a command written later inherits the refusal by calling the only read there is.
  The question that decides it is whether a finding names content the store holds and does not serve, which is every finding but the CRLF notice `H16` and the hierarchy cycle `S12`; that list of two is the one thing a new finding rule has to be added to, and leaving it off fails loud rather than silent.
  Refusing was chosen over serving what parsed beside a count of what did not, because every command's answer depends on the whole set: a backlog counts it, a gate reads an item's children from it, `next` ranks over it, a new id is chosen against it, and a hierarchy is validated over it.
  A count beside a wrong answer asks every caller to know to look for the count, which is the job the exit status already has; an agent that reads `~items 1 1` has no reason to read on.
