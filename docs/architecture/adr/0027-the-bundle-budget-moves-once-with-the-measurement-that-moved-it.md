# ADR-0027: The bundle budget moves once, to 768,000 bytes, and the build stays unminified

**Status:** Accepted
**Date:** 2026-09-08
**Implements:** decision `bundle-budget`, registered by the remaining-surface design and decided by the captain

## Context

DR8 set the bundle at "at most 500 KB", written in `bench/budgets.json` as 512,000 bytes and enforced by `scripts/build.ts`, which fails rather than warns.
That number predates twenty of the twenty-one commands and every one of the seven work-item types: [0009-release-and-supply-chain.md](0009-release-and-supply-chain.md) records the first time it weighed a real bundle at 180,105 bytes.

The remaining-surface design measured what the tree costs and what the plan would add.

```text
$ npm run build            # at 069d7cb, the commit the design was written against
bundle: 414809 bytes against 512000 (DR8, 500 KB bundle), 1.2x under
rc=0
```

The margin was 97,191 bytes.
Two landed changes calibrate what a feature costs, each built from a `git archive` copy with `node_modules` symlinked in:

| Change | Bytes added | What it carried |
|---|---|---|
| `fbab9fb`, sprints ([0016-sprints.md](0016-sprints.md)) | 38,711 | a domain module of 302 lines, a codec of 131, a service, an index table, a port method, the CLI verbs |
| `91916bf`, #55: labels, sprint editing, title search, removal | 19,083 | a 224-line service, three filters, a store transaction kind, an index column |

Against those two points the design estimated the remaining eleven tasks at about 128,000 bytes, which is 31,000 over the margin.
It offered three ways out and the captain decided the first: raise the budget by this record, rather than minifying and rather than cutting scope.

## Decision

### The budget is 768,000 bytes, which is 750 KiB in the units the old number was written in

The derivation, from the one piece that has now landed rather than from the estimate alone.

```text
$ npm run build            # at 3bd8b1f, this branch's base
bundle: 419191 bytes against 512000 (DR8, 500 KB bundle), 1.2x under
rc=0

$ npm run build            # with T1, workspace configuration, landed
bundle: 448772 bytes against 768000 (DR8 raised by ADR-0027, 750 KB bundle), 1.7x under
rc=0
```

T1 added 29,581 bytes against an estimate of 18,000, a ratio of 1.64.
The design's remaining nine estimates total 110,000 bytes; scaled by that one measured ratio they are 180,400, so the plan lands at about **629,172 bytes**.
768,000 is 1.22 times that, which is the headroom the old budget carried over the bundle it was measured against (512,000 over 419,191 is 1.22).

Two figures are stated rather than one, because the second is the one that would have been optimistic: taken at the design's own estimates the plan lands at 558,772 bytes, and 768,000 is 1.37 times that.
A budget derived from the optimistic figure would be 670,527, and a budget that has to be raised twice in one plan is not a budget.

### The build stays unminified, deliberately

`scripts/build.ts` chooses not to minify so that a stack trace in a bug report from a machine we cannot reach keeps its line numbers.
The design measured exactly what that costs, with the same entry point and target and `legalComments: 'inline'`, without the shebang banner:

```text
as shipped                                    414788 bytes
minifyWhitespace only                         310831 bytes
minifyWhitespace+syntax, identifiers kept     298972 bytes
full minify                                   227242 bytes
rc=0
```

Whitespace minification alone would have brought the plan inside the old budget and it puts the bundle on one line, which is the whole of what a line number in a stack trace is.
A stranger's bug report is the scarcest evidence this project gets, and 104,000 bytes of a 768,000-byte budget is what it costs to keep one readable.
This is a decision and not an omission, which is why it is written here rather than only in a build-script comment.

### The number lives in one file and the gate reads it

`bench/budgets.json`'s `absolute.bundleBytes` is the one place it is written.
`scripts/build.ts` reads it and fails over it, `npm run bench:gate` weighs the same number, `scripts/release-preflight.ts` refuses a release over it, and `test/architecture/documented-numbers.test.ts` holds the README's two quotations of it to that file.
So a number that moves in prose and not in the gate fails a test rather than shipping.

## Alternatives considered

**Turn on `minifyWhitespace`, measured at 310,831 bytes.**
Refused above, on the stack-trace argument DR1's build script already made.
It is the option to reopen if the budget is ever the binding constraint on shipping something a user asked for, rather than on shipping the plan the captain already approved.

**Cut scope.**
Not this record's to decide: the captain's decision `remaining-unbuilt-scope` took every option offered, including the two firstmate recommended against, and said so.

**Raise the budget to exactly the projection, with no headroom.**
Refused: the projection rests on one measured ratio and nine estimates, and the one estimate that has been measured was 1.64 times low. A budget with no headroom over a projection of that quality is a build that fails on the task that discovers the estimate was wrong again.

**Leave DR8's number and mark the build a warning rather than a failure.**
Refused: a budget nothing enforces is prose. [0009-release-and-supply-chain.md](0009-release-and-supply-chain.md) made the failure deliberate.

## Consequences

- `bench/budgets.json`'s `bundleBytes` limit becomes 768,000 and its `source` becomes `DR8 raised by ADR-0027, 750 KB bundle`, so a reader of the build line sees both the design record that set the rule and the record that moved the number.
- `scripts/release-preflight.ts`'s "under a tenth of the limit" floor rises with it, from 51,200 to 76,800 bytes. The current bundle is 448,772, so the floor is not near.
- The README's two quotations of the figure and `docs/BENCHMARKS.md`'s move with it, held by `test/architecture/documented-numbers.test.ts`.
- The measured margin becomes 319,228 bytes, which is 2.9 times what the remaining nine tasks estimate and 1.8 times what they estimate scaled by T1's own over-run.

## Departures from the design record

DR8 wrote a round number and no derivation.
This one carries the measurement, the two projections, the ratio between them and the date, because the design's own note on this decision is the one worth keeping: a budget that moves without an argument stops being a budget.

## What would reopen this

The plan landing over 629,172 bytes with tasks still to build, which is the projection this number was derived from and the thing a later task should measure rather than assume.
The next task to land should print its own before-and-after bundle line, as this one did, so the ratio is a series rather than a single point.
