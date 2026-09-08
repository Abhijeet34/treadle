# Stability and versioning

treadle follows [Semantic Versioning 2.0.0](https://semver.org/).
This file says what a breaking change is for this project, because "breaking" means nothing until someone writes down what the contract is.

## The pre-1.0 policy

The current version is 0.x.
Under SemVer, 0.x makes no compatibility promise at all, and a project that hides behind that clause while people build on it is being dishonest.
So the promise here is narrower than 1.0 and larger than nothing.

- **A breaking change bumps the minor version** while the major is 0. `0.4.0` may break what `0.3.0` did; `0.3.1` may not break `0.3.0`.
- **Every breaking change is named in the release notes**, with what broke, why, and what to do instead. A release that breaks something silently is a bug in the release.
- **The file format is exempt from the "may break" clause.** A workspace written by any released version is readable by every later version. Reading always works. See [The file format](#the-file-format).
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

`7` is the one status a command can exit while still printing its answer on stdout: `doctor` answers with the findings table and exits `7` when a row on it hides a record or names a served record the audit flagged.
A table whose every row reports content the store still serves and the next write normalises, `H16`'s CRLF checkout being the one that happens by accident, prints the rows and exits `0` under a `serving` line, because a CI job could not otherwise tell that checkout from a truncated shard.
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

- Any change that makes a file written by a released version unreadable by a later one. Reading is always possible. There is one compiled-in schema number today and no migration has been needed, so the chain a later bump would need does not exist yet.

Breaking, and allowed with a minor bump plus release notes:

- A change to the grammar or to the meaning of an existing field, which bumps the compiled-in schema number. A file below that number is still read as it stands, and a mutation to it is refused as `SCHEMA_OLDER` (`S9`) at exit `6`, because writing it would rewrite the whole file as a side effect of a one-record change. The command that would rewrite it is `migrate`, which the README's Status table records as Declined until a schema 2 exists, so the refusal names no rewrite: it says that no command here rewrites the file yet, and its fix line is `treadle version`. A fix line naming a command the tool does not carry would not run as printed, which `test/cli/runnable-lines.test.ts` refuses.

Not breaking:

- Adding an optional field or a new section name. Unknown fields and unknown sections are preserved verbatim and travel with the record through every mutation, so an older tool writing a newer file loses nothing it did not understand.

## The runtime floor

The declared floor is Node.js 24.15.

The floor is the oldest Node.js release line still inside its official support window at the time of each release, reviewed at every Node LTS transition rather than when something breaks.
A release never ships with a floor on a line that reaches end of life within six months of that release date.

Raising the floor is a breaking change and gets a minor bump and a release note.

## The supported userlands, and the macOS argument-block limit

`bin/treadle.js` and the shipped bundle open with `#!/usr/bin/env node`, which every POSIX
userland runs, BusyBox included.
That is a support statement: `node:24-alpine` is the smallest official Node image and the one a
container-based agent reaches for first, and a tool whose first command prints
`env: unrecognized option: S` has failed before it started.
It is also a Windows statement, because npm does not link on Windows: `cmd-shim` reads that
first line and writes the program it names into the generated `treadle.cmd` and `treadle.ps1`.
`scripts/shebang.ts`'s `portabilityProblem` holds the line, `test/cli/oversized-argument.test.ts`
asserts it on every platform, and the `installed` and `installed-windows` jobs of
`.github/workflows/cross-platform.yml` start the packed tarball from BusyBox, glibc, `cmd.exe`
and PowerShell so a first line that stops the tool starting cannot reach a release.

The cost of that line is one platform limit on macOS, and this section states it as the trade it
is rather than as something unavoidable.

### The limit, measured

On macOS the kernel places argv and the environment at the top of the main thread's stack and
V8 sets its own limit `--stack-size` KiB below that top, so a large enough block leaves the
isolate with no stack and the process dies inside Node's bootstrap:
`RangeError: Maximum call stack size exceeded` at `<anonymous_script>:0`, exit 7, before the
first line of this tool runs.
That exit 7 is worth naming, because it is the one place a caller sees this tool's
`INTERNAL` code without the store being in the state that code otherwise reports.

Measured 2026-09-07 on Node 24.11.1, with a 59-byte environment:

| Case | Result |
|---|---|
| Single argument of 955,173 bytes, a block of about 955,270 | survives |
| Single argument of 955,182 bytes | `RangeError`, exit 7 |
| Single argument of 1,048,000 bytes, over the 1,048,576 `ARG_MAX` | exit 126, `argument list too long`, from the shell; treadle never runs |
| The same block delivered as environment variables behind a short command line | dies identically |
| `node /dev/null "$(cat 1mb)"`, an empty script | dies identically |

So the ceiling is a block of about 955 KB rather than the nominal 984 KiB, 52 KiB lower,
because Node's own bootstrap has already spent that much stack before the first JS frame.
The crash band runs from there to `ARG_MAX`, and it is about 93 KB wide.
The empty-script case is what places the fault in the runtime's startup rather than in any code
here, and `ulimit -s` does not move it: the geometry is measured from the top of the stack, not
from its size.

### Why no valid call reaches it

The field dictionary is checked before anything is written, so the largest command line a legal
call can produce is bounded well below the band: `MAX_DESCRIPTION` is 10,000 characters,
`MAX_LINE` is 200, `MAX_REASON` and `MAX_CAUSE` are 500, and a `set` naming every settable field
at its bound is under 25 KB.
The band starts 38x above that.
Every block inside it is a call this tool refuses on every platform; what macOS changes is the
refusal's shape, from `err VALIDATION` at exit 2 to a `RangeError` at exit 7.

Linux is not uniformly better, which is the part the earlier version of this section left out.
Debian 12 and Alpine both refuse any single argument over 131,072 bytes with `E2BIG` at exec,
exit 126, before treadle runs, so the 1,000,000-byte single argument that macOS answers with a
typed refusal below 955 KB is a kernel refusal on Linux at every size over 128 KiB.
What Linux does carry better is the total: 23 arguments of 90,000 characters, 2,070,023 bytes,
answered typed on both images, and a 24th was `E2BIG`.
CI run 34106349134 answered behind 4,140,820 bytes of argv and 4,142,278 bytes of environment
on a runner with a raised stack rlimit; under the default 8 MiB stack the Linux total is 2 MiB.
Windows caps a whole command line at 32,767 characters, far below the band.

### The two launchers that would remove it, and what each costs

A block this size only reaches V8 because V8 is what the kernel execs.
Put a program that is not V8 on the first line and it can survive the block and hand node a
larger stack, so the limit is removable.
Both ways of doing that were built and run, and each costs a platform the package supports.

`#!/usr/bin/env -S node --stack-size=3072` was shipped for one day and reverted.
BusyBox `env` takes `-i`, `-0` and `-u` and has no `-S`, so on `node:24-alpine`, measured
2026-09-07, `treadle version` printed `env: unrecognized option: S` and exited 1.
The first command a stranger runs on the most common small CI image failed.

`#!/bin/sh` with `':' //; exec node --stack-size=2048 "$0" "$@"` on the second line removes the
band on macOS, glibc and BusyBox alike, and stops the tool starting in every native Windows
shell.
Measured 2026-09-08 on `windows-2025` with Node 24.15.0 and npm 11.12.1, from a genuine
`npm pack` and global install:

| Launcher | `cmd.exe` | PowerShell 7 and Windows PowerShell 5.1 |
|---|---|---|
| `#!/usr/bin/env node` | `ok version -`, exit 0 | `ok version -`, exit 0 |
| `#!/bin/sh` | `The system cannot find the path specified.`, exit 1 | `The term '/bin/sh.exe' is not recognized as a name of a cmdlet, function, script file, or executable program.`, exit **0** |
| `#!/usr/bin/env sh` | `ok version -`, exit 0 | `ok version -`, exit 0 |
| `#!/usr/bin/env sh`, no POSIX `sh` on `PATH` | `'"sh"' is not recognized as an internal or external command`, exit 1 | `The term 'sh.exe' is not recognized`, exit **0** |

`treadle init` and `treadle file task` behave as their `version` row does, in both shells.
The exit 0 is the reason this trade is worse than it reads: npm's `treadle.ps1` assigns
`$ret=$LASTEXITCODE` after a call that never happened, so a `CommandNotFoundException` leaves
the exit code at 0 and a Windows user's script sees success over a launcher that never ran.

`#!/usr/bin/env sh` is the near miss.
It starts in all three native Windows shells and on `node:24-alpine` and `node:24-trixie-slim`,
but only because npm's shim resolves a bare `sh` through `PATH` and the machine happened to
carry Git for Windows.
Take that off `PATH` and it fails exactly like `#!/bin/sh`, invisibly in PowerShell.
It does not make treadle run on Windows; it makes treadle run on a Windows machine that already
has something else installed.

### The decision, and what it gives up

Keep `#!/usr/bin/env node`.
Decided 2026-09-08 after the Windows measurement, recorded as `macos-argv-band-vs-windows-shims`.

What that gives up is one refusal shape, on one platform, for a block between about 955 KB and
1 MiB that the field dictionary refuses everywhere anyway.
What the alternatives would have given up is a platform that works today, in exchange for a
failure mode that reports success.
A limit a valid call cannot reach costs less than a silent failure a stranger can reach on their
first run.

Two consequences of keeping the line, so nobody re-derives them:

- No check at an entry point can fire, because on the crashing platform the entry point is never
  evaluated.
- `NODE_OPTIONS=--stack-size=3072` is refused by Node itself, so the environment cannot carry the
  flag either.

What holds everywhere is the bound on the value rather than on the block: `MAX_CAUSE` and
`MAX_LINE` bound what a refusal prints and the field dictionary bounds what a value may be, so
any argument this tool actually reads is a typed refusal with no stack trace.
If a workflow genuinely needs to pass a megabyte on macOS, pass it through a file and a field the
dictionary sizes, or run node with `--stack-size=3072` yourself.

## Deprecation

Anything on its way out is deprecated for at least one minor release before it goes.
A deprecated command or flag keeps working, and says on stderr that it is deprecated, what replaces it, and the version it will be removed in.
The notice goes to stderr and never to stdout, so it cannot contaminate a piped result.
