# Architecture decision records

One record per decision that a later change has to argue with rather than merely notice.
The numbers match the design records they implement, so ADR-0002 is DR2's storage layout and ADR-0006 is DR6's store seam; the gaps are records that belong to layers not built yet.
ADR-0009 is the exception: the design phase wrote no record for release and CI, and the threat model's F13 fix asks for one, so it carries the next free number rather than a design record's.
ADR-0012 is the other kind of exception: it records a piece of DR6 that was refused rather than built, so it carries the next free number and leaves ADR-0006 to the seam that shipped.
ADR-0013 belongs to no design record at all: it answers an incident in this repository's history, so it carries the next free number too.
ADR-0014 carries the next free number for the same reason ADR-0009 does: the read it reshapes is one the design never priced.
ADR-0015 carries the next free number because the sprint is DR2's entity built under a design the four absent capabilities share, and that design is not a numbered design record.
ADR-0016 carries the next free number for the same reason, and ADR-0017 carries the next free number after it for the same reason again: an impediment is one of the same four absent capabilities.
ADR-0018 is the fourth of them, the board.
ADR-0019 belongs to no design record either: like ADR-0013 it answers an incident in this repository's own history, so it carries the next free number.
ADR-0021 carries the next free number for ADR-0014's reason: it reshapes two commands the design never priced, found the first time the corpus carried a relation graph.
ADR-0022 carries the next free number because it answers one audit's findings across four of the records above rather than belonging to any one of them.
DR6 names six seams, so its number is shared: ADR-0006 is the store seam and the renderer seam is in ADR-0005, beside the result object it renders.

| Record | Decision |
|---|---|
| [ADR-0002](0002-storage-layout.md) | Month-sharded record files with a derived SQLite index that is never authoritative |
| [ADR-0003](0003-record-format-and-migration.md) | One Markdown record grammar, explicit typed fields, unknown lines preserved, `migrate` as the only rewrite |
| [ADR-0004](0004-concurrency-and-durability.md) | One advisory lock with a heartbeat, exclusive-create atomic writes, per-record compare-and-set |
| [ADR-0005](0005-output-and-exit-code-contract.md) | One result object per command, three renderings behind one seam, and one exit table over its `code` |
| [ADR-0006](0006-the-store-seam.md) | The store seam, with the sharded store and the copy-on-write overlay both under one conformance suite |
| [ADR-0007](0007-proving-the-properties.md) | The properties are proven with the runtime's own tools, and the dependency budget does not move |
| [ADR-0008](0008-the-measurement-rig.md) | The measurement rig: corpora written through the store, cold-process timing, and a gate that reads the median |
| [ADR-0009](0009-release-and-supply-chain.md) | One esbuild bundle as the published product, a signed annotated tag as the release authorisation, and the supply-chain controls around both |
| [ADR-0010](0010-terminal-outcomes-dates-and-reviewability.md) | A resolution and an attempt outcome instead of four new states, one due date with three reads that act on it, and two reviewability controls |
| [ADR-0011](0011-evidence-and-the-severity-audit.md) | Severity on every read surface and in the ranking, severity and priority changes audited, and a bounded evidence pointer the done gate requires |
| [ADR-0012](0012-the-extension-surface-that-does-not-ship.md) | DR6's hook contract is refused rather than gated, and the generated adapter it designed has no surface to secure |
| [ADR-0013](0013-a-branch-may-not-remove-a-test-main-has.md) | A pull request may not remove a test the merge base has without declaring it, and the check that says so is required by name outside the workflow file |
| [ADR-0014](0014-the-view-is-a-projection.md) | The view every command reads holds the fields a scan reads, the one record a command acts on is read on demand, and the shard a write touches is parsed once |
| [ADR-0015](0015-relations-stored-once-and-the-guard-they-feed.md) | A relation is one stored direction on its source record with the inverse derived on read, the `G2` guard it feeds already existed, and a dangling edge is a finding |
| [ADR-0016](0016-sprints.md) | A sprint is a period with a committed set, kept in one `sprints.md`, whose close records the carry-over and leaves unfinished work pointing at it |
| [ADR-0017](0017-an-impediment-is-a-type-that-blocks.md) | An impediment is a work-item type that blocks through the relation graph, required at creation to say what would clear it, resolved by reaching `done` with nothing unlinked |
| [ADR-0018](0018-the-board-is-a-projection.md) | The board is the backlog grouped by live state and scoped to the open sprint, stores nothing, sorts blocked work first, and leaves `G3` and `G4` disarmed |
| [ADR-0019](0019-no-harness-specific-instruction-file.md) | No tracked file at the repository root may be one a single agent harness loads by itself, and the test that says so is kept by the guard ADR-0013 already put outside the branch |
| [ADR-0020](0020-a-finding-is-decided-by-a-whole-read.md) | A finding is a verdict on the files cached like any row, only the pass that read a file whole may decide a duplicate, an append that meets one hands the file back, and `doctor` re-derives the index so the fix line every refusal prints is the recovery |
| [ADR-0021](0021-the-audit-holds-one-record-and-the-ranking-one-index.md) | `doctor` is fed one record and one event at a time through two streaming reads on the store seam, `next` ranks off one index over the graph, and both are gated as a ratio to the read every command performs |
| [ADR-0022](0022-a-closed-sprint-is-a-record-and-four-narrow-rules.md) | A closed sprint answers from the tally its close recorded, `H27` reports a raised impediment while `DOR9` refuses to raise one that holds nothing up, a sprint still admits ungroomed work and five surfaces name it, `notFound` routes a sprint id, and `R5` and `DOR10` give the two relation kinds a rule at write time |

