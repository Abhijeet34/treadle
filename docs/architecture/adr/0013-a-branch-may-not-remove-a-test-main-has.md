# ADR-0013: A pull request may not remove a test that main has, and the check that says so is required outside the branch

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** nothing in the design record; it answers an incident in this repository's own history
**Departs from:** [ADR-0009](0009-release-and-supply-chain.md)'s single required status context

## Context

Pull request 28 landed the acceptance-criteria readback and the one convention for the `what` column of `history`.
Pull request 29 was rebased onto that main, four service files conflicted, and the conflicts were resolved by taking the pre-rebase file whole.
That threw away every line 28 had added to those files, and the tests 28 had added with them.

The suite passed.
1132 tests, zero failures, and all ten checks green, because the resolution deleted the tests along with the code they covered.
A test protects a behaviour only while the test survives, so a green suite is not evidence that the suite is intact.
It was caught by a person building both branches and running `treadle show cart --field ac` against each: `ac 0/1` on the branch, the criteria block on main.

The reconstruction is in this repository's history rather than in prose.
A branch off `3bce1ca` with the four service files and their tests returned to their pre-28 state typechecks clean and reports **1122 tests, 0 failures**, while `treadle set cart acceptance_criteria=...` echoes `[object Object]` and `show cart --field ac` prints `ac 0/1` and nothing else.
`docs/VERIFICATION.md` carries both transcripts.

The one sentence that decides the design: **a guard that lives only in the branch it protects is not a guard.**
Whatever is built has to still be true after a resolution deletes everything the branch touched, which means it compares against `main` rather than trusting the branch's own contents.

## Decision

### The unit is a test title, and the fact is main's

`scripts/check-tests-kept.ts` reads the set of test titles at the merge base of `origin/main` and the branch, reads the same set at the branch head, and refuses when a title main runs is one the branch no longer runs.
The merge base is a commit on `main`, so the branch cannot edit what it says.
`strict_required_status_checks_policy` in `.github/rulesets/main.json` is what keeps that merge base at main's tip: a branch behind main cannot merge, so the comparison a merge is gated on is against main as it is.
Comparing against main's tip directly instead would read a test main gained after the fork as one this branch deleted, which is a false positive on every branch that is merely a few commits old.

Titles are counted rather than set-membered, and the count is repository-wide rather than per file.
A test that moves between files keeps its title and its count, so a refactor that moves a suite is silent; deleting one of two identically titled tests is still a shortfall of one.

A title the branch keeps but marks `.skip` or `.todo` counts as removed.
A skipped test runs nothing and asserts nothing, so the alternative is a check a resolution can satisfy by adding four characters.

### The declaration is a commit trailer, one per title

A removal that is meant is declared with `Removes-test: <the exact title>` in a commit in the pull request's own range, and `CONTRIBUTING.md` carries the wording.
It cannot be reached by accident, because it requires typing a test's exact title into a commit message.
It cannot become a way to turn the check off, because one trailer covers one title: silencing a forty-test revert takes forty trailers, each visible in the diff of the pull request that carries them.
A trailer naming a title that nothing in the range removed is itself a failure, so a declaration written ahead of time, or left behind after the removal was reverted, is caught rather than accumulated.

The trailer needs no pruning later.
The range is the pull request's own commits, so a trailer that merges into main is out of range for every pull request after it.

### The job is required by name, outside the workflow file

`.github/rulesets/main.json` requires the `tests kept` context beside `checks`.
This is the part of the decision that is not a convenience.
`checks` is an aggregate that `needs:` the jobs in its own workflow, and that workflow file is in the branch: a resolution that deleted the `tests-kept` job from `.github/workflows/ci.yml` would leave `checks` green with the guard gone, which is the exact failure mode the guard exists to stop.
A required context named in the ruleset is a fact on the forge.
A branch that deletes the job never reports it, and a required check that never reports blocks the merge.

The cost is a rule the workflow's own header used to state: every job could be added or renamed without touching the ruleset.
That is now true of every job but this one.

## Alternatives considered

### A manifest of behaviours checked against the built binary

Heavier, and it catches more: a manifest of commands and expected output, run against `dist/treadle.js`, would have caught the `ac 0/1` regression directly rather than through the test that covered it.
It catches the revert that keeps a test's title and guts its body, which the chosen mechanism does not see at all.

Rejected on the maintenance ratio.
A behaviour manifest is a second suite that has to be kept honest against the first, and it has the same property the deleted tests had: it lives in the branch, so a resolution that reverts a service file and its manifest entry together is invisible again unless the manifest is also compared against main, at which point it is the chosen mechanism with a larger surface to write and keep true.
The chosen check reads 772 of this repository's 773 test declarations for free.

### A diff-level check that the branch does not delete lines main added

Cheaper and noisier.
Every rebase, every reformat and every legitimate rewrite deletes lines main added, so the signal is a rate rather than an event, and the only honest threshold is one a maintainer would learn to wave through.
It also cannot tell a deleted assertion from a deleted blank line without a language-aware pass, which is most of the work of the chosen mechanism with none of its precision.
False positives are the failure mode that kills a check like this, and this is the design that maximises them.

## Consequences

Measured over every pull request in this repository's history, all 28 of them, 24 pass untouched.
Four would have needed a declaration, nine trailers between them, and every one of the nine is a test whose title changed because the behaviour it names changed: `carries the five components of each row` to `carries the six`, `S3: a duplicate id refuses the write` to `refuses every answer`.
That is the intended cost rather than a false positive, and it is one line in a commit message for a change that already had to be argued in review.

The reconstruction of the incident fails the check with 32 titles named, against a suite that reports 1122 of 1122 passing on the same tree.

`test/architecture/tests-kept.test.ts` drives the script over throwaway repositories the way `dco.test.ts` drives `check-dco.sh`, and its last suite points at this repository: every declaration here must be readable by the gate, so a file that stops writing its declarations where the gate reads them fails in the suite rather than passing quietly in CI.

## Departures from the design record

**[ADR-0009](0009-release-and-supply-chain.md) has one required status context and this makes two.**
The single-context rule was written so that jobs could be added and renamed freely in one file, and it is a good rule for every job whose absence a green `checks` would not misreport.
It is the wrong rule for a job whose whole subject is that a branch can delete the thing that would have caught it.
Renaming `tests-kept` now means editing `.github/rulesets/main.json` in the same change, and `scripts/apply-repo-settings.sh` is the only thing that applies it.

**Nothing in the design record asked for this.**
The design's answer to a lost fix is review, and review is what caught this one, on the day after it merged and by rebuilding two branches by hand.
That is the argument for the check rather than against review: the reviewer had to do the tool's work to see it.

## What would reopen this

A revert that keeps every test title and empties the bodies, which the chosen mechanism cannot see.
That is the case a behaviour manifest checked against the built binary answers, and the record above prices it.
`docs/VERIFICATION.md` names it under "What check-tests-kept does not see" so it is a known gap rather than a discovered one.
