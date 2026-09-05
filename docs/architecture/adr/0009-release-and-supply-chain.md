# ADR-0009: One bundle, a signed tag as the release authorisation, and the supply chain around both

**Status:** Accepted
**Date:** 2026-09-05
**Implements:** DR1's build rule and DR7's dependency budget; closes threat-model finding F13

## Context

treadle had a domain core, a store, a command surface, a benchmark rig and 653 tests, and no way to ship any of it.
Two workflows, no build step, no version management, no changelog, no release, no publish path, and no statement of what stops a supply-chain attack on the way to a user's machine.

Three specific gaps made that concrete.

DR1 specifies "one bundled entry file, at most 500 KB, built with esbuild", priced at 8.7 ms per invocation against the 60 unbundled modules.
Nothing built one, so the DR8 bundle-size budget reported `NOT MEASURED: there is no build step in this tree` and `docs/BENCHMARKS.md` listed "there is no bundle" as one of seven confounds on every figure it prints.

Threat-model finding F13 names three supply-chain controls the design left unstated: `ignore-scripts`, a committed lockfile installed with `npm ci`, and an SBOM with provenance at publish.
Two of the three were partly true by accident. The lockfile was committed and CI did use `npm ci`, but nothing said so and nothing checked.

And the identity gate's verdict is that the name stands for the repository, the code and the documentation, and does not stand for publication until a sixteen-source clearance screen has run.
So the release path had to be built and had to be impossible to fire.

This record is the first ADR with no design record behind it. F13's own fix text asks for "a new DR that owns release and CI", and the design phase ended before one was written.

## Decision

### The published product is the bundle, and development is not

`src/cli/entry.ts` is the process boundary and the esbuild entry point.
`scripts/build.ts` bundles it to `dist/treadle.js`, which `package.json`'s `bin` points at and its `files` allowlist ships.
No source, no `bin/`, no `src/` reaches the tarball.

`bin/treadle.js` stays, as a one-line shim over the same entry file, and it is what `node bin/treadle.js` and the process-spawning tests use.
Development still has no build step, which is what `AGENTS.md` promised and what the 37 processes `test/store/lock.test.ts` spawns depend on.

The 500 KB limit is not written in the build script.
It is read from `bench/budgets.json`, so `npm run build` and `npm run bench:gate` weigh the bundle against the same number and cannot drift apart.

Measured: 173,891 bytes, 2.9x under the budget.
The tarball is 18 files, 56.8 kB packed and 236.0 kB unpacked, against DR8's 1.5 MB unpacked limit.

### A signed annotated tag is the release authorisation

release-please maintains the release pull request and nothing else: `skip-github-release: true`, and no second job lifts it.

It cannot create the tag treadle needs.
release-please creates a GitHub Release and lets GitHub create the tag for it, which is lightweight and unsigned.
Measured on the sibling repository this pipeline is modelled on: `GET /git/refs/tags` reports `"type": "commit"` for all four of its release tags.

So a person creates the tag with `git tag -s` and pushes it, and that push is what fires the release.
`scripts/release-preflight.ts` refuses a tag that is lightweight, unsigned, not `v<semver>`, naming a version the tree does not declare, or pointing at a commit that never reached `main`.
`.github/rulesets/tags.json` refuses the same shapes at the forge and refuses to update or delete a `v*` tag afterwards.

### Publication is built and cannot fire

Three interlocks, each sufficient alone: `"private": true` in the manifest, the `NPM_PUBLISH_ENABLED` repository variable, and the `npm-publish` environment with a required reviewer.
Publication itself is npm Trusted Publishing over OIDC with `id-token: write` and no token anywhere, and it passes no `--provenance` flag because trusted publishing generates provenance itself.

The publish job downloads the attested tarball from the release and checks it against `SHA256SUMS` rather than repacking, so what reaches the registry is byte-for-byte what was signed.

### F13's three controls are closed, and checked

`.npmrc` sets `ignore-scripts=true`, committed so a clone and CI inherit it.
esbuild was chosen partly because it resolves its platform binary through an optional dependency rather than a lifecycle script, which every CI run proves: `npm ci` under that `.npmrc`, then `npm run build`, and a bundle appearing is the evidence that no script was needed to produce it.

`test/architecture/supply-chain.test.ts` asserts the rest rather than describing it: that `ignore-scripts` is on and committed, that the manifest declares no lifecycle script the setting would silence, that `package-lock.json` is tracked, that every workflow installs with `npm ci` rather than `npm install`, that the release path exports an SBOM and attests the tarball, that it carries no npm token and passes no `--provenance`, and that every third-party action in every workflow is pinned to a 40-character commit SHA.