Each record has a "Departures from the design record" section.
The design was written before the code and got most of it right; the places where building it changed the answer are the places worth reading.

## The store's rule ids

A store error names a rule so a caller looks it up instead of parsing the sentence, the same contract the domain core uses in [../../DOMAIN.md](../../DOMAIN.md).
The set is closed.
`V1`, `V2`, `V3` and `V4` are the domain's own ids, carried outward unchanged when a parse fails a domain rule.

| Id | Rule |
|---|---|
| `S1` | The record grammar was violated at a named line |
| `S2` | A value carries a character the safe-text class refuses |
| `S3` | Two records in the store share an id |
| `S4` | A record file exceeds its byte or record-count ceiling |
| `S5` | A record exceeds its field-count, value-length or section-length ceiling |
| `S6` | An event file exceeds its byte or line-count ceiling |
| `S7` | An event line exceeds its byte or JSON-nesting ceiling |
| `S8` | The file's schema is newer than this tool's |
| `S9` | The file's schema is older than this tool's and the operation writes |
| `S10` | A compare-and-set found a different stored version, on the record written or on one the write's decision read |
| `S11` | The lock was not acquired within the caller's bound |
| `S12` | The stored hierarchy closes a cycle |
| `S13` | A store file could not be created, read or written, and the filesystem said why |
| `S14` | Two events in the store share an id |
| `S15` | A path inside the store is a symbolic link, which the store never follows |
| `S16` | The lock was lost while held: the holder stalled past the heartbeat window and another writer reclaimed it |

## The doctor's finding ids

Every `H` id is borrowed from the design's doctor namespace rather than from the store's, and
a doctor finding is a report rather than a refusal: the record still serves and a person decides.
They are raised in three places, because each id needs a different thing beside the record.
`H16` comes from the store on load, which is the only layer that sees the file's bytes.
`H17` comes from `status`, which has the clock.
The rest come from `doctor` and from `explain`, the only reads that have the event log and
the done gate. ADR-0010 argues `H17` and ADR-0011 `H18` to `H21`; `H23` is the log's own
half of `H20`, added when a hand-written event line was found answering `explain`. ADR-0015
argues `H24` and `H25`, which need the whole relation graph beside the record, and `H26`
came with ADR-0016, for a `sprint_id` written before sprints were records. ADR-0017 argues
`H27`, which needs only the impediment's own record, and ADR-0022 narrows it to an
impediment past `draft`, because `file` lands one in `draft` and the finding used to fire
between the two commands the tool prescribes.

| Id | Raised by | Finding |
|---|---|---|
| `H16` | the store, on load | A file arrived with CRLF line endings, which DR3 rule 6 named |
| `H17` | `status` | An overdue item is assigned to nobody |
| `H18` | `doctor`, `explain` | A stored description is over the write bound, which the load path does not apply |
| `H19` | `doctor`, `explain` | A severity or a priority was marked by the item's own assignee |
| `H20` | `doctor`, `explain` | A record's state, severity or priority disagrees with the last event that recorded it, so one of the two was changed outside the tool |
| `H21` | `doctor`, `explain` | A done item whose type has a review step points at no evidence |
| `H23` | `doctor`, `explain` | An event is dated before the item it names was filed, which no write path records |
| `H24` | `doctor`, `explain` | A stored relation names an item the store does not hold, so it counts for nothing on any read |
| `H25` | `doctor` | The stored `blocks` edges close a cycle, which `relation add` refuses and a hand edit can leave |
| `H26` | `doctor`, `explain` | An item's `sprint_id` names no sprint record, which no write path produces since ADR-0016 |
| `H27` | `doctor`, `explain` | An impediment past `draft` blocks nothing, so it is raised against no work |

## The CLI's rule ids

A refusal that the command layer raises before the store or the domain sees it names one of these, on the same contract.
The set is closed.

| Id | Rule |
|---|---|
| `C1` | The invocation is not usable as written: a missing operand, a value outside a closed set, or two flags that ask different questions |
| `C2` | A named field or column is not one this command has |
| `C3` | A column set names two free-text columns, which no row ordering can render unambiguously |
