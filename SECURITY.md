# Security policy

treadle is maintained by one person, Abhijeet Halder, in his own time.
There is no security team and no bug bounty.
What follows is what one maintainer can actually do, stated so you can hold him to it.

## Reporting a vulnerability

Report it privately through GitHub, not in a public issue.

Open the repository on GitHub, click the **Security** tab, then **Report a vulnerability**.
That opens a draft security advisory visible only to the maintainer, and it lets the two of you talk in private until there is a fix.
The direct link is <https://github.com/Abhijeet34/treadle/security/advisories/new>.

A useful report names the commit or version you tested, your operating system and `node --version`, the steps that reproduce it, and what an attacker gains at the end.
A proof of concept is welcome and never required.

## What you can expect

- An acknowledgement within 7 days of the advisory being opened.
- An assessment within 30 days of that acknowledgement: whether it reproduces, what the impact is, and whether a fix is coming.
- A fix released as soon as it is ready, and credit in the published advisory if you want it.

Those are targets one person can meet.
If one is going to slip, it gets said in the advisory thread rather than passing in silence.

## Supported versions

Releases are the `v*` tags in this repository, each with a GitHub release under **Releases**.
The newest release is the supported version and nothing older.
A project at this size does not backport, and a support matrix that says otherwise would be a promise nobody keeps.
Fixes land on `main` and ship in the next release, so report against the newest release or against `main`, and say which.

The tool requires Node.js 24.15 or newer, and the floor moves forward with the Node.js support schedule rather than staying pinned; a report against an older Node is a configuration issue, not a vulnerability, unless it is a defect in the version check itself.
A report against a copy installed from npm and a report against the `v*` tag of the same version are the same report.

## Scope

treadle is a command-line tool that runs on your own machine and edits work-item files in a directory you point it at.
It opens no network connection in any code path, and the files it reads and writes are the workspace you gave it.
Its trust boundary is that repository content is untrusted: a workspace you cloned from someone else is attacker-controlled input, and the tool's job is to parse it, render it, and refuse the parts that are malformed without ever executing them.
Reports are in scope when they break that boundary.

In scope:

- Code execution of any kind, a write outside the resolved workspace, or a read outside it, caused by the content of a cloned workspace: a crafted record, event line, or configuration value. treadle runs no program and evaluates no string, by the decision in `docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md`, so any execution at all is a report against that record.
- Output that forges the tool's own agent-facing lines, so a consumer reads a field, an envelope, or a state the tool did not emit, from a crafted title, body, or field.
- A crafted field that rewrites or spoofs a terminal, or reorders a rendered row, past the store's own validation.
- An export (CSV, Markdown) that carries an attacker's content into a formula or a script when a person opens it.
- A malformed record that refuses service for the whole store rather than being quarantined to that one record.
- Resource exhaustion that gets past the tool's stated file-size, record-count, and depth ceilings rather than merely reaching a performance budget.
- A prototype-pollution or parser-abuse path through the record grammar or the event log.
- Any outbound connection opened by the process.
- State written where another user on the machine can read or redirect it: a predictable temp file, a followed symlink, or a world-writable index.

Out of scope:

- Anything a process already running as your own user can do. The workspace is your files; the tool defends against hostile repository content and against other users on the machine, not against yourself.
- The text of a work item read as instructions by an agent that was told the text is data. Titles, descriptions, reasons and notes are untrusted third-party content, the agent contract marks them as such, and an agent that executes them as instructions has a defect of its own. A field that forges the tool's own output lines, rather than merely reading as an instruction, is in scope, above.
- Denial of service by deliberately reaching a documented ceiling from a local process. Those are limits on your own machine, not an authorization boundary.
- Vulnerabilities in your browser, your operating system, Node.js, or a spreadsheet application.
- A dependency advisory with no working path through this code. The tool ships zero runtime dependencies, so report a build-time advisory upstream and tell us if a version pinned here is the vulnerable one.
- Scanner output with no demonstrated path through this code.

## What is already known

The project's threat model raised thirteen findings against the design before any code existed.
Twelve are closed, each naming a regression test that was shown to fail before it passed, and `test/security/findings.test.ts` is the register that holds a finding to one.
Three of the twelve closed by having their surface removed rather than guarded, which [docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md](docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md) argues: the hook contract, the path rule that came with it, and the adapter generator.
The one that remains open is F4, CSV formula injection, which lands with export and is not built.
Reporting it is welcome and will be answered with that.

## The supply-chain controls this project holds itself to

- `.npmrc` carries `ignore-scripts=true`, so no dependency's install script runs here.
- The lockfile is committed, and every workflow installs with `npm ci` rather than `npm install`, so a build resolves to the versions in the tree.
- Development dependencies are the only dependencies: the published package has none at runtime, and `npm run licences` refuses one whose licence is off the allowlist.
- Every third-party action in every workflow is pinned to a 40-character commit SHA.
- The release path exports an SBOM and attests the tarball through GitHub's OIDC identity, with no stored registry token anywhere in this repository.

`test/architecture/supply-chain.test.ts` is what holds those, and [docs/RELEASING.md](docs/RELEASING.md) carries the release path itself.
No release has fired, so provenance at publish is asserted over the workflow and the preflight script rather than over a publish that happened; [docs/VERIFICATION.md](docs/VERIFICATION.md) says so under what is not proven.
