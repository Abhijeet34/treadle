# ADR-0019: The repository root names no single agent harness, and a test keeps it that way

**Status:** Accepted
**Date:** 2026-09-06
**Implements:** nothing in the design record; it answers this repository's own history
**Departs from:** nothing; `AGENTS.md` already said it and nothing enforced it

## Context

`AGENTS.md` opens by saying that treadle's interface to an agent is its output contract and its schemas, that nothing in the file is addressed to one tool, and that a harness looking for another name should be pointed at this one.
The repository root then carried `CLAUDE.md`, ninety bytes of pointer at `AGENTS.md`, and no equivalent for any other harness.

That is a claim a reader can check and it did not hold.
A public repository shipping one harness's instruction file, and only that one, says which harness the project is really for, whatever the cross-harness file says about itself.

The file has been added twice, both times in good faith.

    ad05de9  added by the original scaffold (#1)
    01580d0  deliberately removed (#19)
    0286e42  silently re-added, 2 insertions (#26)

Pull request 26 was the branch rebuilt after a stranded-branch incident, so the second arrival was a conflict resolution reverting a decision, and nothing was watching.
That is the same failure ADR-0013 was written for, on a different file: a decision that lives only in the history of a branch is not a decision anybody can rely on.

## Decision

### The rule is about the root, and about one harness rather than about a vendor

No tracked file at the repository root may be one that a single named agent product loads by itself.
`AGENTS.md` is the cross-harness convention, it already carries the content, and every harness can be pointed at it.

The unit is the filename, because the filename is the whole mechanism: a harness loads the file because of what it is called, so a name at the root is what tells a reader which harness is expected.

### The check is a test, and the guard outside the branch is the one that already exists

`test/architecture/harness-instruction-files.test.ts` reads the tracked files at the root with `git ls-files` and compares them, lower-cased, against a closed list.

It needs no new CI job and no second required status context, and the reason is ADR-0013.
`tests kept` is required by name in `.github/rulesets/main.json`, it compares test titles at the merge base against the branch head, and it refuses a title main runs that the branch does not unless a `Removes-test:` trailer names it exactly.
So a resolution that took a pre-rebase tree whole, which is how `CLAUDE.md` came back, would have to drop these three titles, and dropping a title is the one thing a branch cannot do quietly.
A second required context would buy nothing the first one does not already hold, and would cost a ruleset that has to be edited whenever the job is renamed.

The test asserts that `AGENTS.md` is present as well as that no harness file is, so the rule cannot be satisfied by having no agent instructions at all.
It asserts a floor on the number of tracked root files, so a `git ls-files` that returned nothing would fail rather than pass over an empty list.

### The list is closed, and these names rather than more

    claude.md  gemini.md  qwen.md  agent.md  copilot-instructions.md
    .cursorrules  .windsurfrules  .clinerules  .aiderrules  .goosehints  .continuerules

Each is a file some named agent product reads from the root of a repository without being told to.
That property, and not the vendor's name appearing somewhere, is what the rule is about.

Three things are deliberately outside it.

**`.github/` is not reached.**
It is the forge's own directory and this repository commits GitHub-specific configuration in it on purpose: `.github/rulesets/`, `.github/workflows/`, `.github/settings/`.
A rule refusing vendor-specific files there would contradict the layout the repository already chose, and a Copilot instructions file inside it is inside the directory that vendor already owns.
The name is on the list for the root, where it does not belong, and nowhere else.

**`README.md`, `CONTRIBUTING.md` and `AGENTS.md` are not touched.**
They are addressed to people, or to every harness, and no product loads any of them by its name alone.

**Nothing reads file content.**
A rule that refused a root file mentioning a product name would flag `AGENTS.md`'s own prose, this record, and the test that enforces it.

The list grows one line at a time when a harness with a new root filename appears.
A list of one, naming only `CLAUDE.md`, would have been an argument about Claude rather than about harness neutrality, and would let `GEMINI.md` in tomorrow having proved nothing.

## Consequences

**Positive**

- The claim `AGENTS.md`'s own first paragraph makes is now true of the tree, and stays true through a rebase.
- A contributor who reaches for the file is refused by the suite before the pull request, with a message naming `AGENTS.md` and this record.
- `CONTRIBUTING.md` states the rule where the other rules that get changes rejected are stated, which is what a contributor reads before adding one.

**Negative**

- A harness whose root filename is not on the list is not refused until somebody adds the line. The check is a closed list and says so; it is not a classifier.
- A contributor who wants harness-local instructions has to keep them untracked. `.gitignore` is not extended for this, because an ignored name is a convention again rather than a rule.

**Neutral**

- Removing `CLAUDE.md` removes nothing a harness needs. It was a pointer, and the file it pointed at is the one every harness is told to read.

## What would reopen this

A harness that cannot be pointed at `AGENTS.md`, and that a contributor here actually uses.
The answer then is still not a second file at the root: it is that harness's own configuration, kept outside the tree, or a line in `AGENTS.md` naming what to do.
