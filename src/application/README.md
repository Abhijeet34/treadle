# Application layer

Use cases that compose the domain core into one transaction: file an item, run a
transition, plan a sprint, evaluate a gate, append the events a mutation produced.

This layer may import `src/domain` and nothing above it. It owns no I/O either; it takes
the store, the clock, the id generator and the event sink as ports and the adapters layer
supplies them (`docs/ARCHITECTURE.md`).

Empty today. The domain core landed first because every other decision is exercised
through it.
