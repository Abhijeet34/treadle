# CLI layer

Argument parsing on `node:util`'s `parseArgs`, the command inventory that generates help and
the JSON Schemas, the mapping from a result object to an exit status, and the entry point.

This layer may import every layer below it. Nothing imports it.

`inventory.ts` is the single source R8 asks for: it carries each command's shape, effect
class, record shape, pageability, confirmation class and examples, and the command-by-flag
matrix is derived from those attributes rather than filled in by hand. `help.ts` reads it,
`scripts/generate-schemas.ts` reads the shapes it names, and `test/cli/inventory.test.ts`
asserts the matrix has no gap and that no help page carries a verdict of its own.

`main.ts` has one shape: every path ends at `emit`, which picks the rendering, writes a
success to stdout and a refusal to stderr, and returns the status the result's own `code`
decides. There is no path that prints and then decides separately what to return.

`diagnostics.ts` owns finding F10: a field logged at `-vvv` is reported by name and size,
and `--log-values` is the explicit opt-in for its content.
