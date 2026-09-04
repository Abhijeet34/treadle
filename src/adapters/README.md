# Adapters layer

The concrete sides of the seams: the sharded Markdown store and its SQLite index, the
overlay store that backs `--dry-run` and `--preview`, the system and fixed clocks, the
random and sequential id generators, the event log and the hook dispatcher, and the three
renderers.

This layer may import `src/domain` and `src/application`. It is where `node:` modules are
allowed to appear.

Empty today.
