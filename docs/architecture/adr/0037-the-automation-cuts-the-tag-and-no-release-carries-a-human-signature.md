# ADR-0037: The automation cuts the tag, and no release carries a human signature

**Status:** Accepted
**Date:** 2026-09-10
**Decided by:** the captain, on 2026-09-10
**Reverses:** [ADR-0009](0009-release-and-supply-chain.md)'s signed annotated tag as the release authorisation, and `docs/RELEASING.md`'s rejection of a script that approves the release pull request's parked runs

## Context

### What the old decision was, and why it was made

ADR-0009 decided that a person creates the release tag with `git tag -s` and pushes it, and that pushing it is the act that authorises the release.
Two things were bought with that, and the record names both.

The first is the signature itself.
Every commit in this repository is signed, and the argument was that the tag releasing them should not be the one unsigned object in the chain.
`scripts/release-preflight.ts` refused a lightweight or unsigned tag, and `.github/rulesets/tags.json` required a signature at the forge as well.

The second is stated in `docs/RELEASING.md` as "Nothing in CI can release treadling by itself", and it was the load-bearing half:

> The gate that holds publication is not a flag someone might forget to unset, it is the absence of a signed tag.

The same posture rejected the other half of an unattended release.
ADR-0009's alternatives table refused to port the sibling repository's parked-check approver, and `docs/RELEASING.md` repeated the reason:

> A script that approves the parked runs was weighed in ADR-0009 and rejected: 165 lines plus a test, to make an unattended release unattended, on a path that is human-initiated by design.

So the release cost two deliberate human acts: approving the release pull request's parked runs, and signing and pushing the tag.

### What it cost, measured on 2026-09-09 and 2026-09-10

**Two version numbers, both spent permanently.**
`v0.1.0` and `v0.1.1` are on the forge, both immutable under the tag ruleset, and neither carries a release with assets.

`v0.1.0` was the first release.
Run `34453354302` ran `cross-platform` on the tag, its three container install checks failed for want of `TREADLING_ACTOR`, and `artifacts`, `publish`, `publication` and `smoke` all skipped behind them.
The tag stands and the release carries no tarball, no SBOM and no checksums.
The matrix that was meant to gate the release ran after the tag it was gating, which is the defect the sibling repository had already paid for twice.

`v0.1.1` was the fix, and it failed on the clause nobody could have watched work.
On run `34475691252` all six `cross-platform` jobs passed, install checks included, and `artifacts` then failed in the Release preflight step:

```text
##[error]tag v0.1.1 carries no signature git could verify; every commit in this
repository is signed and the tag that releases them must be too
release preflight: 1 problem(s)
```

The tag is signed correctly.
It carries a real `-----BEGIN SSH SIGNATURE-----`, GitHub accepted it against a ruleset requiring signed tags, and on the captain's machine `git verify-tag v0.1.1` answers `Good "git" signature for 27002551+Abhijeet34@users.noreply.github.com with ED25519 key SHA256:4RHEgfnr...`.
Verifying an SSH signature needs an allowed-signers file naming the trusted keys, and a fresh runner has none.
Reproduced in a clone of `v0.1.1` with `gpg.ssh.allowedSignersFile` pointed at `/dev/null`, which is what a runner's empty configuration amounts to:

```text
$ git verify-tag v0.1.1
Good "git" signature with ED25519 key SHA256:4RHEgfnr...
No principal matched.
(exit 1)
```

The signature is read, and then there is nobody to match it against.
That clause had never been able to pass on a runner, and it could not be found out until a tag reached one, because the release path runs for real once.

**A deadlock that needed a release created by hand, a bookkeeping label fixed by hand, and four separate occasions where a person had to approve parked runs or re-run a job to refresh a status.**
The parking was measured before any of that.
The release pull request is opened by `github-actions[bot]`, this repository's Actions approval policy is `first_time_contributors`, and the bot is that contributor on every release pull request forever.
Forty-six runs on `release-please--branches--main--components--treadle` had concluded `action_required` by 2026-09-09, `gh pr checks 69` answered `no checks reported`, and four release pull requests waited four days that way.
The `parked-checks` job was built to say so on the pull request, and saying so is all it does: a person still has to make the call.

Three of the four things that broke on those two days were code that had never run.

## Decision

