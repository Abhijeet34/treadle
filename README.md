# treadle

Agile work management for a team and its agents, over files you commit to git.

A backlog that lives in a database is a backlog you cannot branch, diff, or review.
A backlog that lives in a hand-written markdown list is one the tool cannot enforce anything about.
treadle takes the first horn: the human-readable files are the source of truth and they are committed, and the tool earns its keep by validating them on load, refusing what breaks a rule, and naming the record that broke it.

**This repository ships the domain core, the store layer, and a command surface enough to dogfood the tool on its own backlog.**
The domain core has the six work-item types and their required-field policies, one enforced lifecycle, the typed relation graph, parent/child hierarchy with roll-up, and the definition-of-ready and definition-of-done evaluator.
Underneath it the store has month-sharded record files, an append-only event log, a derived SQLite index that is safe to delete at any moment, and an advisory lock with compare-and-set.
`bin/treadle.js` runs `init`, `file`, `show`, `backlog`, `transition`, `next`, `explain`, `status`, `help` and `version` over that store, through application services, rendered as one result object in three forms.
See [Status](#status) for what is and is not here.

## Requirements

Node.js 24.15 or newer.
The floor is the oldest Node.js release line still inside its official support window at release time, and it is reviewed at every Node LTS transition rather than when something breaks.
A release never ships with a floor on a line that reaches end of life within six months of that release date.

The published package has zero runtime dependencies, and that is a budget rather than a coincidence: the index is `node:sqlite`, argument parsing is `node:util`, hashing is `node:crypto`, and the record format is this project's own grammar.

## Install

Nothing is published yet.
Publication is gated on a name clearance that has not run, so `package.json` carries `"private": true` and `npm publish` refuses.
Clone the repository to work on it.

```bash
git clone https://github.com/Abhijeet34/treadle.git
cd treadle
npm ci
```

## Quick start

```bash
node bin/treadle.js init
node bin/treadle.js file story "Field edits"
node bin/treadle.js status
```

The test suite is 603 tests, no build step, about 9 seconds, most of it the concurrency suite's 37 child processes.

```bash
npm test        # node --test over test/**/*.test.ts, no build step
npm run check   # tsc --noEmit under strict, then the tests
```

The domain core is a library of pure functions.
Nothing in `src/domain` reads the filesystem, the clock, a random source, or the process, and a test enforces that rather than a comment asking for it.

```ts
import { DEFAULT_READY_GATE, evaluateGate, evaluateTransition } from './src/domain/index.ts'

const verdict = evaluateGate(DEFAULT_READY_GATE, {
  item: story, blockers: [], children: [], reviewStep: false, openImpediments: 0,
})
// verdict.rules -> one pass/fail per rule, each with the reason and what would satisfy it

const outcome = evaluateTransition({ item: story, readyGate: verdict, /* ... */ }, { target: 'ready' })
// outcome.outcome -> 'allowed' | 'refused' | 'already'
// a refusal names the guard it broke, so a caller looks the rule up instead of reading prose
```

## What it does

See [Status](#status) for the line between implemented and specified-only.

- **Types that mean something.** A bug without repro steps and a severity is refused at creation. A story without an acceptance criterion can exist as a draft and can never enter a sprint.
- **One lifecycle, with guards.** Every state change goes through one table, so an illegal move fails with the id of the rule it broke rather than succeeding quietly.
- **Sprints and boards, both first class.** Specified, not yet implemented: a team will be able to run sprints and still enforce column limits.
- **Ambiguity removal as the feature.** Every state has a rule that explains it, every absence has a reason, every mutation has a preview and a dry run, and every record has an event history.
- **Output an agent can parse and a person can read.** One result object, three renderings, chosen by one rule: `--out`, or the terminal test when `--out` is absent.

## Status

| Area | State |
|---|---|
| Domain core: types, lifecycle, relations, hierarchy, gates | Implemented |
| Store: month shards, event log, derived index, lock, compare-and-set, transactions | Implemented for work items and events |
| Store: sprint, impediment and ceremony records; `migrate` | Specified, not implemented |
| Application services, the result object, the JSON Schemas | Implemented for the commands below |
| Renderers: the compact agent line format, JSON, human | Implemented |
| Commands: `init`, `file`, `show`, `backlog`, `transition`, `next`, `explain`, `status`, `help`, `version` | Implemented |
| Anti-ambiguity: `--dry-run`, `--preview`, `--explain-absence`, ranking rationale | Implemented |
| Commands: `set`, `estimate`, `assign`, `link`, `unlink`, `split`, `undo`, `gate`, `history`, `doctor`, `config` | Specified, not implemented |
| Sprints, boards, ceremonies, metrics, impediments, export, hooks, completions | Specified, not implemented |
| Published package | Blocked on a name clearance that has not run |

Eight of the thirteen findings in the project's threat model are closed, each with a regression test that was shown to fail before it passed.
In the store: incomplete rejection of bidi and invisible characters, prototype pollution through the record field-key grammar and the event log, missing ceilings on file size, event count and traversal depth, and a predictable temp-file name without an exclusive create.
In the output contract: a multi-line description forging lines in the agent stream, a column appended after a space-bearing one corrupting the row split, record content reaching a verbose log, and the data-versus-instruction boundary being legible to a parser but not to a model.
The remaining five land in layers that do not exist yet.

## treadle's own backlog

`.work/` is a treadle workspace holding this project's remaining work, filed with the tool
itself. It is the proof that the tool can manage its own backlog, and it is readable and
reviewable as markdown without running anything:

```
treadle status                                  # where the project stands
treadle next                                    # what to pick up, and why that order
treadle explain history                         # why one item is still in draft
treadle backlog --state ready --explain-absence history
```

Eight of the sixteen items are still in `draft` because they are stories with no acceptance
criteria and the ready gate refuses them, which is the tool working rather than a gap in the
list. `treadle explain <id>` names the rule.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - the layers, the dependency direction, and the six seams.
- [docs/DOMAIN.md](docs/DOMAIN.md) - the domain core's public surface and the rule ids its errors name.
- [docs/architecture/adr/](docs/architecture/adr/README.md) - one record per decision, with what it departs from and why.
- [docs/STABILITY.md](docs/STABILITY.md) - what counts as a breaking change, and the pre-1.0 policy.
- [docs/PROVENANCE.md](docs/PROVENANCE.md) - how this was built, and why no third-party notice attaches.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
