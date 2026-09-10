# Releasing, and rolling back

Two releases have been cut and neither produced anything.
`v0.1.0` and `v0.1.1` are on the forge carrying no assets, both immutable under the tag ruleset, and each failed on a different piece of code that had never run.
On `v0.1.0` the cross-platform install checks set no `TREADLE_ACTOR`, `treadle init` refused under rule C1 on all three container platforms, and the `artifacts` job that depends on them skipped, so the bundle, the SBOM and the checksums were never built.
On `v0.1.1` all six of those jobs passed and `artifacts` then failed in the release preflight, on a tag-signature check that had never been able to pass on a runner: see "Why the tag is no longer signed".
Nothing has reached npm, and no package of this name exists on the registry.
This file is the procedure the machinery is fired with, and the procedure for undoing a release that was wrong.

[ADR-0037](architecture/adr/0037-the-automation-cuts-the-tag-and-no-release-carries-a-human-signature.md) reversed the posture this file used to describe, on 2026-09-10.
The tag was created by a person signing it, and it is now created by the automation; the release pull request's parked checks were approved by a person, and they now approve themselves.
Merging the release pull request is the only human act left on this path, and no release carries a human signature.

## How a release happens

Three steps, and a person is the second one.

1. Work merges to `main` through a pull request, as always.
2. Someone reviews the release pull request `release-please` keeps up to date, and merges it.
   That is the only thing a person does on this path.
3. The merge is itself a push to `main`, so the workflow runs again on the release commit.
   This time `release-tag` finds a merged release pull request, creates `vX.Y.Z` and reports it through `release_created`, and everything downstream keys on that output.

`.github/workflows/release.yml` triggers on `push: branches: [main]` and `workflow_dispatch`, and on nothing else.
There is no tag trigger: a hand-pushed tag would fire it, and `release_created` is the only signal that means "this tag was created for this tree, just now".

```text
any squash-merge to main
  |- release-pr -------- opens or updates "chore(main): release x.y.z", tags nothing
  |- release-pr-checks - releases that pull request's parked runs, so it is checked
  `- cross-platform ---- macOS, Windows and Linux on this exact tree
       `- release-tag -- nothing above it has tagged; this is the only job that can
            |- artifacts --- preflight, npm run build, npm pack, SBOM, checksums,
            |                attestation, and the GitHub release the three hang off
            |- publish ----- only if NPM_PUBLISH_ENABLED is "true", and then only
            |    `- smoke    after the npm-publish environment's reviewer says so
            `- publication - says whether this release reached npm, on every release

on an ordinary merge, release-tag finds no merged release pull request and reports
created=false, so artifacts, publish, smoke and publication all skip. On the merge of
the release pull request it writes CHANGELOG.md and package.json, tags vX.Y.Z, and the
rest of the run builds the release around that tag.
```

The matrix is in front of the tag rather than behind it, and that ordering is what stops another `v0.1.0`.
A `v*` tag can be neither updated nor deleted, so a check that runs after the tag is a check that spends a version number it cannot get back: that is how `0.1.0` and `0.1.1` were both lost.
With the matrix in front, three container jobs failing for want of `TREADLE_ACTOR` fails a push to `main`, no tag is created, the release pull request stays open, and the next push after the fix cuts the release.
A red build costs a red build.

It is conditioned on nothing, so every push to `main` pays for macOS and Windows.
Asking "is this push a release?" before running it is what would put the defect back: that answer is release-please's to give, and a second opinion answering no when the truth is yes skips the matrix, skips `release-tag` with it, and drops the release in silence.

What is left behind the tag is `artifacts`, and its preflight refusal would still cost a version number.
That is the rule every clause on that side is written to: a check behind the tag must be decidable from the repository and the run alone, never from how the machine happens to be configured.
The signature clause was the one that was not, which is why "Why the tag is no longer signed" ends where it does.

A gate that runs after the thing it was meant to prevent is decoration.

Publishing to npm is a fourth step that only runs when three separate interlocks are open.
One of them, `"private": true` in `package.json`, has been removed; the other two are closed.
The release says which ones held rather than leaving a green run to imply a publish: see "What a release says when it published nothing".

