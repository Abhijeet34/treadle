// SPDX-License-Identifier: Apache-2.0
// Loads the whole store adapter and does no work. The difference against floor.ts is the
// cost of parsing and evaluating the layer, which is the part of every read below that has
// nothing to do with the corpus size.

import { ShardedStore } from '../../src/adapters/store/index.ts'

const loadMs = performance.now()

process.stdout.write(JSON.stringify({
  inProcessMs: 0,
  maxRssKb: process.resourceUsage().maxRSS,
  ops: ShardedStore === undefined ? 0 : 1,
  detail: { loadMs },
}) + '\n')
