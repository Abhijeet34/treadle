# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## What this project is, and where its rules live

treadle is an agile work-management CLI whose committed markdown files are the source of
truth. The design was written before the code, so prefer reading a doc over inferring from
the source: `docs/ARCHITECTURE.md` (layers, dependency direction, the six seams),
`docs/DOMAIN.md` (the domain core's surface and the closed set of rule ids its errors
name), `docs/STABILITY.md` (what counts as a breaking change), `docs/PROVENANCE.md`
(clean-room process). `README.md`'s Status table says what is implemented and what is only
specified. `docs/architecture/adr/` holds one record per built decision, with the store's
closed set of `S` rule ids in its `README.md`; each record ends with what it departs from in
the design that preceded it.

## Build and test

`npm run check` is the gate: `tsc --noEmit` then `node --test`. There is no build step in
development. Node runs the TypeScript directly by stripping types, which is why
`tsconfig.json` sets `erasableSyntaxOnly` and the code uses `const` objects and union types
rather than enums, and why every relative import carries its `.ts` extension.

`package.json` declares `engines.node` at the product's floor of 24.15. This machine may be
below it; the domain core is pure and runs anyway, so an `EBADENGINE` warning from
`npm install` here is expected and is not a defect to fix. `node:sqlite` also works unflagged
below the floor and prints one `ExperimentalWarning` per process; that line in test output is
expected too.

Most of the suite's wall time is one file. `test/store/lock.test.ts` spawns 36 real child
processes through `test/store/fixtures/writer.ts`, because DR4's guarantee is about separate
processes and an in-process race would prove nothing. Run it with a generous
`--test-timeout`; the rest of the suite is under a second.

## Rules that are tests rather than conventions

Before hand-checking any of these, run the suite: it already checks them.

- `src/domain` may import nothing but `src/domain`, and may not touch the filesystem, the
  clock, a random source, the process or the console (`test/architecture/layering.test.ts`).
- Every tracked `.ts`, `.js`, `.sh` and `.yml` file carries `SPDX-License-Identifier:
  Apache-2.0` near the top (`test/architecture/license-header.test.ts`).
- Zero runtime dependencies. The same test fails if `dependencies` gains an entry.
- Every commit is signed off (`git commit -s`) and follows Conventional Commits; CI runs
  `scripts/check-dco.sh` and commitlint over a pull request's commits.

## CI runner platforms

If this project runs GitHub Actions, a pull request runs Linux runners only.
GitHub bills a macOS minute at about 10x a Linux one and a Windows minute at about 1.67x, all against the same allowance, so a three-platform matrix on `pull_request` spends most of the budget proving what the cheapest runner already proved.
Put macOS and Windows coverage on a weekly `schedule:` plus `workflow_dispatch`, and on the release path when the project ships per-platform artifacts.
Do not add a `macos-*` or `windows-*` runner to a job that runs on `pull_request`.
Never add `cancel-in-progress` to a release, publish, or scheduled workflow: cancelling a publish mid-flight causes real damage, and a superseded scheduled run is the only record of its own result.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