## Why the tag is no longer signed

It was, and the check could never pass where it ran.

`v0.1.1` is signed correctly.
It carries a real `-----BEGIN SSH SIGNATURE-----`, GitHub accepted it against a ruleset that required signed tags, and on the machine that made it `git verify-tag v0.1.1` answers `Good "git" signature for 27002551+Abhijeet34@users.noreply.github.com with ED25519 key SHA256:4RHEgfnr...`.
On run `34475691252` all six `cross-platform` jobs passed and the `artifacts` job then failed:

```text
##[error]tag v0.1.1 carries no signature git could verify; every commit in this
repository is signed and the tag that releases them must be too
release preflight: 1 problem(s)
```

Verifying an SSH signature needs an allowed-signers file naming the trusted keys, and a fresh runner has none.
Reproduced in a clone of `v0.1.1` with `gpg.ssh.allowedSignersFile` pointed at `/dev/null`, which is what an unconfigured runner amounts to:

```text
$ git verify-tag v0.1.1
Good "git" signature with ED25519 key SHA256:4RHEgfnr...
No principal matched.
(exit 1)
```

The signature is read, and there is nobody to match it against.
That clause had never been able to pass on a runner, and nothing could find that out until a tag reached one, because the release path runs for real once.

So the signature is gone rather than repaired.
Giving the runner an allowed-signers file would make the refusal satisfiable and keep the human step, which is the cost ADR-0037 removes; a signing key in CI is a long-lived credential whose leak forges a release.
release-please creates the tag now, that tag is lightweight and unsigned, and **no release carries a human signature.**
What stands behind a released tree instead is the merge of the release pull request, `.github/rulesets/main.json`'s `required_signatures` on commits to `main`, and the build provenance `actions/attest-build-provenance` signs through GitHub's OIDC identity.

`scripts/release-preflight.ts` is what checks the tag now, and every clause it keeps is decidable from the repository and the run.
It refuses a tag that is not `v<semver>`, that names a version the tree does not declare, that points at a commit which never reached `main`, or that resolves to anything but the commit release-please reported releasing in this run.
That last one is `--commit`, it is required rather than optional, and it is the only comparison that can tell a tag this run made from a tag that already carried the name.
`.github/rulesets/tags.json` no longer requires a signature and still refuses to let a `v*` tag be updated or deleted once it exists.
It does not check the tag's name; the next section says why.

Six more clauses stand in front of the registry, and `scripts/rollback-drill.sh` fires each one on a manifest broken to make it fire rather than asserting it: `"private": true`, an absent or `UNLICENSED` licence, a missing `files` allowlist, a `bin` pointing outside the bundle, and a `repository` field npm's provenance prerequisites reject.
The last is the expensive one.
Trusted publishing generates provenance by default and npm's prerequisites require a public `repository`, so without it the publish fails at the registry with the tag already cut, and a `v*` tag here can be neither moved nor deleted.
That costs a version number permanently. Two have been spent that way already.

It also refuses a `dist/` older than any file under `src/`.
`package.json` lists `dist/` in `files`, points `bin` at `dist/treadle.js` and gitignores the directory, so a tarball built from a tree whose bundle predates its source ships a different tool from the one the README describes: a checkout carrying a bundle two days older than its source reported fourteen commands where the inventory then had nineteen (2026-09-07).
The obvious remedy is a `prepack`, and this repository cannot have one.
`.npmrc` sets `ignore-scripts=true` for the whole lifecycle as a supply-chain control, the workflow's own pack step passes `--ignore-scripts` on top of that, and `test/architecture/supply-chain.test.ts` refuses a manifest that declares `prepack` by name, because a declared script the lifecycle never executes is a gate that looks green and is not.
So the clause sits in `scripts/release-preflight.ts`, which the workflow runs one step after `npm run build` and one step before it packs.
`node scripts/check-dist-fresh.ts` is the same check, runnable on its own against a checkout.

A check nobody can watch hold is a check nobody knows is broken.

