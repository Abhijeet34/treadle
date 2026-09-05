# ADR-0012: The extension surface DR6 designed does not ship: no hook runs, and no adapter is generated

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** section 6 of the `treadle-board-outcomes-retention-b3` audit, and threat-model findings F1, F7 and F11
**Refuses:** DR6's hook contract, and A.8 rule 3's generated adapter, for v1

## Context

DR6 designed a hook as an external executable named in `workspace.md`, resolved relative to the workspace and run one at a time on every mutation, able to veto a proposal and never edit it.
DR5 reserved `HOOK_REFUSED` at exit 3 and `HOOK_FAILED` at exit 1 for it, and DR6's event-sink seam named hook dispatch as its second implementation.
A.8 rule 3 has an agent adapter generated on request and "written where the caller asks", never installed by default.

Neither is built.
`grep -rn "child_process\|spawn\|execFile\|node:vm\|eval(" src` returns one line, and it is a comment in `src/cli/entry.ts` about the test suite.
The `hooks` story sits in the backlog at priority 4 in `draft`, and its own description names findings F1 and F7 as landing with it.
So the decision below removes an unbuilt extension point rather than a shipped capability, which is the cheapest moment it will ever be available at.

The threat model rates the hook contract 7.8 (F1, clone-and-run code execution from a committed file) and pairs it with F7 at 7.5 (the path has no traversal rule, no symlink refusal and no argv-not-shell rule).
Its own words on why F1 is first: it is "the class that a shipped default cannot be walked back from once repositories in the wild carry hooks".
Git does not run hooks from a fresh clone for this reason, and this project's own `.githooks` are opt-in per clone.

What the hook buys was measured rather than assumed.
The capability audit found exactly one use for it, a veto on `done`, and ranked that last of seven proposals, with its own caveat that a hook which examines nothing reports success too.
`DOD7`, shipped in [ADR-0011](0011-evidence-and-the-severity-audit.md), gives that veto inside the tool: a done item whose type has a review step must point at evidence, and a reviewer can read the pointer.
CI is the other veto point, and CI already runs over the committed files.

What shipping it safely would cost is about three hundred lines and a new class of vulnerability.
A trust record outside any repository keyed by the workspace's real path and the hook file's hash, so a changed hook is an untrusted hook.
Path resolution after `realpath` refusing a symlink whose target leaves the workspace.
Execution with an argument vector and an empty environment plus `PATH`, the proposal on stdin, and a timeout outside the lock.
A defined refusal, never a prompt and never a silent skip, under `--no-input` or a non-terminal stdin.

F11 is the other half of the same surface, and its state is the same: there is nothing to secure.
The inventory holds thirteen commands and none of them generates a file for another program to read, and six modules under `src/` import a filesystem module, every one of them the store or the workspace resolver.

## Decision

### Hooks do not ship in v1, and the refusal is the record

The hook dispatch leaves the event-sink seam's implementation list in [../../ARCHITECTURE.md](../../ARCHITECTURE.md).
The seam itself stays, because its second implementation is the capturing sink the assertions already use, and a seam with one implementation is not a seam.

`HOOK_REFUSED` and `HOOK_FAILED` stay out of the closed exit-code set, where [ADR-0005](0005-output-and-exit-code-contract.md) already put them, and exit 3 means a guard refused.
DR5's reservation is untouched: the codes stay reserved and unproduced, which is what makes a later hooks feature additive rather than breaking.

`test/security/f1-f7-no-execution.test.ts` is the enforcement.
Nothing under `src/` may import `child_process`, `worker_threads`, `vm`, `inspector` or `repl`, evaluate a string, or read a setting named `hooks`.
A finding closed by absence needs a test more than one closed by a fix does, because an absence is undone by any later commit that adds an import nobody reads twice.

The backlog story `hooks` is cancelled with the resolution `wont_do`, naming this record, so the tool's own backlog says the same thing this file does.

### No artefact is generated, and F11's contract is kept against the day one is

treadle generates no adapter, no shell completion and no man page, so F11 has no surface and closes on the evidence rather than on a fix.
`test/security/f11-adapter-write-safety.test.ts` is the tripwire: it holds the filesystem-writer allowlist and the absence of a generator command, and its failure message carries the contract, so whoever trips it is told the five rules rather than sent looking for them.

When a generator does land, it prints the diff against the current target, takes a moderate confirmation, writes a timestamped backup of anything it replaces, is a no-op with the `already` marker on a re-run against an up-to-date target, and prints the exact command that reverts it.
That is the threat model's own fix for F11, and holding it in a failure message rather than in a paragraph is what keeps it attached to the moment it becomes relevant.

## Alternatives considered

### Ship hooks behind the trust gate the threat model specifies

Rejected on the ratio rather than on the design: the gate is buildable and correct, and it is three hundred lines and a new attack surface for a feature with one caller whose need `DOD7` already meets.
The asymmetry settles it.
Not shipping is reversible, because hooks can be added later with the gate if a second real caller appears.
Shipping is not, because repositories in the wild would carry hooks by then.

### Delete DR6's hook design and leave no trace of it

Rejected deliberately.
A reader in a year needs to know that clone-and-run execution was designed, considered and refused, because the alternative is that it gets designed again from scratch by someone who never saw the argument.
DR6 stands as written; this record is what disagrees with it.

### Close F11 by declaring it not applicable

Rejected because a finding closed in prose reopens silently.
The generator is a layer that does not exist, so the only thing that can carry its contract forward is a test that fails when the layer appears, which is what `f11-adapter-write-safety.test.ts` is.

## Consequences

Exit 3 means one thing, a guard refusal, rather than two.

`README.md`'s status table stops listing hooks among the specified-but-unimplemented features and lists them as refused instead, and `SECURITY.md`'s in-scope list drops its two hook bullets while keeping the class they belonged to: code execution caused by the content of a cloned workspace stays in scope, and a report of any execution at all is a report against this record.

Twelve of the thirteen threat-model findings now name a regression test rather than a layer they wait on.
F4 is the one that remains, and it waits on export, which is not built.

A future hooks feature is additive under [../../STABILITY.md](../../STABILITY.md): it would produce an exit code nothing produces today and read a configuration key nothing reads today, so no caller's contract moves.
The gate that would make it safe is specified in section 6 of the `treadle-board-outcomes-retention-b3` audit rather than left to be redesigned.

## Departures from the design record

**DR6's six seams keep their count, and one loses an implementation.**
The event sink's second implementation is the capturing sink rather than hook dispatch.
DR6's rule that a seam ships two real implementations still holds, because the capturing sink is what every event assertion in the suite runs against.

**DR5's two hook exit codes are reserved and unreachable rather than reserved and coming.**
ADR-0005 made them unreachable because the feature had not been built; this record makes it a decision rather than a schedule.

**A.8 rule 3's generated adapter is not built, and its write-safety contract lives in a test rather than in the interface.**
The interface describes a command that does not exist, so the contract is attached to the tripwire that fires when it does.

## What would reopen this

A second genuine caller for a hook that the `DOD7` rule cannot serve, argued rather than assumed.
Then section 6 of the audit is the specification, and every clause of the gate above is a test before any hook runs.