The captain decided on 2026-09-10 to accept unattended releases in exchange for the signature.
Merging the release pull request becomes the only human act on the release path.

The signature is the part a reader notices, and the ordering is the part that fixes what actually broke.
Both failures above are the same shape: a check failed, the tag already existed, and a version number was spent on a release that can never be built.
Putting the three-platform matrix in front of `release-tag` is what stops the largest of those checks from doing it again, and it is only possible because the automation now cuts the tag: a person cannot push a tag after a matrix they have to wait for.
That is what `v0.1.0` and `v0.1.1` cost, and it is the part of this record that has to survive any later argument about the signature.

### release-please creates the tag, and the run says which tag it made

`.github/workflows/release.yml` triggers on `push: branches: [main]` and `workflow_dispatch`, and on nothing else.
The `push: tags: ["v*"]` trigger is removed rather than kept beside them.
A hand-pushed tag would fire it, and release-please's own `release_created` output is the only signal that means "this tag was created for this tree, just now".

release-please is split by its own two skip inputs, as the sibling repository splits it.
`release-pr` runs it with `skip-github-release: true` and only ever opens or updates the release pull request.
`release-tag` runs it with `skip-github-pull-request: true`, and is the only job in this repository that can create a tag.
Every job downstream keys on `needs.release-tag.outputs.created == 'true'` rather than on `startsWith(github.ref, 'refs/tags/v')`.

### The matrix runs in front of the tag, so a failing check can no longer burn a version number

`cross-platform` needs `release-pr` and nothing else, and `release-tag` needs `cross-platform`.
So macOS, Windows and Linux all pass on main's head before any tag exists, and that tree is the tree `release-tag` tags and the tree `artifacts` packs.

This is the strongest thing in the change, and it is worth stating on its own because a reader will otherwise see only the signature being dropped.

A tag on `refs/tags/v*` can be neither updated nor deleted, and that rule is deliberate and stays.
So a check that runs after the tag is a check that spends a version number it cannot get back.
`v0.1.0` was tagged, `cross-platform` failed, `artifacts` skipped, and `0.1.0` is gone.
`v0.1.1` was tagged, the matrix passed, the preflight failed on a clause no runner could satisfy, and `0.1.1` is gone.
Two failures, two different checks, one mechanism: the tag existed before anything had a chance to say no.

The matrix is the largest and most failure-prone gate on this path, and it is now entirely in front of the tag.
`v0.1.0`'s failure mode is closed by that ordering alone: three container jobs failing for want of `TREADLING_ACTOR` now fails a push to `main`, no tag is created, no version number is consumed, the release pull request stays open, and the next push after the fix cuts the release that was always meant to be cut.
A red build costs a red build.

This is the same ordering the sibling repository arrived at after paying for two empty releases of its own, so it is not a departure from that shape.
What is different here is the price of getting it wrong: a `v*` tag there is also immutable, and treadling keeps more checks behind the tag than pointback does.

That residual is real and is not closed by the ordering.
`artifacts` still runs the preflight after `release-tag`, so a preflight refusal still costs a version number, and that is exactly what `v0.1.1` was.
The rule it forces is the one that governs every clause on that side of the tag: a check behind the tag must be decidable from the repository and the run alone.
The signature clause was not.
It depended on a file the machine had to be configured with, which is why it is deleted here rather than repaired with an allowed-signers file, and why every clause the preflight keeps reads only the tree, the tag and release-please's own output.

A check that can fail for a reason outside the repository does not belong behind an irreversible act.

Asking "is this push a release?" before running the matrix is what would give that back.
That answer is release-please's to give, and a second opinion answering no when the truth is yes skips the matrix, skips `release-tag` with it, and drops the release in silence.
So every push to `main` pays for macOS and Windows, and the matrix is conditioned on nothing.

A gate that runs after the thing it was meant to prevent is decoration.

### The parked checks approve themselves

`scripts/approve-release-checks.ts` releases the parked runs on the release pull request's current head, and the `release-pr-checks` job runs it after `release-pr` on every push to `main`.
It holds `actions: write` and no other write, uses the run's own token, and stores no credential.
The only pull request it can reach is one whose author is `github-actions[bot]`, whose head branch starts `release-please--` and is in this repository rather than a fork, and whose base is the default branch.
`test/release/approve-release-checks.test.ts` puts one impostor against each of those four clauses.

