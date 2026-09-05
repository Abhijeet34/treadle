# ADR-0007: The properties are proven with the runtime's own tools, and the dependency budget does not move

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** DR7 of the system design record, applied to the test-time half of the budget

## Context

601 example-based tests are evidence that the cases somebody thought of work.
They are not evidence of a property.
The claims this project makes about itself - that it is accurate, robust, reliable and extensible - are claims about all inputs, all sequences and all implementations, and none of the four was proven by anything before this record.

The obvious way to prove them is to reach for the ecosystem.
Property-based testing has `fast-check`, coverage has `c8` and `nyc`, fuzzing has `jsfuzz` and `@jazzer.js/core`, and each would arrive with a transitive tree.
DR7 sets zero runtime dependencies as a budget rather than a coincidence, and a development dependency is not free either: it is a package that reads the source, runs in CI with the repository checked out, and gets a record here before it is added.

## Decision

Nothing was added.
Every property below is proven with what the runtime already provides, and the four development dependencies stay `typescript`, `@types/node`, `@commitlint/cli` and `@commitlint/config-conventional`.

| Capability | What provides it | What was refused, and why |
|---|---|---|
| Generated input | `test/helpers/store-fixtures.ts`'s seeded `Gen`, and `test/properties/adversary.ts` beside it | `fast-check` 4.x. Its shrinker is the part worth paying for, and a failing case here is already reproducible from the seed the assertion prints, because every generator is `mulberry32` over an integer. A catalogue of 19 named adversarial classes is a better generator for this domain than a general one: `fast-check` does not know that `\|<key> <lines> <bytes>` is a delimiter in this project's own grammar. |
| Coverage | `node --experimental-test-coverage` and its built-in lcov reporter | `c8` and `nyc`. The runtime's own coverage is the same V8 data both wrap. |
| Per-file thresholds | `scripts/coverage.ts`, 150 lines, parsing that lcov | Node applies `--test-coverage-lines` to the project as a whole and has no per-file threshold, and the interesting files are exactly the ones a project-wide average hides. This is the "a few lines" case, and the gate table lives in the script rather than in a dozen command-line flags. |
| Fuzzing | `test/fuzz/fuzz.test.ts`, a mutation fuzzer over a committed corpus | `jsfuzz` (unmaintained) and `@jazzer.js/core` (a native libFuzzer binding). Coverage-guided fuzzing is worth its weight against a parser with deep state; this parser is one linear pass with no backtracking by construction, and 500,000 mutated inputs per run found nothing in either it or the escaper. |
| Schema validation in tests | `test/helpers/json-schema.ts`, already in the repository | `ajv`, which DR7's own table listed as a development dependency and which the build never needed. |
| Flake measurement | `scripts/flake.ts`, 60 lines | any test-retry plugin. A retry plugin hides a flake; this counts it. |

## Consequences

The dependency count is unchanged, so `npm ci` on a fresh clone still installs four packages and the supply-chain surface of the test suite is the runtime.

The generators are this project's own, which means they are this project's problem.
A generator that quietly stopped generating would leave a property green over nothing, so every property suite asserts the count it actually ran and the adversarial classes it actually reached, and prints both as diagnostics.
`test/properties/adversary.ts` names 19 classes and `missingCategories` fails the suite if a run left one unused.

`--experimental-test-coverage` is experimental, and its output shape could change under a Node upgrade.
`scripts/coverage.ts` reads lcov rather than the human table for that reason: lcov is a 30-year-old format and the reporter that emits it is the part least likely to move.

## Departures from the design record

DR7's development-dependency table named four packages and three of them are not here.
`esbuild` is absent because there is no build step: Node runs the TypeScript directly.
`ajv` is absent because the schema check is 60 lines against the shapes the repository already declares.
`eslint` is absent, which is the one departure worth arguing with: `tsc` under `strict` plus the architecture tests catch the classes that mattered here, and the project has no formatter dispute to settle, but a linter is the normal answer and its absence is a choice rather than an oversight.
`@commitlint/cli` and `@types/node` were not in DR7's table and are here, both for the same reason: they enforce a contract the design states in prose.

## What would reopen this

- A parser with real state, which is what coverage-guided fuzzing is for. The record format is deliberately not one.
- A property whose counterexamples are large enough that reading a raw failing input costs more than a shrinker would. The largest generated document here is under 256 KB and the failure message prints it as base64.
- Node removing `--experimental-test-coverage` rather than stabilising it, which would make `c8` the only candidate.
