# schemas

One JSON Schema per command result, versioned per command, generated from the `ResultShape`
each service declares. `npm run schemas` rewrites them and `test/cli/schemas.test.ts` fails
when a shipped file is not what the shape generates, which is the check R8 asks for.

A change to a shape's properties bumps its version, and the shipped schemas are diffed
against the previous release.

`error.v1.json` is the one shape that serves every command: DR5's error is the result object
with `ok: false`, rendered by the same renderer, so its schema pins neither the command name
nor the effect class.

A `text` property carries `"x-trust": "data"`, and a block's `x-columns` marks the same on a
column. That is threat-model finding F12 in the JSON rendering: the value under it is
content a person or an agent wrote, never an instruction. The `agent/1` rendering marks the
same values with a leading `"` on the name; `treadle --contract` states the rule.
