# treadle

The record of the work between people and agents, over files you commit to git.

A backlog that lives in a database is a backlog you cannot branch, diff, or review.
A backlog that lives in a hand-written markdown list is one the tool cannot enforce anything about.
treadle takes the first horn: the human-readable files are the source of truth and they are committed, and the tool earns its keep by validating them on load, refusing what breaks a rule, and naming the record that broke it.

It is not a Rally and not a Kanban board. What it records is a task, a decision, or a question put to a person with the answer its raiser would give, so that none of it is lost while an agent works; what it computes about that work is nothing the work does not already say.

**This repository ships the domain core, the store layer, and a command surface that runs treadle's own backlog.**
The domain core has the six work-item types and their required-field policies, one enforced lifecycle, the typed relation graph, parent/child hierarchy, and the definition-of-ready and definition-of-done evaluator.
Underneath it the store has month-sharded record files, an append-only event log, and an advisory lock with compare-and-set.
`bin/treadle.js` runs eighteen commands over that store, through application services, rendered as one result object in three forms: `init`, `file`, `show`, `backlog`, `transition`, `set`, `mark`, `evidence`, `relation`, `remove`, `config`, `doctor`, `next`, `explain`, `history`, `status`, `help` and `version`.
See [Status](#status) for what is and is not here.

## Requirements

Node.js 24.15 or newer.
The floor is the oldest Node.js release line still inside its official support window at release time, and it is reviewed at every Node LTS transition rather than when something breaks.
A release never ships with a floor on a line that reaches end of life within six months of that release date.

Linux, macOS and Windows, and any POSIX userland including BusyBox: the executable opens with `#!/usr/bin/env node` and asks for nothing a userland may not have.
One platform limit is worth knowing before you meet it. On macOS an argument block over about 955 KB kills the process inside Node's own startup, before treadle runs at all, because the kernel puts argv and the environment on the stack V8 measures its limit against.
No workflow produces one by accident and no code here can catch it; [docs/STABILITY.md](docs/STABILITY.md) carries the measurement and the decision to keep it rather than trade it for a launcher that fails on Windows.

The published package has zero runtime dependencies, and that is a budget rather than a coincidence: a read is the record files parsed, argument parsing is `node:util`, hashing is `node:crypto`, and the record format is this project's own grammar.

## Install

Nothing is published yet.
Publication is gated on a name clearance that has not run, so `package.json` carries `"private": true` and `npm publish` refuses.
That refusal comes from the registry client after authentication rather than from a local check, so `npm publish --dry-run` prints `+ treadle@0.1.0` and says nothing about it; [docs/RELEASING.md](docs/RELEASING.md) carries the measurement.
The release machinery is built and has never been fired; [docs/RELEASING.md](docs/RELEASING.md) says what opens it.
Clone the repository to work on it.

```bash
git clone https://github.com/Abhijeet34/treadle.git
cd treadle
npm ci
```

What a published install would carry is one file of executable code.
`npm run build` bundles the tree into `dist/treadle.js` with esbuild, and that bundle plus the JSON Schemas and the licence files is the whole tarball.
The budget is 768,000 bytes, recorded in `bench/budgets.json` as DR8's 768,000 bytes raised by [ADR-0027](docs/architecture/adr/0027-the-bundle-budget-moves-once-with-the-measurement-that-moved-it.md), and the build fails rather than warns if the bundle goes over.
The build prints the byte count and the margin every time it runs, and `.github/workflows/ci.yml` runs it on every pull request, so the budget is enforced rather than asserted.

## Quick start

```bash
export TREADLE_ACTOR=your-name   # and TREADLE_ACTOR_KIND=agent when an agent runs it
node bin/treadle.js init
node bin/treadle.js file story "Field edits"
node bin/treadle.js status
```

`TREADLE_ACTOR` is who the event log records for every change you make, and `--actor <name>` overrides it for one command.
A command that would write an event refuses instead of recording one when neither names anyone, so no workspace ever holds an event nobody is attributable for.

That refusal is worth reading precisely, because it makes the recorded name look stronger than it is.
The actor is declared by whoever ran the command and recorded as given; treadle verifies no identity and has no way to.
What is unforgeable sits one layer out: the record file is committed, and the forge's signed commit is what proves who wrote it.
`treadle help` says the same sentence to a caller, and `treadle doctor` reports a record that no longer agrees with the log that recorded its value.

`npm run check` is the gate: types, then the suite, then the bundle.
Development itself needs no build step: Node runs the TypeScript directly.
The suite ran 1,949 tests in 87 seconds on Node 24.11.1 on 2026-09-08.
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

- **Types that mean something.** A bug without repro steps and a severity is refused at creation. A story without an acceptance criterion can exist as a draft and can never reach `ready`, because `DOR4` refuses it and `treadle explain <id>` names the rule.
- **One lifecycle, with guards.** Every state change goes through one table, so an illegal move fails with the id of the rule it broke rather than succeeding quietly. A story, a bug and an epic pass through `in_review` on the way to `done`; a task, a spike and an impediment do not, and `treadle explain <id>` lists only the moves that item's own type allows.
- **The human in the loop, as configuration.** `config` sets what `ready` and `done` mean for this workspace, which types pass through review, how much may sit in `in_review` at once, and what `next` weighs. An agent cannot skip a gate a person set, and a refusal names the rule and prints the line that clears it.
- **Ambiguity removal as the feature.** Every state has a rule that explains it, every absence has a reason, every mutation has a dry run, and every record has an event history that `treadle history <id>` reads back with the actor on every change. A mutation hands back the transaction id it wrote under, and `treadle history --txn <txn>` spends it: an agent auditing the command it just ran reads every record that one command moved, rather than one item at a time.
- **Finding work, and unfiling it.** `backlog --title <words>` searches titles by their words, `--label <slug>` filters on a label and `--fields +labels` prints the list, and `remove` takes a mis-filed record out of its shard while the append-only log keeps every event it earned, so `history <id>` still answers after it. A removal is refused wherever another record would be left naming it: [ADR-0024](docs/architecture/adr/0024-a-record-leaves-the-store-and-the-log-keeps-it.md).
- **Output an agent can parse and a person can read.** One result object, three renderings, chosen by one rule: `--out`, or the terminal test when `--out` is absent.

## Status

| Area | State |
|---|---|
| Domain core: types, lifecycle, relations, hierarchy, gates | Shipped |
| Store: month shards, event log, lock, compare-and-set, transactions, workspace configuration | Shipped: [ADR-0002](docs/architecture/adr/0002-storage-layout.md) to [ADR-0006](docs/architecture/adr/0006-the-store-seam.md), [ADR-0026](docs/architecture/adr/0026-workspace-configuration-is-the-policy-seams-second-implementation.md) |
| Store: `migrate` | Declined [ADR-0003](docs/architecture/adr/0003-record-format-and-migration.md) No schema 2 exists, and `S9` names the reason on the day one does. |
| Commands: `init`, `file`, `show`, `backlog`, `transition`, `set`, `mark`, `evidence add`, `relation add`, `relation remove`, `remove`, `config`, `config set`, `doctor`, `next`, `explain`, `history`, `status`, `help`, `version` | Shipped |
| Commands: `gate` | Queued `gate-command` |
| Renderings: `--out md` | Queued `export` |
| Renderings: `csv` | Declined [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) Threat-model finding F4 closes by absence, since the formula guard has nothing to guard. |
| Hooks, and the adapter generator | Declined [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) An executable named in a cloned repository is the surface the threat model refuses. |
| Impediments: a type with `severity` and `proposed_resolution` required, blocking work through `relation add` | Shipped: [ADR-0017](docs/architecture/adr/0017-an-impediment-is-a-type-that-blocks.md) |
| `history --txn`, which resolves a transaction id back to the events it wrote | Shipped: #61 |
| `doctor`: thirteen findings over records, the event log, the relation graph, the parent hierarchy, impediments and the workspace's configured thresholds | Shipped |
| Benchmarks: corpora, cold-process timing, byte and token accounting, the DR8 gate | Shipped: ten of the twelve comparison axes measured, two not; A11 Declined [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) |
| Build: one esbuild bundle, weighed against DR8's 768,000 bytes | Shipped: [ADR-0027](docs/architecture/adr/0027-the-bundle-budget-moves-once-with-the-measurement-that-moved-it.md) |
| Release: version and changelog through release-please, signed-tag gate, SBOM, checksums, build provenance | Shipped: [ADR-0009](docs/architecture/adr/0009-release-and-supply-chain.md); never fired, because firing it needs a signed tag |
| Published package | Blocked on a name clearance that has not run |

Every row's State is one of three words, and each carries a pointer this repository holds it to.
**Shipped** names the record or the commit, **Queued** names an item in `.work` that is `ready` or `draft`, and **Declined** names the record that refused it with one sentence of reason.
"Specified, not implemented" and "Partly implemented" are gone, because neither said who owned the gap, and a gap nobody owns is documentation standing in for a decision.
`test/architecture/documented-numbers.test.ts` reads this table: a Queued row has to name an item `.work` holds in `ready` or `draft`, and a Declined row has to name a file that exists.

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
treadle explain export                          # why one item is still in draft
treadle backlog --state ready --explain-absence export
```

Eight items, of which six are `done`, one is `ready` and one is `draft`.
The one in `draft` is a story with no acceptance criteria, which is `DOR4` refusing it rather than a gap in the list, and `treadle explain export` names that rule.
The six that are `done` carry the commit that shipped them as evidence, and each says in its description which part of it shipped.
Seven more left the workspace through `treadle remove`, which takes a record out of its shard and keeps every event it earned, so `treadle history <id>` still answers for each of them with the actor and the reason.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - the layers, the dependency direction, and the six seams.
- [docs/DOMAIN.md](docs/DOMAIN.md) - the domain core's public surface and the rule ids its errors name.
- [docs/architecture/adr/](docs/architecture/adr/README.md) - one record per decision, with what it departs from and why.
- [docs/STABILITY.md](docs/STABILITY.md) - what counts as a breaking change, and the pre-1.0 policy.
- [docs/RELEASING.md](docs/RELEASING.md) - how a release happens, why the tag is signed by a person, and how to roll one back.
- [docs/PROVENANCE.md](docs/PROVENANCE.md) - how this was built, and why no third-party notice attaches.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) - every claim this project makes about itself, with the measurement behind it and the ones that are not proven.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md).

Every figure in this file that can be derived from the tree is held to it by `test/architecture/documented-numbers.test.ts`: the command list against the inventory, the type count against `WORK_ITEM_TYPES`, the backlog figures against `.work`, the doctor's finding ids and their count against what `doctor` raises, the threat model's totals against the register in `test/security/findings.test.ts`, the axis counts against what the rig emits, the rendering count against `RENDERINGS`, the seam count against the table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the Node floor against `engines.node`, and the bundle budget against `bench/budgets.json`.
Every number that test now checks was correct on the day it was written and went stale in silence, which is the case a habit does not catch and a test does.
What it deliberately does not check is a measurement: a wall time, a test count, a byte count of the tree or a coverage decimal is a figure of a run rather than of a tree, and moves on a commit that changed nothing about the claim. [docs/VERIFICATION.md](docs/VERIFICATION.md) carries those with the run they came from, and what the test holds about the two in the paragraph above is that neither is ever printed here without the runtime and the date it was measured on.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
