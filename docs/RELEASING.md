# Releasing, and rolling back

Nothing has been released.
`package.json` carries `"private": true` because the name has not been through its clearance screen, and the machinery below has never been fired.
This file is the procedure it will be fired with, and the procedure for undoing a release that was wrong.

## How a release happens

Five steps, and a person is the third one.

1. Work merges to `main` through a pull request, as always.
2. `release-please` opens or updates a release pull request on every push to `main`. It carries the version bump and the changelog entry and nothing else.
3. Someone reviews that pull request and merges it. Merging is what makes `main`'s head releasable; the `cross-platform` job runs on that pull request, so macOS and Windows have seen the tree before it is a candidate.
4. Someone tags `main`'s head with a signed annotated tag and pushes it:

   ```sh
   git checkout main && git pull
   git tag -s -m "release v0.2.0" v0.2.0
   git push origin v0.2.0
   ```

5. The tag fires `.github/workflows/release.yml`, which runs three platforms on the tagged tree, builds the bundle, packs it, exports an SBOM, checksums both, attests the tarball, and creates the GitHub release with the changelog section as its notes.

Publishing to npm is a sixth step that only runs when three separate interlocks are open, and none of them is.

## Why the tag is signed, and why release-please does not create it

Every commit in this repository is signed, and a tag that releases them should be too.
release-please cannot produce one.
It creates a GitHub Release and lets GitHub create the tag for it, and that tag is lightweight and unsigned.
This is measured rather than assumed: the sibling repository this pipeline is modelled on has four release tags, and `GET /repos/{owner}/{repo}/git/refs/tags` reports `"type": "commit"` for every one of them, which is what a lightweight tag looks like.

So release-please runs with `skip-github-release: true` and never tags.
The tag is created by a person at a terminal where signing is configured, and pushing it is the act that authorises the release.

That buys a second thing beyond the signature.
Nothing in CI can release treadle by itself.
The gate that holds publication is not a flag someone might forget to unset, it is the absence of a signed tag.

`scripts/release-preflight.ts` is where that becomes enforcement rather than habit.
It refuses a tag that is lightweight, that carries no signature `git verify-tag` accepts, that is not `v<semver>`, that names a version the tree does not declare, or that points at a commit which never reached `main`.
`.github/rulesets/tags.json` refuses the same shapes at the forge, and refuses to let a `v*` tag be updated or deleted once it exists.

A signed tag is the authorisation, not a label on one.

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

## The three interlocks in front of npm

Each of these stops publication on its own, and all three are closed today.

1. **`"private": true` in `package.json`.** npm itself refuses to publish it. The preflight names this one explicitly, so a refusal reads as the gate holding rather than as a broken workflow.
2. **`NPM_PUBLISH_ENABLED`**, a repository variable rather than a secret or a default. Unset, the publish job is visibly skipped and the release ends at the GitHub release and its three assets.
3. **The `npm-publish` environment**, configured to require a reviewer. The job stops and waits for a person before it can reach the registry.

Publication uses npm Trusted Publishing over OIDC.
There is no npm token anywhere in this repository, in any secret, at any scope.
It passes no `--provenance` flag, because trusted publishing generates provenance itself and the flag turns a provenance-ineligible publish into a failed release rather than an unattested one.

When the name clears, opening the gate is: remove `"private": true`, register treadle's trusted publisher on npm against `Abhijeet34/treadle` and `.github/workflows/release.yml`, create the `npm-publish` environment with a required reviewer, and set `NPM_PUBLISH_ENABLED` to `true`.

## Rolling back

A published version cannot be taken back.
npm's unpublish window is 72 hours and only for a version nothing depends on, and even inside it, unpublishing breaks every lockfile that already pinned the version.
So the order of preference is fixed.

**First, deprecate.** This is the answer in almost every case.

```sh
npm deprecate treadle@0.2.0 "0.2.0 corrupts the index on a hand-edited shard; use 0.2.1"
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
The patch then follows the ordinary release path above, including its own signed tag.

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

It clones this repository into a temporary directory, signs real tags in the clone, and drives the release preflight against each one.
It pushes nothing and never touches the real repository, which is why it is a script anyone can run rather than a workflow.

Eight scenarios, all passing on 2026-09-05: the signed annotated tag the release path accepts, five it refuses (lightweight, unsigned, wrong version, off the released branch, no bundle built), the publication interlock refusing a publish, and the hotfix path branched from the released tag, landed and tagged again.

```
drill: 8 passed, 0 failed
```

A rollback policy nobody has run is a document, not a policy.

## The settings that are not files

Branch protection, the tag rules and the Actions policy live on the forge rather than in the tree, so the tree carries what they should be and one script applies them.

```sh
scripts/apply-repo-settings.sh Abhijeet34/treadle
```

It is idempotent: a ruleset whose name already exists is updated in place rather than duplicated.

| File | What it sets |
|---|---|
| `.github/rulesets/main.json` | Signed commits, squash-only merges, no force push, no deletion, and the single required `checks` context |
| `.github/rulesets/tags.json` | Signed `v<semver>` tags that cannot be updated or deleted |
| `.github/settings/repository.json` | Squash-only, keeping the commit messages so a `Release-As:` footer survives |
| `.github/settings/actions-permissions.json` | `sha_pinning_required`, so an unpinned action cannot come back |
| `.github/settings/actions-workflow-permissions.json` | A read-only default token |

The `npm-publish` environment and its required reviewer are not in that script.
An environment that gates publication should be created deliberately by the person who owns the account, at the moment they decide to open the gate.
