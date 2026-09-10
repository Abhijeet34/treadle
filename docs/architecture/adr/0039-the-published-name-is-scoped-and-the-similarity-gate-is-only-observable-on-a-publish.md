# ADR-0039: The published name is `@abhijeet34/treadling`, and the similarity gate is only observable on a publish

**Status:** Accepted
**Date:** 2026-09-11
**Decided by:** the captain, on 2026-09-11
**Overtakes in part:** [ADR-0038](0038-the-name-is-treadling-and-the-old-npm-record-belongs-to-another-developer.md), whose decision was that the package, the command, the environment variables and the repository are all the one word `treadling`. The package name alone moves to the scope. The command, the `TREADLING_*` environment variables, the repository and every usage example are unchanged, and ADR-0038's reasoning for the word itself stands.

## Context

### The unscoped publish was refused for similarity, not for ownership

`npm publish` was refused on 2026-09-11.

```text
403 Forbidden - PUT https://registry.npmjs.org/treadling
 - Package name too similar to existing package readline; try renaming your
   package to '@abhijeet34/treadling' and publishing with
   'npm publish --access=public' instead
```

This is a different refusal from the one ADR-0038 was built on.
That one was `You do not have permission to publish "treadle"`, an authorization decision on a name another developer already held.
This one names no owner and no permission.
`treadling` is unheld, and the registry still refused it because of how it is spelled.

### The screen tested one edit and the gate refused at two

`readline` is two edits from `treadling`: insert `t` at the front for `treadline`, then substitute the final `e` for `g`.

| Pair | Levenshtein distance |
|---|---|
| `treadling`, `readline` | 2 |
| `treadling`, `treading` | 1 |
| `treadling`, `treadline` | 1 |
| `footloom`, `footloose` | 2 |

Measured with a Levenshtein implementation over the four pairs, recorded at `.fm-evidence/fm-treadling-scoped-name-s8/002-edit-distances-behind-the-refusal-and-th.log`.

ADR-0038's clearance table enumerated the one-edit neighbours and reported them clean, and the two rows above at distance 1 are exactly the `TREADING` and `TREADLINE` family it named.
A screen that stops at one edit cannot see a two-edit collision.
That is a bound on the screen rather than a mistake in running it, and this record states the bound so the next screen is not read as covering more than it does.

### No probe short of publishing observes the gate

ADR-0038 already said this, under "What is not known": "npm's similarity gate runs only on a real publish `PUT`. ... No probe short of publishing proves the name passes that gate, and that is inference rather than measurement."
That sentence was correct, and it is now measured rather than inferred.

The gate is not an ownership record, so `GET /-/package/<name>/collaborators` does not report it.
It is not a package document, so `GET /<name>` does not report it.
It is not the search index, which ADR-0038 read and found empty near `treadling`.
The only observation is the `PUT` that publishes.
A name-clearance screen can therefore rule a candidate out and can never rule one in.

### The next-best unscoped candidate has the same shape

ADR-0038 recorded `footloom` as the second choice so it would not be re-derived.
It sits two edits from `footloose`, which exists on the registry, which is the same distance and the same class of collision that just refused `treadling`.
Trying it would be a second publish attempt with no new information behind it, and a publish attempt is the only way to find out.

## Decision

### The package name becomes `@abhijeet34/treadling` and nothing else moves

`package.json` carries `"name": "@abhijeet34/treadling"`.
`"bin"` still carries `"treadling": "dist/treadling.js"`, so the typed command is unchanged and no usage example in this repository changes.

A scoped name publishes as private by default.
`publishConfig.access` is already `public` in the manifest and the `publish` step already passes `--access public`, so both halves of the registry's suggested invocation were in place before this change.

The scope changes the tarball's filename, and three places read it:

- `.github/workflows/cross-platform.yml`, two `pack/treadling-*.tgz` globs and the comment beside the second, which become `pack/abhijeet34-treadling-*.tgz`.
- `.github/workflows/cross-platform.yml` again, two reads of the installed bundle's first line. A global install of a scoped package lands under `node_modules/@abhijeet34/treadling/`, not `node_modules/treadling/`. The Windows shim is named from `bin` rather than from the package, so `$prefix/treadling.cmd` is unchanged.
- `docs/RELEASING.md`'s release-asset table row.

The `release.yml` smoke install becomes `@abhijeet34/treadling@${version}`.
`release.yml`'s pack step already reads the filename back out of `npm pack --json` rather than composing it, which is why that job needed no edit.

The filename is measured, not predicted, because the globs depend on it:

```text
$ npm pack --dry-run --json --ignore-scripts
    "name": "@abhijeet34/treadling",
    "version": "0.2.0",
    "filename": "abhijeet34-treadling-0.2.0.tgz",
```

Recorded at `.fm-evidence/fm-treadling-scoped-name-s8/001-packed-tarball-filename-under-the-scoped.log`.

### The documents say that the short form does not resolve

`npx treadling` will never install this package, and `npm install -g treadling` will never install it either.
Both are the shape a reader reaches for, and both would fetch nothing or something else.
`README.md`'s Install section and Status row, and `docs/RELEASING.md`'s list of sentences that stop being true when a package first reaches the registry, name the scoped form and say the short one does not resolve.

## Alternatives measured

| Alternative | Rejected because |
|---|---|
| `footloom`, ADR-0038's recorded second choice | Two edits from `footloose`, which exists. The same distance and the same collision class that just refused `treadling`, and the only test is another publish |
| Another unscoped candidate, screened harder | The screen cannot see this gate at any depth. A two-edit screen over the whole registry would refuse most short English compounds and still prove nothing, because the gate's actual rule is unpublished |
| `@treadling/cli`, an organisation scope | An organisation is free and renameable, which is the one thing a user scope is not. It also puts a second name in front of the package for no gain, and the registry named the user scope in its own refusal |
| Publishing nothing and keeping the clone-only install | The publish gate is the last thing standing between this tree and a user who does not clone repositories. The scope costs one token in one install line |

## Consequences

**Positive**

- The typed command, the environment variables, the repository and every example are untouched, so the change is one manifest field and the places that read the tarball's filename.
- The refusal's own suggested name is the one taken, which is the candidate with the best evidence of passing the gate that exists.
- The scope removes this class of refusal permanently. A scoped name is checked for similarity within its scope, and this scope holds one package.

**Negative**

- The package is tied to a personal username scope. An npm user account cannot be renamed, so this name is as durable as the account and no more, and moving off it later is a second rename with published users to carry.
- The unscoped `treadling` stays available to anyone. The registry refused it to this publish and reserves it for nobody, so a later publisher can take the word this repository, its command and its environment variables are all named after.
- `npx treadling` and `npm install -g treadling` read as correct and are not. Every install line has to carry the scope, and a reader who trims it gets nothing.
- ADR-0038's identity argument now covers three of the four things it named. The word is still the tool's identity everywhere a user types it, and the registry entry is the one place it is spelled differently.

## What is not known

The scoped publish has not been run.
The registry named `@abhijeet34/treadling` in its own refusal, which is the strongest signal available short of publishing, and it is still a suggestion rather than an acceptance.
This record is written from the refusal of the unscoped name, not from the success of the scoped one.

Whether the gate's rule is Levenshtein distance at all is inference.
The refusal names one neighbour and no rule, npm does not publish the algorithm, and the four distances above are consistent with a two-edit threshold rather than evidence of one.

## What would reopen this

- The scoped publish being refused as well, which would mean the gate reads something other than the scope.
- npm gaining a pre-publish similarity probe, which would make an unscoped candidate screenable and the second rename worth pricing.
- Someone else publishing an unscoped `treadling`, which would settle the last row of the negative consequences rather than leave it open.