## Why the tag ruleset does not check the tag name

`.github/rulesets/tags.json` carries `update` and `deletion`, and deliberately carries no `tag_name_pattern` rule.
GitHub's ruleset documentation lists that rule for a tag target, and GitHub refuses it on this repository with HTTP 422.

Measured on 2026-09-05 by posting each rule alone against a disabled probe ruleset and deleting it afterwards:

| Rule posted alone | Verdict |
|---|---|
| `required_signatures` on a tag target | accepted |
| `tag_name_pattern`, `regex` operator, with a `name` key | HTTP 422 |
| `tag_name_pattern`, `regex` operator, without a `name` key | HTTP 422 |
| `tag_name_pattern`, `starts_with` operator | HTTP 422 |

So the rule type is refused in every shape and operator tried, rather than one parameter block being malformed.
The sibling repository's working tag ruleset carries only `update` and `deletion`, which is consistent with the same limit rather than with an oversight there.
`required_signatures` was accepted and is no longer in the file: ADR-0037 removed it, because release-please creates the tag and nothing signs it.

Do not add the rule back from the documentation.
While it was in the file every run of `scripts/apply-repo-settings.sh` failed on it.

Tag naming is enforced where the tag is created instead.
release-please composes the name from the manifest version, and `scripts/release-preflight.ts` refuses a tag that is not `v<semver>` before anything is built, attached or published.
The workflow no longer fires on a tag ref at all, so a tag that reached the forge by any other route starts nothing.

## What a release produces

Three assets on the GitHub release, plus one attestation that is not a file.

| Asset | What it is |
|---|---|
| `treadle-<version>.tgz` | The tarball `npm pack` produced, which is what npm would publish |
| `sbom.spdx.json` | GitHub's dependency-graph export for this repository |
| `SHA256SUMS` | `sha256sum` over the other two |

The attestation comes from `actions/attest-build-provenance`, which signs through GitHub's OIDC identity.
There is no key and no secret behind it: the identity is the workflow, the repository and the commit.

The publish job does not repack.
It downloads the tarball from the release and checks it against `SHA256SUMS` before handing it to npm, so what reaches the registry is byte-for-byte what was attested.

## The interlocks in front of npm

Three were designed, each stopping publication on its own. One is open now and the other two are closed.

1. **`"private": true` in `package.json`.** Removed, and this is the only thing that removal did: npm's own refusal to publish a private package no longer applies, and `scripts/release-preflight.ts --publishing` no longer refuses on that clause.
   It publishes nothing by itself. The two interlocks below stop the `publish` job before npm is reached at all, and the `publication` job names every one of them that still applies on every tag.
   Where that refusal came from is worth keeping, because it is the reason a dry run never tested it: npm 11.19's CLI checks `private` only for a workspace publish, and for this package the refusal was raised by `libnpmpublish` after authentication and the registry version query.
   So `npm publish --dry-run` printed `+ treadle@0.1.0` and exited 0 with no mention of `private`, and `npm publish` against an unreachable registry reached `ENEEDAUTH` first.
   Measured 2026-09-07.
   `scripts/release-preflight.ts` keeps the clause, so a manifest that carries the field again is refused before anything is packed.
2. **`NPM_PUBLISH_ENABLED`**, a repository variable rather than a secret or a default. Unset, the publish job's own condition is false, the job never starts, and the release ends at the GitHub release and its three assets.
   A skipped job is not a report of that, and this line used to say it was: the run still concluded success and the release said nothing. The next section is the surface that says it.
3. **The `npm-publish` environment**, configured to require a reviewer. The job stops and waits for a person before it can reach the registry.

Publication uses npm Trusted Publishing over OIDC.
There is no npm token anywhere in this repository, in any secret, at any scope.
It passes no `--provenance` flag, because trusted publishing generates provenance itself and the flag turns a provenance-ineligible publish into a failed release rather than an unattested one.

