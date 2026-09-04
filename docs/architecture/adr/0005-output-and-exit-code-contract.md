# ADR-0005: One result object per command, three renderings, one exit table

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** DR5 of the system design record, and the renderer half of DR6

## Context

The prior-art teardown's worst measured behaviour is a caller that cannot tell what happened.
The reference refuses its machine flag on read verbs, puts errors on stdout, and prints success while returning non-zero.
An agent facing that parses two output grammars plus a third for errors, and branches on prose.

The interface specification hands over twelve requirements that close that class.
Three of them decide the shape of everything here: the default machine rendering is a line format and not JSON (R1), one output contract covers every verb and both paths (R2), and the exit status is a function of the same result object the output was rendered from, with no per-command flag surface (R3).

## Decision

**Every command builds exactly one result object, and it is the only thing a renderer sees.**

```ts
type ResultObject = {
  schema: string          // `<command>/<version>`
  ok: boolean
  code: ResultCode        // OK VALIDATION GUARD_REFUSED CONFLICT NOT_FOUND STORE_UNAVAILABLE INTERNAL
  command: string
  workspace: string       // resolved once, before the command ran, and printed on line 1 (R5)
  effect: 'read' | 'mutate'   // declared, never inferred from the command word (R6)
  txn: string | null      // a mutation's transaction id, null on a read and on a no-op (R4)
  changed: number | null  // entities actually changed
  data: ResultData
}
```

An error is that object with `ok: false`, rendered by the same renderer onto stderr.
There is no second grammar and no separate error path.

**The shape beside it is the schema source.**
`ResultShape` declares the properties in render order and their kinds, `scripts/generate-schemas.ts` writes `schemas/<command>.v<n>.json` from it, and `test/cli/schemas.test.ts` fails when the shipped file is not what the shape generates.
One source therefore backs the schema a consumer validates against, the order the line format emits, and the summary the help page prints (R8).

**Exit status is one table over `code`, read in `src/cli/exit.ts` and nowhere else.**
`OK` 0, `INTERNAL` 1, `VALIDATION` 2, `GUARD_REFUSED` 3, `CONFLICT` 4, `NOT_FOUND` 5, `STORE_UNAVAILABLE` 6.
A guard refusal is distinguishable from a validation error, which is the question DR5's U3 asked.
The two hook codes DR5 names are not in the set: no hook exists to produce one, and a code nothing can produce is a contract with no implementation behind it.

**`--out human|agent|json` selects the rendering; absent, `human` if and only if stdout is a terminal, else `agent`.**
That is the whole rule (R10).
No environment variable and no workspace key changes it, which DR5 refused for the reason that an agent inheriting a human's shell would otherwise get prose in a pipe.

### The `agent/1` grammar, and the two findings that shaped it

Line 1 is the envelope: `ok <command> <workspace>` for a read, `ok <command> <workspace> <txn|-> <changed>` for a mutation, `err <CODE> <workspace>` for a refusal.
The envelope's arity is how a caller reads the effect class without parsing the command word.

| Kind | Trust | Shape |
|---|---|---|
| scalar | tool | `<key> <value>` |
| marked scalar | data | `"<key> <value>` |
| text block | tool | `\|<key> <lines> <bytes>`, followed by exactly `<lines>` content lines |
| content | data | a double quote, a space, and one verbatim line of the value above |
| block | tool | `~<key> <shown> <total>` |
| header | tool | `#<field> <field> ...`, in force until the next one; a `"<field>` column is data |
| truncation | tool | `+<key> <bytes>B truncated-at <cells>` |

`treadle --contract` prints that table, and `test/security/f12-data-boundary.test.ts` asserts the printed one is the one the renderer implements.

**F2, and R7's scope corrected.**
A description is a text field and may carry newlines by design, so DR5's "strings are emitted verbatim, which R7's validation makes safe" was not safe: R7 is defined for single-line fields, and one newline in a description ends its line and starts a record the tool never emitted.
Two controls.
A multi-line value travels in a counted block whose header states its line count and its byte count, so nothing the value contains can end the block early or open a line of its own; and `guardSingleLine` refuses a delimiter reaching a scalar or a cell at all, so a projection that forgets the block fails loudly instead of corrupting a stream.
R7's scope is therefore read here as: no field any renderer can emit contains a byte the line grammar treats as a delimiter.

