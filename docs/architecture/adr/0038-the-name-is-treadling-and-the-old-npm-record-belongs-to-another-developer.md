# ADR-0038: The name is `treadling`, and the old npm record belongs to another developer

**Status:** Accepted
**Date:** 2026-09-10
**Decided by:** the captain, on 2026-09-10
**Overtakes in part:** [ADR-0009](0009-release-and-supply-chain.md)'s identity gate, whose verdict was that the name stands for the repository, the code and the documentation and does not stand for publication until a sixteen-source clearance screen has run. The screen has now run, on a different word. Everything else ADR-0009 decided stands, and its own spelling of the old name is left where it is.
**Overtaken in part by:** [ADR-0039](0039-the-published-name-is-scoped-and-the-similarity-gate-is-only-observable-on-a-publish.md), which moves the package name alone to `@abhijeet34/treadling` after npm refused the unscoped name as too similar to `readline`; the command, the `TREADLING_*` environment variables, the repository and the word itself stand

## Context

### The name was not free, and the probe that said it was could not tell

`npm publish` was refused on 2026-09-10 with `403` and the text `You do not have permission to publish "treadle". Are you logged in as the correct user?`.
The debug log shows the first `PUT` answered `401`, the browser two-factor check completing, and the second `PUT` answered `403`, so authentication and the second factor both succeeded and the refusal is an authorization decision on the name itself.

The registry holds an access-control record for `treadle` and no package document behind it.

```text
$ curl -sS -w ' [http %{http_code}]' https://registry.npmjs.org/-/package/treadle/collaborators
{"timileyindev":"write"} [http 200]

$ curl -sS -w ' [http %{http_code}]' https://registry.npmjs.org/-/package/treadle-zq9-control-never-existed/collaborators
{"error":"Package not found"} [http 404]

$ curl -sS https://registry.npmjs.org/treadle
{"error":"Not found"} [http 404]
```

That pair is the whole lesson.
`GET /<name>` and `npm view <name>` read the package document, and a reserved name with no document answers `404` there, which reads as free.
`GET /-/package/<name>/collaborators` reads the ownership record, which is what the publish checks, and it answers `404 Package not found` only when the name is genuinely unheld.
The clearance screen's npm source uses the first probe, so it reported `treadle` free on 2026-09-04 and again on 2026-09-06 while another user already held the write record.
A screen whose npm source cannot see a reservation cannot clear a name for publication.

### The owner is real, the package is real, and npm transfers nothing on demand

`timileyindev` is the GitHub user `timileyinpelumi`.
Their repository `treadle` was created `2026-09-06T13:20:13Z`, is not a fork, is MIT licensed, and holds a Bun and Postgres job-queue library whose manifest is `"name": "treadle"`, `"version": "0.1.0"` and whose README opens with `bun add treadle`.
This repository was created `2026-09-04T18:34:37Z`, two days earlier, and the two codebases share nothing but the word.

npm's disputes policy has said since 2026-04-20 that npm "does not resolve squatting claims on demand" and that the formal trademark process is "the only path we act on".
The one ground it still recognises is a package with no genuine function, and theirs has one.
There is no trademark here to assert.

Ownership does not lapse either.
`micro-tree` was fully unpublished by its owner on 2019-04-30 and its collaborators endpoint still answers `{"torathion":"write"}` seven years on, so waiting frees nothing.

The name is theirs under first-come first-served.
That is the fact this record is built on, and it is not a grievance: they got there first with a working library.

### Nothing is published yet, so the command name is free exactly once

Three tags exist and none produced a package.
The typed command, the environment variable prefix and the repository name have no installed base to break, and that is only true until the first successful publish.
A rename after publication costs users a reinstall and leaves the old command resolving to somebody else's library; a rename now costs one mechanical sweep.

## Decision

### The package, the command, the environment variables and the repository are `treadling`

`treadling` is the weaver's word for the order in which the treadles are pressed, which is what makes the cloth's pattern.
It keeps the metaphor the identity gate chose and extends it from the pedal to the rhythm the pedal produces, which is closer to what this tool records than the pedal was.

