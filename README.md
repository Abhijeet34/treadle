# treadling

The record of the work between people and agents, over files you commit to git.

A backlog that lives in a database is a backlog you cannot branch, diff, or review.
A backlog that lives in a hand-written markdown list is one the tool cannot enforce anything about.
treadling takes the first horn: the human-readable files are the source of truth and they are committed, and the tool earns its keep by validating them on load, refusing what breaks a rule, and naming the record that broke it.

It is not a Rally and not a Kanban board. What it records is a task, a decision, or a question put to a person with the answer its raiser would give, so that none of it is lost while an agent works; what it computes about that work is nothing the work does not already say.

**This repository ships the domain core, the store layer, and a command surface that runs treadling's own backlog.**
The domain core has the six work-item types and their required-field policies, one enforced lifecycle, the typed relation graph, parent/child hierarchy, and the definition-of-ready and definition-of-done evaluator.
Underneath it the store has month-sharded record files, an append-only event log, and an advisory lock with compare-and-set.
`bin/treadling.js` runs eighteen commands over that store, through application services, rendered as one result object in three forms: `init`, `file`, `show`, `backlog`, `transition`, `set`, `mark`, `evidence`, `relation`, `remove`, `config`, `doctor`, `next`, `explain`, `history`, `status`, `help` and `version`.
See [Status](#status) for what is and is not here.

## Requirements

Node.js 24.15 or newer.
[docs/STABILITY.md](docs/STABILITY.md), "The runtime floor", owns the policy that sets that number and moves it.

Linux, macOS and Windows, and any POSIX userland including BusyBox: the executable opens with `#!/usr/bin/env node` and asks for nothing a userland may not have.
One platform limit comes with that line, and no workflow produces it by accident: on macOS an argument block over about 955 KB kills the process inside Node's own startup, before treadling runs at all.
[docs/STABILITY.md](docs/STABILITY.md), "The supported userlands, and the macOS argument-block limit", carries the measurement, why no valid call reaches it, and the decision to keep it.

The package has zero runtime dependencies, and that is a budget rather than a coincidence: a read is the record files parsed, argument parsing is `node:util`, hashing is `node:crypto`, and the record format is this project's own grammar.

## Install

`@abhijeet34/treadling` is on the registry, and `0.2.1` is what `latest` points at.

```bash
npm install -g @abhijeet34/treadling
treadling version
```

The install line carries the scope and the command does not.
`npm install -g @abhijeet34/treadling` and `npx @abhijeet34/treadling` fetch this package; `npm install -g treadling` and `npx treadling` fetch nothing, because npm refused the unscoped `treadling` as too similar to `readline` and no such package exists to resolve ([ADR-0039](docs/architecture/adr/0039-the-published-name-is-scoped-and-the-similarity-gate-is-only-observable-on-a-publish.md)).
`treadle` is no longer this package's name either: another developer holds that npm record, and npm transfers no name on demand ([ADR-0038](docs/architecture/adr/0038-the-name-is-treadling-and-the-old-npm-record-belongs-to-another-developer.md)).

`0.2.1` was published by hand.
The release workflow carries a `publish` job and it has never run: it is gated on the `NPM_PUBLISH_ENABLED` repository variable, which does not exist, the `npm-publish` environment does not exist either, and no trusted publisher is registered against this repository.
Every release since `v0.1.3` says so on its own page under `## Publication`.
[docs/RELEASING.md](docs/RELEASING.md), "The interlocks in front of npm", names what is left to arm it.

Clone the repository to work on it instead.

```bash
git clone https://github.com/Abhijeet34/treadling.git
cd treadling
npm ci
```

## Quick start

```bash
export TREADLING_ACTOR=your-name   # and TREADLING_ACTOR_KIND=agent when an agent runs it
treadling init
treadling file story "Field edits"
treadling show field-edits
treadling backlog
treadling status
```

`file` prints the id it minted on its `item` line, and that id is the title as a slug, which is why `show field-edits` reads the record back.
`backlog` lists what is open and names the filter it used; `status` counts the workspace rather than printing a record.
`status` also says when no write can pass, on a `writes` line with the remedy that clears it, because a store that refuses every write is the most important fact about a workspace and the count above it would otherwise read as health.
`treadling help <command>` is the contract for one command, and `treadling help` on its own is the whole inventory.
From a clone rather than an install, `node bin/treadling.js` replaces `treadling` in every line above and takes the same arguments.

`TREADLING_ACTOR` is who the event log records for every change you make, and `--actor <name>` overrides it for one command.
A command that would write an event refuses instead of recording one when neither names anyone, so no workspace ever holds an event nobody is attributable for.

That refusal is worth reading precisely, because it makes the recorded name look stronger than it is.
The actor is declared by whoever ran the command and recorded as given; treadling verifies no identity and has no way to.
What is unforgeable sits one layer out: the record file is committed, and the forge's signed commit is what proves who wrote it.
`treadling help` says the same sentence to a caller, and `treadling doctor` reports a record that no longer agrees with the log that recorded its value.

`npm run check` is the gate: types, then the suite, then the bundle.
Development itself needs no build step: Node runs the TypeScript directly.
The suite ran 2,162 tests in 99 seconds on Node 24.15.0 on 2026-09-10, which is the floor `.nvmrc` pins and `package.json` declares rather than whatever the machine had.
Most of that time is 73 real child processes across the concurrency and durability suites, and 500,000 fuzzed inputs per run.
The seconds are a machine measurement rather than a budget, which is why they carry their date; [docs/VERIFICATION.md](docs/VERIFICATION.md) is where a figure with a claim behind it lives.

```bash
npm test         # node --test over test/**/*.test.ts, no build step
npm run check    # tsc --noEmit under strict, the tests, then the bundle
npm run build    # dist/treadling.js, weighed against the DR8 bundle budget
npm run coverage # the suite under coverage, held to a per-file gate
npm run flake    # 20 consecutive full runs, budget zero
```

[docs/VERIFICATION.md](docs/VERIFICATION.md) is the table of what is measured, what each figure is, and what is not proven.

A published install carries one file of executable code: `npm run build` bundles the tree into `dist/treadling.js` with esbuild, and that bundle plus the JSON Schemas and the licence files is the whole tarball.
The budget is 768,000 bytes, recorded in `bench/budgets.json` as DR8's 768,000 bytes raised by [ADR-0027](docs/architecture/adr/0027-the-bundle-budget-moves-once-with-the-measurement-that-moved-it.md), and the build fails rather than warns if the bundle goes over.
The build prints the byte count and the margin every time it runs, and `.github/workflows/ci.yml` runs it on every pull request, so the budget is enforced rather than asserted.

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

See [Status](#status) for what is shipped, and what was declined or is blocked.

- **Types that mean something.** A bug without repro steps and a severity is refused at creation. A story without an acceptance criterion can exist as a draft and can never reach `ready`, because `DOR4` refuses it and `treadling explain <id>` names the rule.
- **One lifecycle, with guards.** Every state change goes through one table, so an illegal move fails with the id of the rule it broke rather than succeeding quietly. A story and a bug pass through `in_review` on the way to `done`; an epic, a task, a spike and an impediment do not, and `treadling explain <id>` lists only the moves that item's own type allows.
- **The human in the loop, as configuration.** `config` sets what `ready` and `done` mean for this workspace, which types pass through review, how much may sit in `in_review` at once, and what `next` weighs. An agent cannot skip a gate a person set, and a refusal names the rule and prints the line that clears it.
- **Ambiguity removal as the feature.** Every state has a rule that explains it, every absence has a reason, every mutation has a dry run, and every record has an event history that `treadling history <id>` reads back with the actor on every change. A mutation hands back the transaction id it wrote under, and `treadling history --txn <txn>` spends it: an agent auditing the command it just ran reads every record that one command moved, rather than one item at a time.
- **Finding work, and unfiling it.** `backlog --title <words>` searches titles by their words, `--label <slug>` filters on a label and `--fields +labels` prints the list, and `remove` takes a mis-filed record out of its shard while the append-only log keeps every event it earned, so `history <id>` still answers after it. A removal is refused wherever another record would be left naming it: [ADR-0024](docs/architecture/adr/0024-a-record-leaves-the-store-and-the-log-keeps-it.md).
- **Output an agent can parse and a person can read.** One result object, three renderings, chosen by one rule: `--out`, or the terminal test when `--out` is absent.

## Status

| Area | State |
|---|---|
| Domain core: types, lifecycle, relations, hierarchy, gates | Shipped |
| Store: month shards, event log, lock, compare-and-set, transactions, workspace configuration | Shipped: [ADR-0002](docs/architecture/adr/0002-storage-layout.md) to [ADR-0006](docs/architecture/adr/0006-the-store-seam.md), [ADR-0026](docs/architecture/adr/0026-workspace-configuration-is-the-policy-seams-second-implementation.md) |
| Store: `migrate` | Declined [ADR-0003](docs/architecture/adr/0003-record-format-and-migration.md) No schema 2 exists, and `S9` names the reason on the day one does. |
| Commands: `init`, `file`, `show`, `backlog`, `transition`, `set`, `mark`, `evidence add`, `relation add`, `relation remove`, `remove`, `config`, `config set`, `doctor`, `next`, `explain`, `history`, `status`, `help`, `version` | Shipped |
| Commands: `gate` | Declined [ADR-0035](docs/architecture/adr/0035-a-verdict-that-records-nothing-and-a-rendering-for-a-person-go.md) One verdict and no record, over a question `explain` already answers with the failing rules of both gates. |
| Renderings: `--out md` | Declined [ADR-0035](docs/architecture/adr/0035-a-verdict-that-records-nothing-and-a-rendering-for-a-person-go.md) The records are already committed Markdown, so a second one renders a command's result for a person rather than for an agent. |
| Renderings: `csv` | Declined [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) Threat-model finding F4 closes by absence, since the formula guard has nothing to guard. |
| Hooks, and the adapter generator | Declined [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) An executable named in a cloned repository is the surface the threat model refuses. |
| Impediments: a type with `severity` and `proposed_resolution` required, blocking work through `relation add` | Shipped: [ADR-0017](docs/architecture/adr/0017-an-impediment-is-a-type-that-blocks.md) |
| `history --txn`, which resolves a transaction id back to the events it wrote | Shipped: #61 |
| `doctor`: fifteen findings over records, the event log, the relation graph, the parent hierarchy, impediments and the workspace's configured thresholds | Shipped |
| Benchmarks: corpora, cold-process timing, byte and token accounting, the DR8 gate | Shipped: ten of the twelve comparison axes measured, two not; A11 Declined [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) |
| Build: one esbuild bundle, weighed against DR8's 768,000 bytes | Shipped: [ADR-0027](docs/architecture/adr/0027-the-bundle-budget-moves-once-with-the-measurement-that-moved-it.md) |
| Release: version and changelog through release-please, the cross-platform matrix gates the tag rather than a signature, SBOM, checksums, build provenance | Shipped: [ADR-0037](docs/architecture/adr/0037-the-automation-cuts-the-tag-and-no-release-carries-a-human-signature.md); a failing check spends no version number, because the automation cuts the tag itself, behind the matrix; fired six times, on `v0.1.0` through `v0.2.1`, and the last three carry all three assets ([docs/RELEASING.md](docs/RELEASING.md)) |
| Published package | Shipped: `@abhijeet34/treadling@0.2.1` on the npm registry since 2026-09-10, scoped because npm refused the unscoped name ([ADR-0039](docs/architecture/adr/0039-the-published-name-is-scoped-and-the-similarity-gate-is-only-observable-on-a-publish.md)); published by hand, not by the release run |
| Publishing from the release run | Blocked on the `NPM_PUBLISH_ENABLED` repository variable, which does not exist, on the `npm-publish` environment, which does not exist, and on a trusted publisher that has not been registered; the `publish` job has never run ([docs/RELEASING.md](docs/RELEASING.md)) |

Every row's State is one of four words, and each carries a pointer this repository holds it to.
**Shipped** names the record or the commit, **Queued** names an item in `.work` that is `ready` or `draft`, **Declined** names the record that refused it with one sentence of reason, and **Blocked** names what has to happen elsewhere before the row can move at all.
`test/architecture/documented-numbers.test.ts` reads this table: the Queued rows and the items `.work` holds in `ready` or `draft` are one set in both directions, so an item somebody could pick up cannot sit here unnamed, and a Declined row has to name a file that exists.
No row is Queued today, because [ADR-0035](docs/architecture/adr/0035-a-verdict-that-records-nothing-and-a-rendering-for-a-person-go.md) cut the last two.

Thirteen of the thirteen findings in the project's threat model are closed, each naming a regression test that was shown to fail before it passed.
In the store: incomplete rejection of bidi and invisible characters, prototype pollution through the record field-key grammar and the event log, missing ceilings on file size, event count and traversal depth, and a predictable temp-file name without an exclusive create.
In the output contract: a multi-line description forging lines in the agent stream, a column appended after a space-bearing one corrupting the row split, record content reaching a verbose log, and the data-versus-instruction boundary being legible to a parser but not to a model.
In the supply chain: the three unstated controls, which are now `ignore-scripts=true` in a committed `.npmrc`, a committed lockfile that every workflow installs with `npm ci`, and an SBOM with build provenance on the release path.
Four closed by having their surface removed rather than guarded: the hook contract that would have executed a program named in a cloned repository, the path rule that came with it, and the adapter generator that does not exist, all argued in [ADR-0012](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md); and CSV formula injection, which has no formula to guard now that [ADR-0035](docs/architecture/adr/0035-a-verdict-that-records-nothing-and-a-rendering-for-a-person-go.md) has cut the Markdown export it was waiting on.

## treadling's own backlog

`.work/` is a treadling workspace holding this project's work, filed with the tool itself.
It is the proof that the tool can manage its own backlog, and it is readable and reviewable as markdown without running anything:

```bash
treadling status                                  # where the project stands
treadling next                                    # what to pick up, and why that order
treadling backlog --state all                     # every record, not only the open ones
treadling history gate-command                    # the log still answers for a removed record
```

Six items, and every one of them is `done`, so `treadling backlog` prints an empty open list rather than a queue.
The six that are `done` carry the commit that shipped them as evidence, and each says in its description which part of it shipped.
Nine more left the workspace through `treadling remove`, which takes a record out of its shard and keeps every event it earned, so `treadling history <id>` still answers for each of them with the actor and the reason.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - the layers, the dependency direction, and the six seams.
- [docs/DOMAIN.md](docs/DOMAIN.md) - the domain core's public surface and the rule ids its errors name.
- [docs/architecture/adr/](docs/architecture/adr/README.md) - one record per decision, with what it departs from and why.
- [docs/STABILITY.md](docs/STABILITY.md) - what counts as a breaking change, and the pre-1.0 policy.
- [docs/RELEASING.md](docs/RELEASING.md) - how a release happens, why no release carries a human signature, what still stands between the release run and npm, and how to roll one back.
- [docs/PROVENANCE.md](docs/PROVENANCE.md) - how this was built, and why no third-party notice attaches.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) - every claim this project makes about itself, with the measurement behind it and the ones that are not proven.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md).

Every figure in this file that can be derived from the tree is held to it by `test/architecture/documented-numbers.test.ts`: the command list against the inventory, the type count against `WORK_ITEM_TYPES`, the backlog figures against `.work`, the doctor's finding ids and their count against what `doctor` raises, the threat model's totals against the register in `test/security/findings.test.ts`, the axis counts against what the rig emits, the rendering count against `RENDERINGS`, the seam count against the table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the Node floor against `engines.node`, and the bundle budget against `bench/budgets.json`.
Every number that test now checks was correct on the day it was written and went stale in silence, which is the case a habit does not catch and a test does.
What it deliberately does not check is a measurement: a wall time, a test count, a byte count of the tree or a coverage decimal is a figure of a run rather than of a tree, and moves on a commit that changed nothing about the claim. [docs/VERIFICATION.md](docs/VERIFICATION.md) carries those with the run they came from, and what the test holds about the two in the paragraph above is that neither is ever printed here without the runtime and the date it was measured on.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
