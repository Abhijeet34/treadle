# Architecture

Four layers, one dependency direction, six seams.
This file is the map; [DOMAIN.md](DOMAIN.md) is the detail for the domain layer and [architecture/adr/](architecture/adr/README.md) is the detail for the store.

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

Today `src/domain` holds the domain core, `src/adapters/store` holds the two store implementations, and `src/application/ports` holds the one seam they implement.
`src/cli` and the rest of `src/application` hold a README each and no code.
That order is deliberate: the domain core landed first because every other decision is exercised through it, and the store second because every command is a transaction over it.

## The six seams

Each seam ships two real implementations for a product reason, not a test-only one, and one shared conformance suite runs against both.
A seam with one implementation is not a seam, it is an interface waiting to be deleted.

| Seam | What it does | First implementation | Second implementation |
|---|---|---|---|
| Store (built) | Reads records and events by id, state, sprint and time range; applies a transaction under a lock with compare-and-set | Sharded Markdown files with a SQLite index | An overlay store: a copy-on-write layer over a base store, which is how `--dry-run` and `--preview` evaluate every guard without writing |
| Renderer | Turns one result object into bytes for a rendering name | The compact line format for agents | JSON, and the human rendering |
| Clock | Now, as an instant | The system clock | A fixed clock, which every metric and history test runs under |
| Id generator | Mints a record id and a transaction id | A random suffix | A sequential one, so golden output and `--dry-run` diffs are stable |
| Event sink | Receives the committed events of one transaction | The monthly event log | Hook dispatch, and a capturing sink for assertions |
| Policy | Evaluates a guard or a gate rule and returns pass or fail with the reason and the remedy | The built-in gates in `src/domain/gates.ts` | A workspace-configured gate, validated on load |

The Store seam exists, with both implementations under one conformance suite; [architecture/adr/0006-the-store-seam.md](architecture/adr/0006-the-store-seam.md) is the record.

The Policy seam is the other one that already exists.
Its second implementation is data rather than a second code path: `evaluateGate` takes any `Gate`, so a workspace gate and a built-in gate run through the same evaluator, and what the gate command prints is exactly what guards G1 and G6 decide.
`validateGate` is what makes a configured gate safe to load.

## Storage, in one paragraph, so the domain's shape makes sense

The workspace is a directory of markdown files sharded by the calendar month an item was filed in, plus an append-only monthly event log, plus a gitignored SQLite index that is re-derived from a size, mtime and content-hash fingerprint on every command.
The committed files are authoritative and the index is a cache whose deletion is always safe.
That is why the domain core validates on load rather than only on write: a hand edit and a git merge both bypass a write, and the tool's job is to help with the result rather than forbid it.

## The decision records

[architecture/adr/](architecture/adr/README.md) carries one record per decision that a later change has to argue with: the storage layout, the record grammar and its migration path, concurrency and durability, and the store seam.
Each names where it departs from the design that preceded it.

## Extension

Hooks are external executables that can veto a proposed mutation and never edit it.
A pre-mutation hook sees a proposal and can only allow or refuse; the guards, the validation, the compare-and-set and the lock all run in the tool regardless of what any hook does.
There is no hook phase inside the lock, so a hook cannot wedge the store.
In-process plugins are excluded: a plugin that can call into the store bypasses the invariants a hook cannot.
