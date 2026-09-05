// SPDX-License-Identifier: Apache-2.0
// The harness's own cost, measured with the same launcher as everything else.
//
// Five floors, each one a strict superset of the one above it, so the difference between two
// rows prices exactly one thing: spawning a process, starting Node, evaluating a JavaScript
// file, stripping types from a TypeScript file, and loading the store adapter. The last gap
// is what separates these figures from DR1's, which were taken on the bundle the tree now
// builds and these children still do not run.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { measure, type Measurement } from './timing.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export type Floors = {
  readonly rows: readonly Measurement[]
  /** Which statistic the two derived costs below were taken from. */
  readonly derivedFromStatistic: 'best of N'
  /** Subtracted from every wall figure to give the program's own cost. */
  readonly spawnMedianMs: number
  /** The runner-relative baseline the CI gate compares a cold start against. */
  readonly nodeMedianMs: number
  readonly typeStrippingMs: number | string
  readonly storeLoadMs: number | string
}

export function measureFloors(samples: number): Floors {
  const spawn = measure('/usr/bin/true', [], { samples, label: 'spawn floor (/usr/bin/true)', expectNoReport: true })
  const spawnMedianMs = spawn.wall.p50.ms

  const node = measure(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ops:1}))'], {
    samples, label: 'node floor (node -e)', floorMedianMs: spawnMedianMs,
  })
  const js = measure(process.execPath, [path.join(HERE, 'children', 'floor.js')], {
    samples, label: 'node + one JavaScript file', floorMedianMs: spawnMedianMs,
  })
  const ts = measure(process.execPath, [path.join(HERE, 'children', 'floor.ts')], {
    samples, label: 'node + one TypeScript file (type stripping)', floorMedianMs: spawnMedianMs,
  })
  const store = measure(process.execPath, [path.join(HERE, 'children', 'floor-store.ts')], {
    samples, label: 'node + the store adapter loaded, no work done', floorMedianMs: spawnMedianMs,
  })

  return {
    rows: [spawn, node, js, ts, store],
    spawnMedianMs,
    nodeMedianMs: node.wall.p50.ms,
    derivedFromStatistic: 'best of N',
    // Best of N, not the median. Both are fixed costs, so the cleanest launch of fifty is
    // the closest thing to an uncontaminated reading of them. Measured across five runs on
    // 2026-09-05, the min-based type-stripping cost spread 0.11 ms across four quiet runs
    // while the median-based one spread 14.7 ms, because one run's floor phase ran under
    // load and a median of fifty carries that load where a minimum does not.
    typeStrippingMs: ts.failures.length > 0 || js.failures.length > 0
      ? `NOT MEASURED: ${[...ts.failures, ...js.failures][0]}`
      : Number((ts.wall.minMs - js.wall.minMs).toFixed(2)),
    storeLoadMs: store.failures.length > 0
      ? `NOT MEASURED: ${store.failures[0]}`
      : Number((store.wall.minMs - ts.wall.minMs).toFixed(2)),
  }
}