When the name clears, what is left of opening the gate is: register treadle's trusted publisher on npm against `Abhijeet34/treadle` and `.github/workflows/release.yml`, create the `npm-publish` environment with a required reviewer, and set `NPM_PUBLISH_ENABLED` to `true`.
The name clearance itself has not been run. One of its sixteen sources has: the name `treadle` is free on npm, which is one answer out of sixteen and not the screen.

That list assumed a release and a package would arrive on the same day. They did not.
`v0.1.0` was cut while three of those four sentences still said nothing had been released, so they were corrected on the day the release existed rather than the day a package does, and this is what is left of the list.
Two sentences and one code block stop being true when a package first reaches the registry:
`README.md`'s "No package is on the registry" opening to its Install section, `README.md`'s "Published package" status row, and the quick start, which becomes `npm install -g treadle` and `treadle init` where today it is `node bin/treadle.js init` against a clone.
Do not write any of them early. A quick start that names a package nobody can install is the defect this repository spent a week removing.

One more setting belongs in that list, and it closes a hole nothing in this tree can: set the package's npm publishing access to disallow token publishes, so the workflow's OIDC identity is the only thing that can publish.
Until that is set, a person with publish rights can `npm publish` by hand from a stale checkout and ship whatever `dist/` is on their disk.
The workflow's own path is already closed by construction - the `publish` job downloads the attested tarball the `artifacts` job packed one step after `npm run build` and `release-preflight`, and verifies it against `SHA256SUMS` - and `scripts/check-dist-fresh.ts` explains why a `prepack` hook cannot be the answer here.

## What a release says when it published nothing

A skipped job is not a report.

`publish` is gated on `vars.NPM_PUBLISH_ENABLED`, this repository has no Actions variables at all, and a job whose `if:` is false is skipped rather than run.
So the Release run concluded success, `smoke` skipped behind `publish`, and the release page carried three assets and no sentence about npm.
An absent signal reading as a pass is the defect class this repository has been removing, and here it misled twice rather than once.
A reader who set the variable to lift the first interlock still got nothing, because `"private": true` stopped the publish a step later and nothing named that up front.

`.github/workflows/release.yml`'s `publication` job is what says so now.
It runs on every tag whatever `publish` did, under `always()` because the skipped job it reports on would otherwise skip it too, and it names every block that applies rather than the first one to stop it:

```text
**`v0.1.0` was not published to npm.** The assets on this release are the whole of it.

Every condition standing in front of publication, rather than the first one to stop it:

- The repository variable `NPM_PUBLISH_ENABLED` is unset, not `true`, so the `publish` job's own condition is false and the job never starts.
- `package.json` at `v0.1.0` carries `"private": true`, which `scripts/release-preflight.ts --publishing` refuses and npm refuses after it. Setting the variable above does not lift this one.
```

The second bullet is history: `package.json` no longer carries `private`, so a tag cut today names the variable alone, and `test/release/publication-decision.test.ts` drives that manifest as well as the private one.
No release carries this paragraph yet.
The job is guarded on `needs.artifacts.result == 'success'`, because there is no release to write onto when nothing was packed, and on `v0.1.0` `artifacts` skipped, so `publication` skipped behind it and that release's notes were written by hand.

That paragraph goes onto the release itself under a `## Publication` heading, because "did this version reach npm?" is asked at the release and not in a job list where a skipped job looks like a job that had nothing to do.
The same text goes into the run's step summary, and the run carries a warning annotation naming how many conditions stand in front of publication.
A re-run replaces its own paragraph rather than stacking a second one, and the release notes the `artifacts` job wrote survive it.

The third interlock is read rather than claimed.
`GET /repos/{owner}/{repo}/environments/npm-publish` answers 404 for an environment nobody has created, and GitHub creates an environment on first use carrying no protection rules, so "could not be read" and "requires a reviewer" are opposite answers about whether anything would hold the job.
The report prints whichever one is true and never rounds the first up to the second.

It reports and does not gate.
Publication is closed by design until the name clears, so the condition is true on every release this repository cuts until then, and a red that never clears is a red nobody reads.
`test/release/publication-decision.test.ts` drives the job's own shell over each outcome `publish` can have: skipped, failed, succeeded, and a result the job does not recognise.

