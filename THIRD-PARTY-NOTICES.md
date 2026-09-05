# Third-party notices

Nothing third-party ships in the published package.

The tarball carries `dist/treadle.js`, the JSON Schemas, `LICENSE`, `NOTICE` and this file.
The bundle is built from this repository's own source and from no other code: treadle declares zero runtime dependencies, which `test/architecture/layering.test.ts` enforces, so there is no third-party attribution to make and `NOTICE` states that.
That is the whole notice obligation, and the rest of this file is about a tree that never leaves the machine it was installed on.

## The development tree

Building, type checking, testing and benchmarking treadle installs a tree of packages.
None of them ships.
Every one of them still has to carry a licence this project may use, and `scripts/check-licences.ts` checks the whole installed tree, transitive packages included, against this allowlist:

`0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `BlueOak-1.0.0`, `CC0-1.0`, `ISC`, `MIT`, `Python-2.0`, `Unlicense`.

A package licensed under anything else fails the check rather than being noticed later.

## Direct development dependencies

Versions move; the licence and the reason are what this table is for.
`package.json` holds the version ranges and `package-lock.json` holds what was actually installed.

| Package | Licence | What it is for |
|---|---|---|
| `@anthropic-ai/tokenizer` | Apache-2.0 | the token counts in the benchmark rig's output budgets |
| `@commitlint/cli` | MIT | the Conventional Commits check CI runs over a pull request |
| `@commitlint/config-conventional` | MIT | the rule set that check uses |
| `@types/node` | MIT | type declarations for the runtime, which is the only API treadle's code calls |
| `esbuild` | MIT | DR1's bundler: one entry file, at most 500 KB |
| `gpt-tokenizer` | MIT | the second tokenizer the rig reports, so no single vocabulary decides a budget |
| `typescript` | Apache-2.0 | type checking; Node strips the types at run time and never compiles them |

This file is generated. Run `npm run licences -- --write` after changing a development dependency, and commit the result.
