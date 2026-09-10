# What these files are

These two files are the source of the rulesets GitHub enforces, and nothing applies them on its own.
Editing one changes what this repository *says* it enforces.
It changes what GitHub *does* enforce only when somebody runs the apply command below.

That gap has been real twice.

- `tags.json` dropped `required_signatures` in #97.
  Live ruleset `22316869` was created and last modified in the same second on 2026-09-05 and was not touched again, so it still required a signature.
  `release-tag` then created an unsigned tag as the automation, GitHub refused it, and the refusal read `Resource not accessible by integration`, which looks like a token problem and is not one.
- `main.json` has required the `tests kept` context since #32.
  Live ruleset `22314350` was last modified on 2026-09-08 and requires `checks` and `secret scan`, so the guard [ADR-0013](../../docs/architecture/adr/0013-a-branch-may-not-remove-a-test-main-has.md) argues for has never been a required context on `main`, and `secret scan` was required there with no file naming it.
  `main.json` now names all three, `checks`, `tests kept` and `secret scan`, because the drift check does not say which side is right: matching the file to live here would have dropped a guard the forge already enforced, so the file gained a context instead of losing one.

A file nobody reads back is documentation, whatever it is called.

## Applying them

```sh
scripts/apply-repo-settings.sh Abhijeet34/treadle
```

It sends both files, and four more under `.github/settings/`, to the forge.
It is idempotent: a ruleset whose name already exists is updated in place rather than duplicated, and the name is the join, so renaming a ruleset in a file creates a second one.
`docs/RELEASING.md`, "The settings that are not files", carries what each file sets.

## Checking them

```sh
npm run ruleset-drift
```

It reads the live rulesets and refuses when they disagree with these files, naming each difference with both values.
It needs no credential: both ruleset endpoints answer an unauthenticated request on a public repository.

The `ruleset drift` workflow runs it weekly, on a pull request that touches these files, and in front of the tag on the release path.
A `v*` tag can be neither updated nor deleted, so a tag cut against a tag ruleset nobody had read costs a version number permanently.
That is why it exits 1 in front of `release-tag` today: `main.json` names `checks`, `tests kept` and `secret scan`, live ruleset `22314350` enforces only `checks` and `secret scan`, so the release path stays blocked until `scripts/apply-repo-settings.sh` applies `tests kept` to the live rule, a protection being added rather than one being removed.

One field it cannot check: `bypass_actors` is served only to a read by a repository administrator, so an unprivileged run reports that it could not compare it rather than counting it as matching.
Run the command locally, signed in as an administrator, to have that field compared too.

One difference it reports without failing: GitHub fills defaults into a ruleset it accepts and serves keys its own published API description does not carry, so a file that mirrored the response could be refused by the endpoint that applies it.
A parameter only the forge reports is named in the output as a note.
