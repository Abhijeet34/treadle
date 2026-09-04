## What this is for

The original intent. What problem does this solve, and for whom?
Link the issue if there is one.

## What changed

The approach, and why this one rather than the alternative you rejected.

## How it was tested

Paste the runner's own output, not a summary of it.
A behaviour change needs a test that failed before and passes after: paste both runs.

```text

```

## Checklist

- [ ] Every commit is signed off (`git commit -s`); CI checks this.
- [ ] Every commit message follows Conventional Commits; CI checks this.
- [ ] `npm run check` passes locally.
- [ ] Every new source file carries `SPDX-License-Identifier: Apache-2.0`.
- [ ] No new runtime dependency, or a decision record explaining one.
- [ ] If this breaks the command-line surface, an exit code, the output schema or the file format, it is named here and in `docs/STABILITY.md` terms.
