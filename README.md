# treadle

Agile work management for a team and its agents, over files you commit to git.

A backlog that lives in a database is a backlog you cannot branch, diff, or review.
A backlog that lives in a hand-written markdown list is one the tool cannot enforce anything about.
treadle takes the first horn: the human-readable files are the source of truth and they are committed, and the tool earns its keep by validating them on load, refusing what breaks a rule, and naming the record that broke it.

**This repository ships the domain core, the store layer, and a command surface that runs treadle's own backlog.**
The domain core has the seven work-item types and their required-field policies, one enforced lifecycle, the typed relation graph, parent/child hierarchy with roll-up, and the definition-of-ready and definition-of-done evaluator.
Underneath it the store has month-sharded record files, an append-only event log, a derived SQLite index that is safe to delete at any moment, and an advisory lock with compare-and-set.
`bin/treadle.js` runs nineteen commands over that store, through application services, rendered as one result object in three forms: `init`, `file`, `show`, `backlog`, `board`, `transition`, `set`, `mark`, `evidence`, `relation`, `sprint`, `sprints`, `doctor`, `next`, `explain`, `history`, `status`, `help` and `version`.
See [Status](#status) for what is and is not here.

## Requirements

Node.js 24.15 or newer.
The floor is the oldest Node.js release line still inside its official support window at release time, and it is reviewed at every Node LTS transition rather than when something breaks.
A release never ships with a floor on a line that reaches end of life within six months of that release date.

The published package has zero runtime dependencies, and that is a budget rather than a coincidence: the index is `node:sqlite`, argument parsing is `node:util`, hashing is `node:crypto`, and the record format is this project's own grammar.

## Install

Nothing is published yet.
Publication is gated on a name clearance that has not run, so `package.json` carries `"private": true` and `npm publish` refuses.
The release machinery is built and has never been fired; [docs/RELEASING.md](docs/RELEASING.md) says what opens it.
Clone the repository to work on it.

```bash
git clone https://github.com/Abhijeet34/treadle.git
cd treadle
npm ci
```

What a published install would carry is one file of executable code.
`npm run build` bundles the tree into `dist/treadle.js` with esbuild, and that bundle plus the JSON Schemas and the licence files is the whole tarball.
The budget is 512,000 bytes, recorded in `bench/budgets.json` as DR8's, and the build fails rather than warns if the bundle goes over.
The build prints the byte count and the margin every time it runs, and `.github/workflows/ci.yml` runs it on every pull request, so the budget is enforced rather than asserted.

## Quick start

```bash
node bin/treadle.js init
node bin/treadle.js file story "Field edits"
node bin/treadle.js status
```

`npm run check` is the gate: types, then the suite, then the bundle.
Development itself needs no build step: Node runs the TypeScript directly.
The suite ran 1,499 tests in 110 seconds on Node 24.11.1 on 2026-09-07, on a shared machine that was loaded throughout.
Most of that time is 73 real child processes across the concurrency and durability suites, and 500,000 fuzzed inputs per run.
The seconds are a machine measurement rather than a budget, which is why they carry their date; [docs/VERIFICATION.md](docs/VERIFICATION.md) is where a figure with a claim behind it lives.

```bash
npm test         # node --test over test/**/*.test.ts, no build step
npm run check    # tsc --noEmit under strict, the tests, then the bundle
npm run build    # dist/treadle.js, weighed against the DR8 bundle budget
npm run coverage # the suite under coverage, held to a per-file gate
npm run flake    # 20 consecutive full runs, budget zero
```

[docs/VERIFICATION.md](docs/VERIFICATION.md) is the table of what is measured, what each figure is, and what is not proven.

The domain core is a library of pure functions.
Nothing in `src/domain` reads the filesystem, the clock, a random source, or the process, and a test enforces that rather than a comment asking for it.

```ts
import { DEFAULT_READY_GATE, evaluateGate, evaluateTransition } from './src/domain/index.ts'

const verdict = evaluateGate(DEFAULT_READY_GATE, {
  item: story, blockers: [], children: [], reviewStep: false,
})
// verdict.rules -> one pass/fail per rule, each with the reason and what would satisfy it

const outcome = evaluateTransition({ item: story, readyGate: verdict, /* ... */ }, { target: 'ready' })
// outcome.outcome -> 'allowed' | 'refused' | 'already'
// a refusal names the guard it broke, so a caller looks the rule up instead of reading prose
```

## What it does

See [Status](#status) for the line between implemented and specified-only.

- **Types that mean something.** A bug without repro steps and a severity is refused at creation. A story without an acceptance criterion can exist as a draft and can never enter a sprint.
- **One lifecycle, with guards.** Every state change goes through one table, so an illegal move fails with the id of the rule it broke rather than succeeding quietly. A story, a bug and an epic pass through `in_review` on the way to `done`; a task, a spike, a chore and an impediment do not, and `treadle explain <id>` lists only the moves that item's own type allows.
- **Sprints, with the carry-over on the record.** `sprint open`, `sprint commit` and `sprint close`; an item is in one sprint, a closed sprint names what it did not finish, and `next` ranks work in an open sprint above the rest.
- **A board that stores nothing.** `board` is the backlog grouped by state, scoped to the open sprint unless told otherwise, with a blocked row first in its column and its blocker named beside it; it takes every filter `backlog` takes and caps each column at `--limit` with the column's total beside the cap.
- **Ambiguity removal as the feature.** Every state has a rule that explains it, every absence has a reason, every mutation has a preview and a dry run, and every record has an event history that `treadle history <id>` reads back with the actor on every change.
- **Output an agent can parse and a person can read.** One result object, three renderings, chosen by one rule: `--out`, or the terminal test when `--out` is absent.

## Status

| Area | State |
|---|---|
| Domain core: types, lifecycle, relations, hierarchy, gates | Implemented |
| Store: month shards, event log, derived index, lock, compare-and-set, transactions | Implemented for work items and events |
| Benchmarks: corpora, cold-process timing, byte and token accounting, the DR8 gate | Implemented; ten of the twelve comparison axes measured, two not (no metrics layer, no adapter generator) |
| Store: sprint records in `sprints.md` | Implemented |
| Store: ceremony records; `migrate` | Specified, not implemented; an impediment is a work-item type in the month shards rather than a record of its own, [ADR-0017](docs/architecture/adr/0017-an-impediment-is-a-type-that-blocks.md) |
| Application services, the result object, the JSON Schemas | Implemented for the commands below |
| Renderers: the compact agent line format, JSON, human | Implemented |
| Commands: `init`, `file`, `show`, `backlog`, `board`, `transition`, `set`, `mark`, `evidence add`, `relation add`, `relation remove`, `sprint`, `sprints`, `doctor`, `next`, `explain`, `history`, `status`, `help`, `version` | Implemented |
| Anti-ambiguity: `--dry-run`, `--preview`, `--explain-absence`, ranking rationale | Implemented |
| Commands: `estimate`, `assign`, `split`, `undo`, `gate`, `config` | Specified, not implemented; `set` covers what `estimate` and `assign` would write, as `set <id> points=<n>` and `set <id> assignee=<name>`, and `relation add` and `relation remove` are what the design called `link` and `unlink` |
| `history --txn`, which resolves a transaction id back to the events it wrote | Specified, not implemented; `history <id>` is the entity-scoped half |
| Hierarchy roll-up: points, done points, progress and descendant counts over a subtree | Implemented in the domain core; `rollUp` has no caller, so no command surfaces it |
| `doctor`: nine findings over records, the event log, the relation graph and impediments; the rest wait on entities that do not exist yet | Partly implemented |
| Impediments: a type with `severity` and `proposed_resolution` required, blocking work through `relation add`, resolved by reaching `done` | Implemented |
| Boards, as a projection: `board` groups by state and scopes to the open sprint; work-in-progress limits and board membership are not stored, so guards `G3` and `G4` stay disarmed | Implemented: [ADR-0018](docs/architecture/adr/0018-the-board-is-a-projection.md) |
| Ceremonies, metrics, export, completions | Specified, not implemented |
| Hooks | Specified, refused for v1: [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) |
| Build: one esbuild bundle, weighed against DR8's 512,000 bytes | Implemented; inside budget, enforced by the build in CI |
| Release: version and changelog through release-please, signed-tag gate, SBOM, checksums, build provenance | Implemented; never fired, because firing it needs a signed tag |
| Published package | Blocked on a name clearance that has not run |

Twelve of the thirteen findings in the project's threat model are closed, each naming a regression test that was shown to fail before it passed.
In the store: incomplete rejection of bidi and invisible characters, prototype pollution through the record field-key grammar and the event log, missing ceilings on file size, event count and traversal depth, and a predictable temp-file name without an exclusive create.
In the output contract: a multi-line description forging lines in the agent stream, a column appended after a space-bearing one corrupting the row split, record content reaching a verbose log, and the data-versus-instruction boundary being legible to a parser but not to a model.
In the supply chain: the three unstated controls, which are now `ignore-scripts=true` in a committed `.npmrc`, a committed lockfile that every workflow installs with `npm ci`, and an SBOM with build provenance on the release path.
Three closed by having their surface removed rather than guarded: the hook contract that would have executed a program named in a cloned repository, the path rule that came with it, and the adapter generator that does not exist, all argued in [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md).
The one that remains is CSV formula injection, which lands with export.

## treadle's own backlog

`.work/` is a treadle workspace holding this project's remaining work, filed with the tool itself.
It is the proof that the tool can manage its own backlog, and it is readable and reviewable as markdown without running anything:

```bash
treadle status                                  # where the project stands
treadle next                                    # what to pick up, and why that order
treadle explain history                         # why one item is still in draft
treadle backlog --state ready --explain-absence history
```

Fifteen items, of which five are `done`, three are `ready`, six are `draft` and one is `cancelled`.
The six in `draft` are stories with no acceptance criteria, which is `DOR4` refusing them rather than a gap in the list, and `treadle explain <id>` names that rule on each.
The five that are `done` carry the commit that shipped them as evidence, and each says in its description which part of it shipped: `set` writes the fields the design gave `estimate` and `assign`, and the board stores nothing, so the work-in-progress limit and the board membership guards `G3` and `G4` want moved to `workspace-config`.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - the layers, the dependency direction, and the six seams.
- [docs/DOMAIN.md](docs/DOMAIN.md) - the domain core's public surface and the rule ids its errors name.
- [docs/architecture/adr/](docs/architecture/adr/README.md) - one record per decision, with what it departs from and why.
- [docs/STABILITY.md](docs/STABILITY.md) - what counts as a breaking change, and the pre-1.0 policy.
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) - the measured run: the twelve axes, the performance budget, and what is not measured yet.
- [docs/RELEASING.md](docs/RELEASING.md) - how a release happens, why the tag is signed by a person, and how to roll one back.
- [docs/PROVENANCE.md](docs/PROVENANCE.md) - how this was built, and why no third-party notice attaches.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) - every claim this project makes about itself, with the measurement behind it and the ones that are not proven.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md).

Every figure in this file that can be derived from the tree is held to it by `test/architecture/documented-numbers.test.ts`: the command list against the inventory, the type count against `WORK_ITEM_TYPES`, the backlog figures against `.work`, the doctor's finding ids against what `doctor` raises, the Node floor against `engines.node`, and the bundle budget against `bench/budgets.json`.
Every number that test now checks was correct on the day it was written and went stale in silence, which is the case a habit does not catch and a test does.
What it deliberately does not check is a measurement: a wall time, a byte count of the tree or a coverage decimal moves on a commit that changed nothing about the claim, and [docs/VERIFICATION.md](docs/VERIFICATION.md) carries those with the run they came from.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
