# bin

`treadle.js` is the published executable, and `package.json` points `bin` at it.

It owns the process and nothing else: argv, the streams, the TTY test, the exit status, and
the filter that keeps a runtime notice from preceding the envelope. Everything a test needs
to drive is `run` in `src/cli/main.ts`, which takes all of that as arguments, so the suite
reads what a command wrote without spawning a process per assertion.

It imports TypeScript directly, which Node runs by stripping types, and that is the entry
point the suite and the README drive. It is not what a published package would run:
`npm run build` bundles the same entry file to `dist/treadle.js`, and `bin` and `files` in
`package.json` both name that bundle, so no source reaches the tarball. Nothing is published
yet, and `docs/RELEASING.md` carries the three interlocks that hold it.
