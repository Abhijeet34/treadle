# Support

One maintainer, in his own time.
Here is where each kind of question goes, so you get an answer rather than silence.

## Something is broken

[Open a bug report](https://github.com/Abhijeet34/treadle/issues/new?template=bug.yml).

The report that gets fixed fastest names the version or commit you ran, your operating system and `node --version`, the exact command, what you expected, and what happened instead.
Paste the output rather than describing it.

## A security problem

Do not open a public issue.
[SECURITY.md](SECURITY.md) has the private route and what to expect.

## You want it to do something it does not do

[Open a feature request](https://github.com/Abhijeet34/treadle/issues/new?template=feature.yml).

Say what you were trying to accomplish before saying what you want added.
The design for this project was written before the code, so a request that names the problem can often be answered from a decision that already exists.

## A question about how it works

Start with the docs; they are short and they are the specification rather than a summary of it.

- [README.md](README.md) for what it is and what state it is in.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layers and the seams.
- [docs/DOMAIN.md](docs/DOMAIN.md) for the types, the lifecycle, the relations and the gates, and the rule ids errors name.
- [docs/STABILITY.md](docs/STABILITY.md) for what counts as a breaking change.
- [CONTRIBUTING.md](CONTRIBUTING.md) for setting up and for the rules a change is held to.

If the answer is not there, that is a documentation bug worth an issue of its own.

## What is not supported

There is no released version yet, so there is nothing to support in production.
`package.json` carries `"private": true` and publication is gated on a name clearance that has not run.

## Response times

Best effort.
Security reports get the timelines in [SECURITY.md](SECURITY.md), which are the only ones promised.
