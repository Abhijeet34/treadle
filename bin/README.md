# bin

`treadle.js` is the published executable, and `package.json` points `bin` at it.

It owns the process and nothing else: argv, the streams, the TTY test, the exit status, and
the filter that keeps a runtime notice from preceding the envelope. Everything a test needs
to drive is `run` in `src/cli/main.ts`, which takes all of that as arguments, so the suite
reads what a command wrote without spawning a process per assertion.

It imports TypeScript directly, which Node runs by stripping types. A bundled single file
under `dist/` is a packaging task and is not here yet; nothing is published until it is.
