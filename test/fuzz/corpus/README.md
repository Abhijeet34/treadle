# Fuzzing corpus

Seed inputs for `test/fuzz/fuzz.test.ts`, committed so a run is reproducible and a case
found once is never lost.

The `.md` files are record documents, one idea each: the minimal file, a CRLF file, a
quarantine between two served records, prototype-slot field keys, sections with blank
edges, right-to-left and astral content, a body whose lines look like structure, and a
record sitting on every declared limit.
`values.json` is the value corpus: 75 strings the escaper has to classify.

Two rules hold for anything added here.

Every code point in the safe-text class is written as a `\uXXXX` escape, never as a
literal.
An invisible character in a committed file is unreadable in a diff and indistinguishable
from a hidden marker, and the machine-wide provenance scan refuses one on sight.
`node -e` with `String.fromCodePoint` is how these were produced.

A crash the fuzzer finds becomes a named regression test beside the security suites rather
than only a corpus entry.
The failure message prints the offending input as base64 so the case can be lifted into one
without re-running the fuzzer.

The gate runs 250,000 inputs against each of the parser and the escaper.
`TREADLE_FUZZ_INPUTS=<n> npm test` raises that for a soak run.
