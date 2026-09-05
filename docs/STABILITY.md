# Stability and versioning

treadle follows [Semantic Versioning 2.0.0](https://semver.org/).
This file says what a breaking change is for this project, because "breaking" means nothing until someone writes down what the contract is.

## The pre-1.0 policy

The current version is 0.x.
Under SemVer, 0.x makes no compatibility promise at all, and a project that hides behind that clause while people build on it is being dishonest.
So the promise here is narrower than 1.0 and larger than nothing.

- **A breaking change bumps the minor version** while the major is 0. `0.4.0` may break what `0.3.0` did; `0.3.1` may not break `0.3.0`.
- **Every breaking change is named in the release notes**, with what broke, why, and what to do instead. A release that breaks something silently is a bug in the release.
- **The file format is exempt from the "may break" clause.** A workspace written by any released version is readable by every later version, through the migration chain. Reading always works. See [The file format](#the-file-format).
- **1.0 is the version at which the four contracts below stop moving without a major bump.** It ships when they have survived real use, not on a date.

## What counts as a breaking change

Four contracts. A change to any of them is breaking, whatever it does to the code behind it.

### The command-line surface

Breaking:

- Removing or renaming a command, a subcommand, a flag, or a flag's short form.
- Changing what an existing flag does, including narrowing what it accepts.
- Making an optional argument required, or changing the order of positional arguments.
- Changing the default value of a flag, when the default is what most invocations rely on.
- Changing which rendering is chosen when `--out` is absent.

Not breaking:

- Adding a command, a subcommand, or a flag.
- Adding a value to a flag that already takes a closed set, when the new value cannot be confused with an existing one.
- Changing help text, error prose, or the human rendering's layout.

### Exit codes

Breaking:

- Changing the number an error code maps to.
- Moving a condition from one error code to another, so the same failure now exits differently.
- Adding a new non-zero exit for a case that used to succeed.

Not breaking:

- Adding a new error code for a condition that previously exited 1 as an internal error.

The mapping is: `0` success including an idempotent no-op, `2` invalid input, `3` a guard refused, `4` a stale-version conflict, `5` not found, `6` the store is unavailable, `7` the stored files carry something no write path would have accepted, `1` anything else, `130` interrupted.

`7` is the one status a command can exit while still printing its answer on stdout: `doctor` answers with the findings table and exits `7` when the table is not empty.
Every other command exits `7` as a refusal, because a store that holds a record it cannot serve cannot give a whole answer; the refusal names the file, the line and the reason of the first such record.

### The output schema

Every command produces one result object, validated against a JSON Schema that is versioned per command and shipped in the package.

Breaking:

- Removing a field from a result object, or renaming one.
- Changing a field's type, or the meaning of a value it already carried.
- Changing the order of fields, because the compact line rendering is a projection of schema property order and a reordering moves columns.
- Changing the compact line grammar: the separator, which field may contain spaces, or how a repeated row shape declares its columns.

Not breaking:

- Adding a field at the end of a schema's property order.
- Adding a new result object for a new command.

A change to a schema's shape bumps that schema's version, and CI diffs the shipped schemas against the previous release so this cannot happen by accident.

### The file format

Every workspace file carries a `schema: <n>` first line.

Breaking, and therefore never done:

- Any change that makes a file written by a released version unreadable by a later one. Reading is always possible, through the migration chain the tool carries.

Breaking, and allowed with a minor bump plus release notes:

- A change to the grammar or to the meaning of an existing field, which bumps the compiled-in schema number. A file below that number is read through the migration chain, and a mutation to it is refused with a fix line naming the `migrate` command, because writing it would rewrite the whole file as a side effect of a one-record change.

Not breaking:

- Adding an optional field or a new section name. Unknown fields and unknown sections are preserved verbatim and travel with the record through every mutation, so an older tool writing a newer file loses nothing it did not understand.

## The runtime floor

The declared floor is Node.js 24.15.

The floor is the oldest Node.js release line still inside its official support window at the time of each release, reviewed at every Node LTS transition rather than when something breaks.
A release never ships with a floor on a line that reaches end of life within six months of that release date.

Raising the floor is a breaking change and gets a minor bump and a release note.

## Deprecation

Anything on its way out is deprecated for at least one minor release before it goes.
A deprecated command or flag keeps working, and says on stderr that it is deprecated, what replaces it, and the version it will be removed in.
The notice goes to stderr and never to stdout, so it cannot contaminate a piped result.
