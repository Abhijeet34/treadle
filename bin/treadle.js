#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The development entry point: it runs treadle from TypeScript source, with no build step,
// which is what `node bin/treadle.js` in the README and the process-spawning tests use.
// The published executable is `dist/treadle.js`, the esbuild bundle of the same entry file.

import '../src/cli/entry.ts'
