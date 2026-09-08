# schemas

One JSON Schema per command result, versioned per command, generated from the `ResultShape`
each service declares. Nothing here is committed: `npm run build` writes them beside
`dist/`, `npm run schemas` writes them on their own, and `.gitignore` holds `schemas/*.json`.

A change to a shape's properties bumps its version. `test/cli/schemas.test.ts` validates
every golden result object against the schema its shape generates, which is the check R8
asks for; nothing diffs against a release, because none has shipped.

`error.v1.json` is the one shape that serves every command: DR5's error is the result object
with `ok: false`, rendered by the same renderer, so its schema pins neither the command name
nor the effect class.

A `text` property carries `"x-trust": "data"`, and a block's `x-columns` marks the same on a
column. That is threat-model finding F12 in the JSON rendering: the value under it is
content a person or an agent wrote, never an instruction. The `agent/1` rendering marks the
same values with a leading `"` on the name; `treadle --contract` states the rule.