A run it cannot release fails the job, and a head that never gets a run at all fails it too, because the thing being replaced is a release that stalls in silence.

The `parked-checks` job it replaces is removed.
It reported a wait that no longer happens, and a status that is now always green is a status nobody reads.

### The tag stays immutable

`.github/rulesets/tags.json` drops `required_signatures` and keeps `update` and `deletion`.
Nothing signs the tag release-please creates, so requiring a signature at the forge would refuse every release this repository now cuts.
`v0.1.0` and `v0.1.1` are why the other two rules stay: a tag that pointed at a released tree is a record of what shipped, and the two that record a failure are worth exactly as much as the ones that will record a success.

### What replaced the signature clause in the preflight

The annotated and signed clauses are gone from `scripts/release-preflight.ts`, and neither the workflow nor the ruleset carries a signature assertion any more.
`--commit` takes their place, and it is required rather than optional: the tag must resolve to the commit release-please reported releasing in this run.
That is the one comparison that can tell a tag this run made from a tag that already carried the name, and it needs nothing on the runner that a runner does not have.

Before and after, driven against the real `v0.1.1` in a clone configured the way a runner is:

```text
$ git config --get gpg.ssh.allowedSignersFile
/dev/null
$ git cat-file -t v0.1.1
tag

== before: the preflight v0.1.1 actually ran, on run 34475691252
$ node scripts/release-preflight.ts --tag v0.1.1 --branch origin/main
::error::tag v0.1.1 carries no signature git could verify; every commit in this repository is signed and the tag that releases them must be too
release preflight: 1 problem(s)
(exit 1)

== after: the same tree, the same tag, this record's preflight
$ node scripts/release-preflight.ts --tag v0.1.1 --commit bcec4b716c369c16a810384f115b57b560fadb4f --branch origin/main
release preflight: ok, v0.1.1 is this run's tag at bcec4b716c369c16a810384f115b57b560fadb4f

== and it still refuses a tag this run did not create
$ node scripts/release-preflight.ts --tag v0.1.1 --commit ec9ccbef1190a292f9d6f47eb3eb942b2e0334a4 --branch origin/main
::error::tag v0.1.1 points at bcec4b716c369c16a810384f115b57b560fadb4f, not at the released commit ec9ccbef1190a292f9d6f47eb3eb942b2e0334a4; it existed before this run and must be deleted rather than reused
release preflight: 1 problem(s)
(exit 1)
```

One file changed between the two runs, and the tag under test is the one that is on the forge.

The key fingerprint is truncated in both transcripts above.
It is a public key's fingerprint and not a secret, and `.gitleaks.toml`'s `generic-api-key` rule matches it on entropy alone: the full 43 characters refuse the push at `.githooks/pre-push`.
That config is pinned by digest to `automation`'s canonical copy in `.github/workflows/secret-scan.yml`, so the allowlist is not this repository's to edit, and nothing here is worth routing a secret-scanning gate around.

The rest of the gate stands unchanged: `v<semver>`, the version the tree declares, the commit being on `main`, the bundle existing, being inside DR8's budget, being above a tenth of it, and being newer than every file under `src/`.
The six publishing refusals stand too, and are now each demonstrated firing rather than asserted: `private: true`, an absent or `UNLICENSED` licence, a missing `files` allowlist, a `bin` pointing outside the bundle, and a `repository` field npm's provenance prerequisites reject.
That last one costs a version number when it fires at the registry, because the tag is already cut and this ruleset will not let it be deleted.

### Publication is untouched

`NPM_PUBLISH_ENABLED`, the `npm-publish` environment and its required reviewer, and the `publication` job that names every block on every release are exactly as ADR-0009 and pull request 91 left them.
The unattended release stops at the GitHub release and its three assets.
Reaching the registry still asks a person, twice.

## What is given up

**No release will carry a human signature.**
The tag is created by a workflow, so there is no signature on it and nothing for anyone to verify.
A reader who wants to know that a released tree is the tree the maintainers reviewed reads the merge of the release pull request, `.github/rulesets/main.json`'s `required_signatures` on commits to `main`, and the build provenance `actions/attest-build-provenance` signs through GitHub's OIDC identity.
None of those is a person's signature on the release.