A release that publishes nothing must not read as a plain success.

## What stands between the release pull request and a merge

Two things, and neither was named anywhere in this tree until 2026-09-08.
The first parks the checks so they never run, and the run now releases them itself.
The second reddens them once they do, and is fixed in the release-please configuration.

### The checks are parked, and the run releases them

The release pull request is opened by `github-actions[bot]`, and every workflow run on it is created and then parked rather than executed.

```text
$ gh-axi api repos/Abhijeet34/treadle/actions/permissions/fork-pr-contributor-approval
approval_policy: first_time_contributors
```

GitHub documents that value as requiring approval for a contributor opening their first pull request to the repository.
The bot holds no write access and has never had a pull request merged here, so it is that contributor on every release pull request, forever.

A parked run is not a slow run.
Measured on 2026-09-08, run `34176306546` on `release-please--branches--main--components--treadle` reported `created_at`, `run_started_at` and `updated_at` all at `2026-09-08T01:20:18Z`, and `0` jobs.
Fourteen consecutive runs on that branch concluded `action_required` the same way, over 2026-09-07 and 2026-09-08.
`.github/rulesets/main.json` requires the `checks` and `tests kept` contexts on `main`, so a release pull request whose checks never ran can never merge, and step 2 above stops there.

A parked run also attaches no check to the pull request, so the pull request page reported nothing rather than reporting a wait: `gh pr checks 69` answered `no checks reported on the 'release-please--branches--main--components--treadle' branch` while two runs sat at `action_required` on its head commit, and the Release run on `main`'s own head reported success at the same moment.
Forty-six runs had concluded `action_required` by then, and four release pull requests had waited four days.

`.github/workflows/release.yml`'s `release-pr-checks` job releases them now.
It runs `scripts/approve-release-checks.ts` after `release-pr` on every push to `main`, reads which runs on the pull request's current head commit are at `action_required`, and calls `POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve` on each one.
It uses the run's own `GITHUB_TOKEN` with `permissions: actions: write`, which is what makes a release unattended without storing a credential to make it so.

The one pull request it can reach is one whose author is `github-actions[bot]`, whose head branch starts `release-please--` and is in this repository rather than a fork, and whose base is the default branch.
`test/release/approve-release-checks.test.ts` puts one impostor against each of those four clauses, and drives the script through its own request function rather than through a stub binary on `PATH`.

It fails the job rather than passing quietly in two cases, because the thing being replaced is a release that stalls in silence.
A parked run it could not approve fails, naming the `actions: write` it needs.
A head that still carries no `pull_request` run at all after 120 seconds fails too: unknown and clear are different claims, and a pull request whose runs never appeared reads exactly like one whose runs have not finished.

Keying it on the head commit rather than the branch is what keeps it honest, because a run parked on a commit the pull request has moved past stays `action_required` for the life of the repository.
`needs: release-pr` is there because the `parked-checks` job this replaces read the pull request one second into run `34288199967` and answered about the head commit release-please replaced two minutes later.
GitHub created the runs on that new head two seconds after `release-pr` finished, so a head carrying no runs at all is read again rather than acted on.

Approving is a request and a 201 is not the outcome.
The outcome is the run leaving the parked state, which is what the required `checks` context waits on, so the script watches for that rather than for its own call returning.

`parked-checks` is gone with the wait it reported.
It posted a `release checks approved` commit status on the pull request's head, red while the runs were parked, and it never approved anything: the click stayed where ADR-0009 put it.
Once the run makes the click itself that status is green on every push, and a status that is always green is a status nobody reads.

Two other ways to unpark them, and neither is taken here.
Loosening `approval_policy` buys the same thing by removing a control on every fork pull request this public repository will ever receive, which is why `.github/settings/actions-fork-pr-approval.json` records the strict value in the tree and `test/release/repo-settings.test.ts` asserts it.
A stored token with wider rights would raise the pull request under an identity whose runs execute, and "Why Actions may create pull requests" below rules that out for the whole release design.

