# Application layer

Use cases that compose the domain core into one transaction, and the result object every
command builds.

This layer may import `src/domain` and nothing above it. It owns no I/O either; it takes the
store, the clock and the id generator as ports and the adapters layer supplies them
(`docs/ARCHITECTURE.md`).

- `result.ts` is DR5's result object and the `ResultShape` beside it, which is what
  `schemas/<command>.v<n>.json` is generated from and what a renderer projects.
- `shapes.ts` is the registry a renderer looks a shape up in, keyed by the `<command>/<n>`
  string the object itself carries, so a renderer's only argument is the object.
- `services/` holds one file per group of use cases, plus `context.ts`, which does the one
  read of the store and derives every fact the domain needs handed to it.
- `services/mutation.ts` defines `Target`, a store and a mutation mode paired. A mutating
  use case takes one rather than a store and a mode separately, because a `dry-run` whose
  store is the real one writes and nothing at the call site would say so.