`scripts/check-licences.ts` walks the whole installed tree, transitive packages included, refuses a licence off a permissive allowlist, and generates `THIRD-PARTY-NOTICES.md` so the file cannot drift from what is installed.

## Alternatives measured

| Alternative | Rejected because |
|---|---|
| release-please tags and releases, as the sibling repository does | Its four tags are lightweight and unsigned, measured. Every commit here is signed and the tag that releases them cannot be the one unsigned object in the chain |
| A signing key in CI, so a workflow can create the signed tag | A long-lived private key whose leak lets anyone forge a treadle release, in exchange for removing the one human step that also holds the publication gate |
| `prepack` to build the tarball | `ignore-scripts=true` is F13's first control, and it turns off the project's own lifecycle scripts too. The release workflow runs `npm run build` explicitly instead, which is visible in the log rather than implied |
| `npm sbom` | GitHub's dependency-graph export describes the manifests from the same data the dependency review reads, needs nothing installed, and cannot disagree with the alerts on the repository |
| Porting the sibling's `approve-release-checks` script, which releases the release pull request's parked CI | 165 lines plus a test, to make an unattended release unattended. treadle's release is human-initiated by design, so the person who signs the tag is already there to approve the checks |
| Minifying or source-mapping the bundle | A stack trace from a machine nobody can reach is worth more than the bytes. The bundle is 2.9x under budget, so there is nothing to buy |

## Consequences

**Positive**

- The DR8 bundle-size budget weighs a real number for the first time: 173,891 bytes against 512,000.
- The rollback policy has been rehearsed rather than only written. `scripts/rollback-drill.sh` signs real tags in a throwaway clone and drives the preflight against each one; eight scenarios, all passing.
- CI gained CodeQL, dependency review, `npm audit` at `low`, the licence gate and actionlint, behind a single required `checks` context that a skipped job cannot satisfy.
- The `check` matrix runs the 24.15.0 floor and current Node. Nothing tested the open upper half of `engines.node` before.
- A cross-platform leg that cannot say how many tests it ran now fails. npm hands a script to `cmd.exe` on Windows, `cmd` keeps the quotes around `"test/**/*.test.ts"`, and `node --test` matches no file and exits 0 over an empty set. Measured on the sibling repository with the identical command shape, where one platform reported green having run nothing.

**Negative**

- Two entry points now exist for the same program. They cannot diverge, because `bin/treadle.js` is a one-line import of the file esbuild bundles, but a reader has to be told which one ships.
- A release needs a person with a signing key. There is no unattended release path and there is not meant to be one.
- The bundle imports `node:sqlite` at its top level, so every invocation loads the index engine including `treadle --version`. DR1's second cold-start rule asks for the opposite. See the departures below.
- `CHANGELOG.md` is committed empty. release-please's changelog updater demotes an existing `# Changelog` heading to `##` and pushes it below the first entry, so a header written now would end up stranded at the bottom of the first release's notes.

## Departures from the design record

- **No lazy per-command imports.** DR1's second cold-start rule is "each command's module is loaded lazily on dispatch; nothing above the dispatcher does I/O or touches `node:sqlite`". The bundle does touch it: `import { DatabaseSync } from "node:sqlite"` sits at the top of `dist/treadle.js`. Making it lazy is a restructure of `src/cli/main.ts`'s dispatcher rather than a build concern, and DR1 prices the index engine at 1 ms against a 45 ms budget the bundle is already inside. It is recorded here rather than done quietly.
- **The compile cache is not under the workspace.** DR1 says the cache directory is "under the workspace's gitignored index directory". Resolving a workspace before enabling the cache would put filesystem I/O above the dispatcher, which is the one thing DR1's own rules forbid there. `module.enableCompileCache()` is called with no argument, so the directory is `NODE_COMPILE_CACHE` or one under the OS temp directory, and the cache belongs to the user rather than to any one workspace.
- **The release is not created by the release tool.** DR1 to DR8 say nothing about release mechanics; the threat model's F13 fix says to adopt the sibling tools' shape. This departs from that shape on the tag, for the measured reason above.

## What would reopen this

- The name clearing its screen, which is what opens the three interlocks and turns the publish and smoke jobs from never-run into run-once.
- A measured cold start above DR1's 55 ms p95 on the bundle, which is what would make the lazy-dispatch departure a defect rather than a note.
- A runtime dependency, which would give `THIRD-PARTY-NOTICES.md` its first real entry and would make the licence gate's shipped-versus-installed split matter.
- npm changing the trusted-publishing contract, which is the one piece of the publish path that has never executed.
