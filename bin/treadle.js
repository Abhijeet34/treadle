#!/usr/bin/env -S node --stack-size=2000
// SPDX-License-Identifier: Apache-2.0
// The development entry point: it runs treadle from TypeScript source, with no build step,
// which is what `node bin/treadle.js` in the README and the process-spawning tests use.
// The published executable is `dist/treadle.js`, the esbuild bundle of the same entry file,
// and `scripts/build.ts` reads the shebang above from this file so there is one copy of it.
//
// WHY 2000. The kernel puts argv and the environment at the top of the main thread's stack
// and V8 sets its limit `--stack-size` KiB below that top, so the 984 KiB default is
// exhausted by an argv block execve is willing to carry and the process dies before this file
// runs. POSIX bounds argv and the environment together at ARG_MAX, one mebibyte on macOS, so
// 2000 leaves the isolate about the default's own stack even when argv is at that ceiling.
// Measured: at 984 a 1,000,000 character argument is a RangeError with no stack trace and
// exit 7, and at 1200 and above it is the tool's own typed refusal and exit 2.
//
// The cost, also measured: a V8 stack larger than the thread's own means unbounded recursion
// faults rather than throwing. The window is a stack rlimit between 984 KiB and 2 MiB, the
// default is 8 MiB on macOS and Linux alike, and nothing under src/ recurses without a bound
// (JSON nesting is capped at read, and no walk here is deeper than the store's directories).
// test/cli/oversized-argument.test.ts holds the shebang to a stack no argv block can exhaust.

import '../src/cli/entry.ts'
