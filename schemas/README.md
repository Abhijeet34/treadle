# schemas

One JSON Schema per command result, versioned per command, shipped in the package and
printed by the `schema` subcommand. A change to a schema's shape bumps its version and CI
diffs the shipped schemas against the previous release.

Empty until the first command produces a result object.
