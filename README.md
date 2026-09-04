# treadle

Agile work management for a team and its agents, over files you commit to git.

A backlog that lives in a database is a backlog you cannot branch, diff, or review.
A backlog that lives in a hand-written markdown list is one the tool cannot enforce anything about.
treadle takes the first horn: the human-readable files are the source of truth and they are committed, and the tool earns its keep by validating them on load, refusing what breaks a rule, and naming the record that broke it.

**This repository currently ships the domain core and the store layer.**
There is no command to run yet.
What exists is the part every later layer is built on: the six work-item types and their required-field policies, one enforced lifecycle, the typed relation graph, parent/child hierarchy with roll-up, the definition-of-ready and definition-of-done evaluator, and underneath them the on-disk store: month-sharded record files, an append-only event log, a derived SQLite index that is safe to delete at any moment, and an advisory lock with compare-and-set.
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

There is no binary yet, so the quick start is the test suite: 419 tests, no build step, about 9 seconds, most of it the concurrency suite's 37 child processes.

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

## What it will do

Each of these is specified and none is implemented yet.

- **Types that mean something.** A bug without repro steps and a severity is refused at creation. A story without an acceptance criterion can exist as a draft and can never enter a sprint.
- **One lifecycle, with guards.** Every state change goes through one table, so an illegal move fails with the id of the rule it broke rather than succeeding quietly.
- **Sprints and boards, both first class.** A team can run sprints and still enforce column limits.
- **Ambiguity removal as the feature.** Every state has a rule that explains it, every absence has a reason, every mutation has a preview and a dry run, and every record has an event history.
- **Output an agent can parse and a person can read.** One result object, three renderings, chosen by one rule: `--out`, or the terminal test when `--out` is absent.

## Status

| Area | State |
|---|---|
| Domain core: types, lifecycle, relations, hierarchy, gates | Implemented |
| Store: month shards, event log, derived index, lock, compare-and-set, transactions | Implemented for work items and events |
| Store: sprint, impediment and ceremony records; `migrate` | Specified, not implemented |
| CLI, renderers, exit codes, help generation | Specified, not implemented |
| Sprints, boards, ceremonies, metrics, impediments, doctor | Specified, not implemented |
| Published package | Blocked on a name clearance that has not run |

Nine of the thirteen findings in the project's threat model land in layers that do not exist yet.
Four land here and are closed, each with a regression test that was shown to fail before it passed: incomplete rejection of bidi and invisible characters, prototype pollution through the record field-key grammar and the event log, missing ceilings on file size, event count and traversal depth, and a predictable temp-file name without an exclusive create.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - the layers, the dependency direction, and the six seams.
- [docs/DOMAIN.md](docs/DOMAIN.md) - the domain core's public surface and the rule ids its errors name.
- [docs/architecture/adr/](docs/architecture/adr/README.md) - one record per decision, with what it departs from and why.
- [docs/STABILITY.md](docs/STABILITY.md) - what counts as a breaking change, and the pre-1.0 policy.
- [docs/PROVENANCE.md](docs/PROVENANCE.md) - how this was built, and why no third-party notice attaches.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