Approving a run executes that branch's workflow files.
That is why the narrowing above is four clauses rather than one, and why the branch it may reach is one only release-please writes to.

The run spends its own token on its own branch, or nothing here is safe to automate.

### The release commit signs itself off

Approving the checks is not the end of it, and this was only visible once they had run.
`scripts/check-dco.sh` requires every commit in a pull request to carry a `Signed-off-by` trailer naming its author, and release-please's own commit carried none: `95c2511`, `chore(main): release 0.1.0`, authored by `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`, trailers `[]`.
On the first release pull request whose checks were ever allowed to run, seven jobs went green and that one did not, so the required `checks` context went red and the pull request could not merge.

`release-please-config.json` carries `signoff` for it, set to that same identity.
release-please v17.6.0, the version the pinned action bundles, documents the key as "Text to be used as Signed-off-by in the commit".
`scripts/check-dco.sh` accepts a GitHub App author's trailer at any address, because GitHub mints an App's commit address in a namespace that receives no mail, so the certificate names the App exactly as it does for Dependabot.
`test/release/release-commit-signoff.test.ts` builds that commit and drives the real script over it, rather than comparing the string to itself.

A sign-off is a Developer Certificate of Origin attestation, not authorship.
It writes no `Co-authored-by` trailer and leaves the commit's author line unchanged, so it adds nobody to this repository's contributors.

Each of these was hidden behind the one in front of it, and both were hidden behind a Release workflow that had stopped starting at all.
The signature clause was hidden behind all three.
A release path is only as fixed as its last link.

## Rolling back

A published version cannot be taken back.
npm's unpublish window is 72 hours and only for a version nothing depends on, and even inside it, unpublishing breaks every lockfile that already pinned the version.
So the order of preference is fixed.

**First, deprecate.** This is the answer in almost every case.

```sh
npm deprecate treadle@0.2.0 "0.2.0 quarantines a valid record on a hand-edited shard; use 0.2.1"
```

The version stays installable, every existing lockfile keeps working, and anyone installing it sees the sentence.
The message names what is wrong and what to use instead, because a deprecation nobody can act on is noise.

**Then ship the fix.** A hotfix branches from the tag that was released, not from `main`:

```sh
git checkout -b hotfix/v0.2.1 v0.2.0
# land the fix through a pull request as usual
```

Cutting from the tag is what keeps the fix minimal.
Cutting from `main` ships whatever else merged since, which is how a rollback becomes a second incident.
The patch then follows the ordinary release path above: land it, merge the release pull request, and the automation cuts `v0.2.1` from it.

**Unpublish only when the artifact must not exist.** A leaked credential in the tarball, or code that should never have shipped at all.

```sh
npm unpublish treadle@0.2.0
```

Within 72 hours, and only when nothing depends on that version.
A leaked credential is rotated first: unpublishing does not un-leak it, and the registry is not the only place the tarball now lives.

**The GitHub release and the tag stay.** The tag ruleset refuses to update or delete a `v*` tag, deliberately.
A tag that pointed at a released tree is a record of what shipped, and deleting it makes the history lie about what people already have.
Mark the GitHub release as a pre-release or edit its notes to say it is withdrawn, and let the next patch supersede it.

## The drill

`scripts/rollback-drill.sh` is the rehearsal, and it has been run.

It clones this repository into a temporary directory, creates real tags in the clone, and drives the release preflight against each one.
It pushes nothing and never touches the real repository, which is why it is a script anyone can run rather than a workflow.
The clone is taken with `--no-tags`, because the drill creates `v<the tree's version>` and the source now carries a real release tag of that name: without it the first scenario died at `tag 'v0.1.0' already exists`, which is a drill that stops working the moment the thing it rehearses happens once.

Thirteen scenarios, all passing on 2026-09-10.
The lightweight tag release-please creates, which the path now accepts.
Four it refuses: a version the tree does not declare, a tag that existed before this run, a commit that never reached the released branch, and no bundle built.
Six publish refusals, each on a manifest broken to make it fire: `private` back in the manifest, `UNLICENSED`, no licence field at all, no `files` allowlist, no `repository`, and a `bin` pointing outside the bundle.
The manifest as it stands passing that same publishing gate, which is what says the gate no longer holds publication.
And the hotfix path branched from the released tag, landed and tagged again.

