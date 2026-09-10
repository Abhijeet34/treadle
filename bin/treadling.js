#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The development entry point: it runs treadling from TypeScript source, with no build step,
// which is what `node bin/treadling.js` in the README and the process-spawning tests use.
// The published executable is `dist/treadling.js`, the esbuild bundle of the same entry file,
// and `scripts/build.ts` reads the shebang above from this file so there is one copy of it.
//
// WHY THE PLAIN LINE, AND NOTHING AFTER `node`. `#!/usr/bin/env -S node --stack-size=3072`
// stood here for one day and stopped the tool starting at all under BusyBox `env`, which is
// what Alpine ships: measured 2026-09-07 on `node:24-alpine`, `treadling version` printed
// `env: unrecognized option: S` and exited 1, so the first command a stranger on the most
// common small CI image runs failed. BusyBox 1.37.0's `env` takes `-i`, `-0` and `-u` only.
// `#!/usr/bin/env node` runs on every POSIX userland there is, which is why it is back.
//
// WHAT THAT COSTS, AND WHERE IT IS WRITTEN DOWN. The flag bought one thing: on macOS the
// kernel puts argv and the environment at the top of the main thread's stack and V8 sets its
// limit `--stack-size` KiB below that top, so a block over about 955 KB leaves the isolate
// with no stack and the process dies in Node's own bootstrap, before this file's first line.
// No check at an entry point can catch it: `node /dev/null "$(cat 1mb)"` dies the same way
// with an empty script. A `#!/bin/sh` launcher can, because a shell survives the block and
// can hand node a larger stack. That trade was measured and declined on 2026-09-08: on
// `windows-2025` the sh launcher stops the tool starting in every native Windows shell, and
// both PowerShells report exit 0 while it does. `docs/STABILITY.md`, "The supported
// userlands, and the macOS argument-block limit", carries every number and both rejected
// launchers. Linux does not charge the block against the stack: CI run
// 34106349134 answered, typed, behind 4,140,820 bytes of argv under the default stack.
//
// The bounds that make an oversized argument readable rather than fatal are in the tool and
// not on this line: `MAX_CAUSE` and `MAX_LINE` bound what a refusal prints, and the field
// dictionary bounds what a value may be. Those hold on every platform and under any shebang.
//
// test/cli/oversized-argument.test.ts holds this line's portability on every platform, and
// the tool's answer against the largest block the platform can deliver where the platform
// can deliver one.

import '../src/cli/entry.ts'
