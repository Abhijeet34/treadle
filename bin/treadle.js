#!/usr/bin/env -S node --stack-size=3072
// SPDX-License-Identifier: Apache-2.0
// The development entry point: it runs treadle from TypeScript source, with no build step,
// which is what `node bin/treadle.js` in the README and the process-spawning tests use.
// The published executable is `dist/treadle.js`, the esbuild bundle of the same entry file,
// and `scripts/build.ts` reads the shebang above from this file so there is one copy of it.
//
// WHY 3072. On macOS the kernel puts argv and the environment at the top of the main thread's
// stack and V8 sets its limit `--stack-size` KiB below that top, so the 984 KiB default is
// exhausted by a block execve is willing to carry and the process dies before this file runs.
// Measured 2026-09-07: eleven arguments of 90,000 characters, a 990,547 byte block whose every
// entry is far below Linux's 128 KiB per-entry cap, is a RangeError and exit 7 at
// `--stack-size=984` and a clean run at 3072; the same block delivered as eleven environment
// variables, behind an ordinary short command line, does the same. So the fault is reachable
// through argv and through the environment, and a per-entry limit does not bound it.
//
// ARG_MAX IS NOT THE NUMBER TO CLEAR, which one CI round was spent believing. That reading
// says 3072 is too small on Linux, where CI run 34106349134 measured ARG_MAX at 4,194,304. In
// that same run treadle answered, typed, behind 4,140,820 bytes of argv and 4,142,278 bytes of
// environment under this 3 MiB stack: a block larger than the whole V8 stack, running clean.
// Linux does not charge the block against the stack the way macOS does, so the relation is
// macOS's and not the platform's, and the request is sized to what macOS needs.
//
// The bound on the other side is why it is not simply raised further: a V8 stack near the main
// thread's own means a deep call faults rather than throwing, and a segfault is worse than the
// RangeError this line exists to prevent. 3 MiB is under half the 8 MiB the thread gets by
// default on macOS and Linux alike, and nothing under src/ recurses without a bound (JSON
// nesting is capped at read, and no walk here is deeper than the store's directories).
//
// test/cli/oversized-argument.test.ts holds both bounds against the platform it runs on, and
// the tool's own answer against the largest block that platform can deliver.

import '../src/cli/entry.ts'
