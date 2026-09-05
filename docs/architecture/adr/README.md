# Architecture decision records

One record per decision that a later change has to argue with rather than merely notice.
The numbers match the design records they implement, so ADR-0002 is DR2's storage layout and ADR-0006 is DR6's store seam; the gaps are records that belong to layers not built yet.
ADR-0009 is the exception: the design phase wrote no record for release and CI, and the threat model's F13 fix asks for one, so it carries the next free number rather than a design record's.
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
| `S10` | A compare-and-set found a different stored version |
| `S11` | The lock was not acquired within the caller's bound |
| `S12` | The stored hierarchy closes a cycle |
| `S13` | A store file could not be created, read or written, and the filesystem said why |

## The doctor's finding ids

Every `H` id is borrowed from the design's doctor namespace rather than from the store's, and
a doctor finding is a report rather than a refusal: the record still serves and a person decides.
They are raised in three places, because each id needs a different thing beside the record.
`H16` comes from the store on load, which is the only layer that sees the file's bytes.
`H17` comes from `status`, which has the clock.
The last four come from `doctor` and from `explain`, the only reads that have the event log and
the done gate. ADR-0010 argues `H17` and ADR-0011 the last four.

| Id | Raised by | Finding |
|---|---|---|
| `H16` | the store, on load | A file arrived with CRLF line endings, which DR3 rule 6 named |
| `H17` | `status` | An overdue item is assigned to nobody |
| `H18` | `doctor`, `explain` | A stored description is over the write bound, which the load path does not apply |
| `H19` | `doctor`, `explain` | A severity or a priority was marked by the item's own assignee |
| `H20` | `doctor`, `explain` | A record's severity or priority disagrees with the last event that recorded it, so it was changed outside the tool |
| `H21` | `doctor`, `explain` | A done item whose type has a review step points at no evidence |

## The CLI's rule ids

A refusal that the command layer raises before the store or the domain sees it names one of these, on the same contract.
The set is closed.

| Id | Rule |
|---|---|
| `C1` | The invocation is not usable as written: a missing operand, a value outside a closed set, or two flags that ask different questions |
| `C2` | A named field or column is not one this command has |
| `C3` | A column set names two free-text columns, which no row ordering can render unambiguously |