It cleared every source the sixteen-source screen could reach on 2026-09-10:

| Source | Answer |
|---|---|
| npm ownership record, `GET /-/package/treadling/collaborators` | `404 Package not found`, free |
| US register, exact | 0 marks; the 37 one-edit neighbours are the `TREADING` and `TREADLINE` family in classes 25, 27 and 35, and nothing sits in class 9 or 42 at any status |
| crates.io, PyPI | `404`, free on both |
| Wiktionary | a dictionary word in English |
| GitHub, Homebrew, the marketplaces, the semantic sources | clean |

The change is one token everywhere it appears: `treadle` to `treadling`, `TREADLE_` to `TREADLING_`.
`package.json` carries `"name": "treadling"` and `"bin": {"treadling": "dist/treadling.js"}`, the development shim moves to `bin/treadling.js`, the thirteen `TREADLE_*` names the tool and its suites read become `TREADLING_*`, and the tarball globs and the smoke install in the workflows follow the tarball's new name.

### The `repository` field moves with the repository, and it is not cosmetic

npm's trusted publishing matches the manifest's `repository.url` against the repository the workflow runs in, case-sensitively, before it will attest a publish.
A manifest still pointing at `Abhijeet34/treadle` after the repository is renamed fails at the registry with the tag already cut and immutable under `.github/rulesets/tags.json`, which is the most expensive place in this pipeline to discover a typo.
So `repository`, `bugs` and `homepage` all name `Abhijeet34/treadling`, and the repository is renamed on the forge to match.
GitHub keeps a redirect from the old path, so the links already published in `CHANGELOG.md` keep resolving.

### The records that spelled the old name keep it

Seven kinds of passage are left spelling `treadle`, each because rewriting it would falsify a record rather than update one, or because the passage names the retirement itself:

- Generated release history. `CHANGELOG.md` is written by release-please, and its entries and links are release history.
- Measured figures. `docs/architecture/history/BENCHMARKS-2026-09.md`'s numbers are facts about runs taken under the old name.
- This repository's own workspace, none of it hand-edited: the append-only event log, the month shard and the workspace record, whose header names the workspace by the id `init` gave it.
- Every decision record, including this one, ADR-0037 and the ADR index, because a decision record is never rewritten; a later record marks one overtaken instead of rewriting it. `test/architecture/retired-names.test.ts` allowlists the whole `docs/architecture/adr/` directory rather than naming each file inside it.
- The retired-names test itself, which allowlists itself and names `treadle` once as the retired name and once in a historical comment, by design.
- Four measured quotes of the release-please branch name as the run answered it, `release-please--branches--main--components--treadle`, each beside a sentence saying why: two in `docs/RELEASING.md`, one in `docs/VERIFICATION.md` and one in ADR-0037.
- Prose in a live document that spells `treadle` in order to say the name is retired: one sentence each in `AGENTS.md`, `README.md` and `docs/RELEASING.md`. Each sentence's subject is the retirement itself, and `test/architecture/retired-names.test.ts` admits it through its `SAYS_IT_WENT` context window rather than through the file allowlist, so it is gated on wording rather than exempted by path.

`test/architecture/retired-names.test.ts` gains `treadle` as a retired name, so the sweep that already refuses a stale `sprint_id` now refuses a stale `treadle` anywhere outside the passages named above.

Measured at this record's own final revision with `git grep -oIni 'treadle' -- . | wc -l` for the total and the same command piped to `cut -d: -f1 | sort | uniq -c` for the per-file count, since `treadling` does not contain `treadle` and a plain substring count is exact:

| File | Occurrences |
|---|---|
| `CHANGELOG.md` | 170 |
| `docs/architecture/history/BENCHMARKS-2026-09.md` | 43 |
| `docs/architecture/adr/0009-release-and-supply-chain.md` | 15 |
| `docs/architecture/adr/0038-the-name-is-treadling-and-the-old-npm-record-belongs-to-another-developer.md` (this record) | 33 |
| `docs/RELEASING.md` | 3 |
| `test/architecture/retired-names.test.ts` | 3 |
| `.work/workspace.md` | 2 |
| `AGENTS.md` | 2 |
| `docs/architecture/adr/0037-the-automation-cuts-the-tag-and-no-release-carries-a-human-signature.md` | 1 |
| `docs/architecture/adr/README.md` | 1 |
| `docs/VERIFICATION.md` | 1 |
| `README.md` | 1 |
| `.work/items/2026-09.md` | 1 |
| `.work/events/2026-09.jsonl` | 1 |
| **Total** | **277** |

This table is exhaustive as of this revision: it is every row `git grep -oIni 'treadle' -- .` reports, and its occurrence column sums to the total `git grep -oIni 'treadle' -- . | wc -l` gives. A later change that adds or removes a surviving occurrence makes this table stale until both commands are re-run and the table is rewritten to match.

## Alternatives measured

| Alternative | Rejected because |
|---|---|
| `@abhijeet34/treadle`, the user scope | Keeps the word and inherits the ambiguity permanently: `npm install treadle` would one day install a Bun job queue, and `npx treadle` would never resolve here. It also binds the package to a personal username scope, which cannot be renamed without a second name change |
| `@treadle/cli`, an org scope | The same ambiguity, plus a GitHub organisation `treadle` already exists (created 2022-10-09), and the org name would sit beside the owner's unscoped `treadle` |
| Asking the owner to hand the name over | Public contact points exist, but the name is theirs, their README states an intent to publish under it, and nothing obliges them. The mechanics are unproven as well: `npm owner add` reads the package document with `?write=true` first, and that read answers `404` today. A low-probability path with an unbounded wait, and it should not gate the release |
| Waiting for the reservation to lapse | It does not. `micro-tree` still names its owner seven years after a full unpublish |
| `footloom`, the treadle loom itself | Cleared every reached source too, and the captain chose `treadling`. Recorded so the second-best is not re-derived |
| `warpbeam` | Cleared, with one soft signal: a GitHub user `warpbeam` exists. It also names the beam the warp is wound on rather than the pedal, so it keeps the loom and drops the motion |
| Publishing under `treadle` anyway from a scoped or renamed manifest | There is nothing to publish it from. The name is the identity, and half a rename is worse than either whole |

## Consequences

**Positive**

- The install command, the `npx` invocation and the typed command all name one thing, and none of them can resolve to a different library.
- The clearance screen's npm probe is now known to be the wrong one, which is a defect in the screen rather than in this repository, and this record names it so the next name is screened with `GET /-/package/<name>/collaborators`.
- The rename landed while nothing was published, which is the only window in which the typed command is free.

**Negative**

- 1,374 occurrences across 186 files moved in one sweep, measured on `b6e613d` and again on the branch before it was applied. A mechanical change that large is reviewed by its count and its residue rather than by reading it, which is why `retired-names.test.ts` now holds the residue.
- The repository rename leaves every previously published link depending on GitHub's redirect. The redirect is permanent and free, and it is still a dependency this repository did not have yesterday.
- Three tags and three releases carry the old name in their assets, and they are immutable. `v0.1.0` through `v0.1.2` will always be `treadle` releases of a package called `treadling`.

## What is not known

The EU, UK and Indian trademark registers were not read.
They are unread rather than clear, and this record says so rather than rounding them up.

npm's similarity gate runs only on a real publish `PUT`.
The registry's search index holds nothing at all near `treadling`, which lowers the odds of a collision without removing them.
No probe short of publishing proves the name passes that gate, and that is inference rather than measurement.

## What would reopen this

- The similarity gate refusing `treadling` on the first real publish, which is the one check no probe can anticipate.
- A live mark on `TREADLING` in a register this screen did not read, in a class that covers software.
- npm changing the disputes policy back to a process that acts on a name held with no published version, which would make the old name recoverable rather than settled.
