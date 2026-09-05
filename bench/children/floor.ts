// SPDX-License-Identifier: Apache-2.0
// The same program as floor.js with one type annotation, so the gap between the two is the
// price Node's type stripper charges. The product ships a bundle (DR1) and these children run
// from source, so that gap is what separates these figures from DR1's.

const ops: number = 1

process.stdout.write(JSON.stringify({
  inProcessMs: 0,
  maxRssKb: process.resourceUsage().maxRSS,
  ops,
  detail: { loadMs: performance.now() },
}) + '\n')