The second thing ADR-0009 bought is given up with it.
"Nothing in CI can release treadling by itself" is no longer true.
CI cuts the tag, creates the release and attaches the assets, and the only thing standing in front of it is the merge.
The gate that holds publication is now `NPM_PUBLISH_ENABLED` and an environment reviewer, which are flags someone could forget to leave unset, and that is exactly the property ADR-0009 refused to depend on.

Nobody should have to infer either of those from the shape of the workflow.

## Alternatives measured

| Alternative | Rejected because |
|---|---|
| Keep the signed tag and ship an allowed-signers file for the runner | It makes the refusal satisfiable and keeps both human acts, which are the cost being removed. It also puts a list of trusted keys in the tree that has to be maintained, and a stale entry there fails a release the same way |
| Keep the signed tag and drop only the preflight's signature clause | The forge would still require the signature, so the tag would still have to be created by a person at a terminal, and `v0.1.0`'s failure mode would be untouched |
| A signing key in CI, so a workflow can create the signed tag | ADR-0009's reason still holds: a long-lived private key whose leak lets anyone forge a treadling release, in exchange for a signature nothing else in the chain now depends on |
| Loosen `approval_policy` from `first_time_contributors` | Buys the unattended release by removing a control on every fork pull request this public repository will ever receive. `.github/settings/actions-fork-pr-approval.json` records the strict value and `test/release/repo-settings.test.ts` asserts it |
| A stored token with wider rights, so the release pull request's runs execute | `docs/RELEASING.md`, "Why Actions may create pull requests", rules a long-lived credential out for the whole release design, and the approver needs none: the run's own token is enough |
| Keep `parked-checks` as a report beside the approver | Two jobs answering the same question, one of which is green on every run once the other has done its work |
| Gate `cross-platform` on whether the push looks like a release | The second opinion that skips the matrix also skips the tag. Measured on the sibling repository: the same shape produced two empty releases before the gate was moved in front |

## Consequences

**Positive**

- The three-platform matrix can no longer spend a version number. It is in front of the tag, so `v0.1.0`'s failure mode costs a red build on `main` instead of a release nobody can ever cut again.
- A release is one act. Merge the release pull request, and the tag, the release, the tarball, the SBOM, the checksums and the attestation follow from it.
- The three-platform matrix now runs on every commit to `main` rather than only on the days a release is cut, so a platform regression reddens the commit that caused it instead of the release that found it.
- The preflight no longer depends on anything a runner has to be configured with. Every clause it keeps is decidable from the repository and the run.
- `scripts/rollback-drill.sh` grew from 8 scenarios to 13 and rehearses the gate as it now stands, including each publishing refusal on a manifest broken to make it fire.

**Negative**

- No release carries a human signature, and the release path can run without a person. Both are stated in full above.
- macOS and Windows minutes are spent on every push to `main`. GitHub bills a macOS minute at about 10x a Linux one against the same allowance, so this is the largest recurring cost in the change.
- `release-pr-checks` waits up to 120 seconds for the release pull request's runs to appear and up to 120 more for them to leave the parked state, so an ordinary push to `main` can carry a job that sits for four minutes doing nothing but reading.
- The tag is created by an action pinned to a SHA, so what tags a release is now a third-party dependency rather than a person. `.github/dependabot.yml` is what moves the pin, and a pull request that moves it changes who cuts releases.
- The preflight still runs after `release-tag`, so a preflight refusal still costs a version number. The ordering does not close that, and nothing here does: what bounds it is the rule above, that every clause behind the tag reads only the tree, the tag and release-please's output.

## Departures from the design record

None.
DR1 to DR8 say nothing about release mechanics, and ADR-0009's own third departure was that the release is not created by the release tool.
That departure closes here: the release tool creates the tag, and this record is the argument for the reversal rather than a note under one.

## What would reopen this

- A release forged through the path this opens, which is the failure the signature was there to prevent and the thing this record accepts the risk of.
- The name clearing its screen, which opens the two remaining publication interlocks and makes the merge the only act in front of the registry as well.
- GitHub gaining a way to sign a tag from a workflow identity without a stored key, which is what would let the signature come back without the human step returning with it.
- The macOS and Windows spend on every push to `main` reaching a level where the allowance runs out, which would make the matrix's placement a budget question rather than a correctness one.
