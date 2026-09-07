#!/usr/bin/env -S node --stack-size=3072
// SPDX-License-Identifier: Apache-2.0
// The development entry point: it runs treadle from TypeScript source, with no build step,
// which is what `node bin/treadle.js` in the README and the process-spawning tests use.
// The published executable is `dist/treadle.js`, the esbuild bundle of the same entry file,
// and `scripts/build.ts` reads the shebang above from this file so there is one copy of it.
//
// WHY 3072. The kernel puts argv and the environment at the top of the main thread's stack
// and V8 sets its limit `--stack-size` KiB below that top, so the 984 KiB default is
// exhausted by a block execve is willing to carry and the process dies before this file runs.
// POSIX bounds argv and the environment TOGETHER at ARG_MAX, so the bound to clear is that
// ceiling and not the size of any one entry: 1 MiB on macOS, 2 MiB on Linux at the default
// 8 MiB stack rlimit. 3 MiB clears both and leaves the isolate about the runtime's own
// default stack on top of the larger of them.
//
// Measured on 2026-09-07, and the reason the number is not smaller: eleven arguments of
// 90,000 characters, a 990,547 byte block whose every entry is far below Linux's 128 KiB
// per-argument cap, is a RangeError and exit 7 at `--stack-size=984` and a clean run at 3072.
// The same block delivered as eleven environment variables, with an ordinary short command
// line, does the same thing. So the crash is reachable through argv and through the
// environment on both platforms, and a per-argument limit does not bound it.
//
// The cost, also measured: a V8 stack larger than the thread's own means unbounded recursion
// faults rather than throwing. The window is a stack rlimit under 3 MiB, the default is 8 MiB
// on macOS and Linux alike, and nothing under src/ recurses without a bound (JSON nesting is
// capped at read, and no walk here is deeper than the store's directories).
// test/cli/oversized-argument.test.ts holds the shebang to this platform's own ARG_MAX.

import '../src/cli/entry.ts'
