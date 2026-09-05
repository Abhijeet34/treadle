# Architecture

Four layers, one dependency direction, six seams.
This file is the map; [DOMAIN.md](DOMAIN.md) is the detail for the domain layer and [architecture/adr/](architecture/adr/README.md) is the detail for the store and the output contract.

## Layers

```text
cli         argument parsing, the command inventory, result -> exit status
  |
adapters    the store, the index, the clock, the id generator, the event sink, the renderers
  |
application use cases: one transaction per command
  |
domain      entities, the lifecycle, relations, hierarchy, gates. Pure.
```

A file may import from its own layer and from every layer above it in that diagram going down, and never the other way.
`src/domain` may import nothing but `src/domain`.

This is a test, not a convention: `test/architecture/layering.test.ts` reads every import in `src/`, resolves the relative ones, and fails on an edge that points the wrong way or that closes an import cycle anywhere in the graph.
It also fails on a `node:` import or a bare package specifier anywhere under `src/domain`, and on any use of `new Date`, `Date.now`, `Math.random`, `process.`, `globalThis`, `performance.` or `console.` there.
The domain layer takes instants, ids and derived facts as arguments, which is what makes it fast to test and portable across storage backends.

Today `src/domain` holds the domain core, `src/adapters/store` holds the two store implementations, `src/application` holds the use cases and the result object every command builds, `src/adapters/render` holds the three renderers, and `src/cli` holds the command inventory, the parser and the entry point.
That order was deliberate: the domain core landed first because every other decision is exercised through it, the store second because every command is a transaction over it, and the output contract third because it is what every later command is judged by.

## The six seams

Each seam ships two real implementations for a product reason, not a test-only one, and one shared conformance suite runs against both.
A seam with one implementation is not a seam, it is an interface waiting to be deleted.

| Seam | What it does | First implementation | Second implementation |
|---|---|---|---|
| Store (built) | Reads records and events by id, state, sprint and time range; applies a transaction under a lock with compare-and-set | Sharded Markdown files with a SQLite index | An overlay store: a copy-on-write layer over a base store, which is how `--dry-run` and `--preview` evaluate every guard without writing |
| Renderer (built) | Turns one result object into bytes for a rendering name | The compact line format for agents | JSON, and the human rendering |
| Clock (built) | Now, as an instant | The system clock | A fixed clock, which every golden result object runs under |
| Id generator (built) | Mints a transaction id and an event id | A random suffix | A sequential one, so golden output and `--dry-run` diffs are stable |
| Event sink | Receives the committed events of one transaction | The monthly event log | A capturing sink, which every event assertion in the suite runs against |
| Policy | Evaluates a guard or a gate rule and returns pass or fail with the reason and the remedy | The built-in gates in `src/domain/gates.ts` | A workspace-configured gate, validated on load |

The Store seam exists, with both implementations under one conformance suite; [architecture/adr/0006-the-store-seam.md](architecture/adr/0006-the-store-seam.md) is the record.

The Renderer seam exists with three implementations plus a fourth that ships nowhere: `test/render/recorder.ts` records the result object and emits nothing, which is how `test/render/conformance.test.ts` proves the object is a renderer's only input.
[architecture/adr/0005-output-and-exit-code-contract.md](architecture/adr/0005-output-and-exit-code-contract.md) is the record for that seam and for the object it renders.

The Clock and Id generator seams exist for the reason the table gives: every golden result object and every `--dry-run` diff in the suite is byte-stable because the fixed clock and the sequential generator are real implementations rather than test doubles.

The Policy seam is the other one that already exists.
Its second implementation is data rather than a second code path: `evaluateGate` takes any `Gate`, so a workspace gate and a built-in gate run through the same evaluator, and what the gate command prints is exactly what guards G1 and G6 decide.
`validateGate` is what makes a configured gate safe to load.

## Storage, in one paragraph, so the domain's shape makes sense

The workspace is a directory of markdown files sharded by the calendar month an item was filed in, plus an append-only monthly event log, plus a gitignored SQLite index that is re-derived from a size, mtime and content-hash fingerprint on every command.
The committed files are authoritative and the index is a cache whose deletion is always safe.
That is why the domain core validates on load rather than only on write: a hand edit and a git merge both bypass a write, and the tool's job is to help with the result rather than forbid it.

## The decision records

[architecture/adr/](architecture/adr/README.md) carries one record per decision that a later change has to argue with: the storage layout, the record grammar and its migration path, concurrency and durability, the output and exit-code contract, and the store seam.
Each names where it departs from the design that preceded it.

## Extension

There is none, and that is a decision rather than a gap.

DR6 designed a hook as an external executable named in a committed `workspace.md` and run on every mutation, which is code execution driven by the content of a repository you cloned.
[architecture/adr/0012-the-extension-surface-that-does-not-ship.md](architecture/adr/0012-the-extension-surface-that-does-not-ship.md) refuses that contract for v1, keeps the event-sink seam, and states what would reopen it.
`test/security/f1-f7-no-execution.test.ts` holds the refusal: nothing under `src/` may import a module that starts a process, evaluate a string, or read a setting named `hooks`.

In-process plugins were already excluded for a separate reason: a plugin that can call into the store bypasses the invariants a hook could not.