Re-run whenever the gate changes, because a drill that predates the gate it rehearses proves nothing about it.
The 2026-09-07 run was eight scenarios against the signed-tag gate; ADR-0037 replaced that gate, and the publication-interlock scenario had already started passing at exit 0 against a preflight that was right, because `"private": true` left the manifest when the first release was cut.

```text
drill: 13 passed, 0 failed
```

A rollback policy nobody has run is a document, not a policy.

## The settings that are not files

Branch protection, the tag rules and the Actions policy live on the forge rather than in the tree, so the tree carries what they should be and one script applies them.

```sh
scripts/apply-repo-settings.sh Abhijeet34/treadle
```

It is idempotent: a ruleset whose name already exists is updated in place rather than duplicated.

It applies every setting it can and names the ones it could not, together, at the end, and exits non-zero when anything failed.
That is deliberate: it used to stop at the first refusal, so the tag ruleset GitHub rejects left the repository settings and both Actions permission calls unapplied while the exit code said only that something had gone wrong.
A settings script that half-applies is worse than one that refuses, because the operator cannot tell from the exit code which half happened.
`test/release/repo-settings.test.ts` holds that behaviour, driving the real script against a stubbed `gh-axi`.

| File | What it sets |
|---|---|
| `.github/rulesets/main.json` | Signed commits, squash-only merges, no force push, no deletion, and the required `checks` and `tests kept` contexts |
| `.github/rulesets/tags.json` | A `refs/tags/v*` tag that cannot be updated or deleted. No signature is required: see "Why the tag is no longer signed". The name itself is checked by the release preflight, not here |
| `.github/settings/repository.json` | Squash-only, keeping the commit messages so a `Release-As:` footer survives, and deleting a branch once its pull request merges |
| `.github/settings/actions-permissions.json` | `sha_pinning_required`, so an unpinned action cannot come back |
| `.github/settings/actions-workflow-permissions.json` | A read-only default token, and permission for Actions to open a pull request. See "Why Actions may create pull requests" |
| `.github/settings/actions-fork-pr-approval.json` | `first_time_contributors`, which is why the release pull request's checks park. See "What stands between the release pull request and a merge" |

The `npm-publish` environment and its required reviewer are not in that script.
An environment that gates publication should be created deliberately by the person who owns the account, at the moment they decide to open the gate.

## Why Actions may create pull requests

`can_approve_pull_request_reviews` is `true` in `.github/settings/actions-workflow-permissions.json`, and the name is misleading enough to be worth writing down.

The release workflow's first half opens the release pull request on every push to `main`.
It could not.
Every Release run from `build(release): add release automation and supply-chain CI gates (#8)` onward failed on the same line, which is the action's own report of GitHub's refusal:

```text
release-please failed: GitHub Actions is not permitted to create or approve pull requests.
```

GitHub couples creating and approving into that one switch, so a job that only wants to open a pull request is blocked by a flag whose name mentions approving.
Release automation needs the creating half, and there is no narrower setting that grants it.

The approving half grants no power over merges here.
`.github/rulesets/main.json` sets `required_approving_review_count` to `0`, so an approving review is not a gate on `main` and a token that could leave one still moves nothing.
`default_workflow_permissions` stays `read`, so this changes nothing about what a job may write: `release-pr` names `contents: write` and `pull-requests: write` in the workflow, and every other job elevates for itself or does not elevate at all.

The other way to let release automation open a pull request is a stored token with wider rights than the workflow token.
We do not do that, and nobody should "improve" this later by adding one.
The release design has no long-lived credentials in it: publication goes over OIDC with no stored registry token, and provenance is attested through GitHub's own workflow identity.
A secret that must be rotated and can leak is a worse thing to own than a repository flag that is small, visible in this tree, and reversible by editing one line and re-running `scripts/apply-repo-settings.sh`.

A permission you can read out of the tree beats a credential you have to trust.
