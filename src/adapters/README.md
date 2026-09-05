# Adapters layer

The concrete sides of the seams: the sharded Markdown store and its SQLite index, the
overlay store that backs `--dry-run` and `--preview`, the system and fixed clocks, the
random and sequential id generators, the event log, and the three renderers.
There is no hook dispatcher: [ADR-0012](../../docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md)
refuses one, and this layer executes nothing.

This layer may import `src/domain` and `src/application`. It is where `node:` modules are
allowed to appear.
