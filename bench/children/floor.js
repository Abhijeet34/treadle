// SPDX-License-Identifier: Apache-2.0
// The Node floor: a process that starts, prints the report line and exits. Subtracting the
// spawn floor from this gives what the runtime itself costs before any of our code runs.

process.stdout.write(JSON.stringify({
  inProcessMs: 0,
  maxRssKb: process.resourceUsage().maxRSS,
  ops: 1,
  detail: { loadMs: performance.now() },
}) + '\n')