**F3, and the one free-text column.**
The row grammar splits on the first arity-minus-one spaces, so only the last field may contain spaces, and appending a column after `title` silently shifts every value into the wrong field.
The renderer places the one free-text column last whatever order it was asked for, and a column set naming two of them is refused by name before it is rendered.
`assignee` is a real second one: the field dictionary validates it as a line, so it may contain spaces.

**F12, and the marker.**
F2 is the grammar breaking; F12 is the grammar working perfectly and a model still being steered, because a boundary legible to a parser is not legible to a model reading text.
Every value a person or an agent wrote is marked at its own name with `"`, the tool's own speech never uses that lead, and the contract says once that everything so marked is data.
Marking the column rather than each row costs one byte per block.

### The renderer seam

DR6's rule is that a seam with one implementation is not a seam.
Three renderers ship for a product reason: `agent` is the default off a terminal, `human` is the default on one, and `json` is for a consumer that wants a schema-validated document and will pay 3.27x the bytes for it.
A renderer takes the result object and its own presentation options, and looks its shape up from `src/application/shapes.ts` by the object's own `schema` string, so the object really is its only input.

`test/render/conformance.test.ts` feeds every command's golden result object to all three and asserts the grammar invariants over every artefact.
A fourth renderer, `test/render/recorder.ts`, records the object and emits nothing; the same suite renders a `structuredClone` of each object and asserts byte-identical output, and renders again after changing the process's cwd and environment.
That pair is the proof: what the recorder saw is the whole of what the three had.

## Alternatives considered

### JSON by default, as the domain model's 2.12 states

Refused, which answers U2 yes.
Measured on this repository's own nine-item list: the line format is 717 B and 185 Claude tokens, the pretty JSON of the same object is 2,342 B and 632 tokens, 3.27x the bytes and 3.42x the tokens.
The interface's own measurement was 2.42x and 2.68x; ours is worse for JSON because the result object carries its block column declarations, which the line format spends one header line on.

### A separate error grammar

Refused. The error is the result object with `ok: false`, so the same renderer, the same schema machinery and the same exit table serve both paths.

### A flag on the use case for a dry run

Refused, and this is the one place the design was changed by building it.
A mutating use case takes a `Target`, which is a store and a mode paired, and `targetFor` in the adapters layer is the only thing that builds one.
A mode and a store passed separately can disagree, and a `dry-run` whose store is the real one writes with nothing at the call site saying so; the fixture in this repository did exactly that before the pairing landed.

## Consequences

- A command that produces a record it does not declare in its shape emits nothing for it. The shape is the contract, and forgetting to declare a property is a silent omission rather than a crash. The schema test catches a shape that no command fills; nothing catches a command that fills nothing, which is what the golden objects are for.
- The human rendering is a generic projection with column alignment and the global width rule, not the bespoke layouts of interface section B. Board and chart rendering are a later task and carry their own layouts.
- No colour is emitted at all. Which state gets which of the eight ANSI colours is a decision the interface deliberately left open, and the property that makes deferring it safe is that colour never carries meaning of its own.
- Byte budgets are enforced in CI and token budgets are not: a tokenizer is a package, and this repository has zero runtime dependencies. The token figures are measured outside the tree and reported with the change.

## Departures from the design record

- **Keys are snake_case where DR5's illustrative output hyphenates.** `dry_run`, `would_exit`, `will_evaluate`. The interface explicitly left the wire encoding to this phase and required only three properties of it, all three of which hold; one spelling for a key in JSON and in the line format is worth more than matching an illustration.
- **`~<key> <shown> <total>` counts the matched set, not the store.** The interface's empty-state example prints `~items 0 24`, where 24 is the store, while its nine-item example prints `~items 9 24`, where 24 is the matched set. One meaning had to win. The `none searched 24 matched 0` line carries the store count, so nothing is lost.
- **An empty list prints no sort line and no aggregate.** The interface's content rule says every list prints its sort, and its own empty-state example does not. Nothing was ordered and nothing was summed, and the budget A.3 states for that artefact was measured on the example without them.
- **`--out` is supported on `version`.** The interface answers N there because its `version` emits no record. Ours does, so a caller that wants it as JSON gets it.
- **The hook codes are not in the closed set.** DR5 names `HOOK_REFUSED` and `HOOK_FAILED`; hooks are a later task and no code path can produce either today.

## What would reopen this

- A command whose result is unbounded, such as `history`. The line format is already line-delimited; JSON would need a document-per-line variant, and the shape would gain a stream marker.
- A budget in A.3 failing on real content rather than on the fixture, which sends the change back to content and not to the contract.
