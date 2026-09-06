// SPDX-License-Identifier: Apache-2.0
// The run is described by a control file, not by a flag list: the parameters that decide
// what a figure means (seed, scales, sample counts) belong somewhere a reader can diff.
// Flags exist only for the two things that change per invocation, the output directory and
// whether a cached corpus may be reused.

import { readFileSync } from 'node:fs'
import path from 'node:path'

export type BenchConfig = {
  readonly seed: number
  readonly lastMonth: string
  readonly months: number
  readonly eventsPerItem: number
  readonly relationsPerHundredItems: number
  readonly impedimentsPerHundredItems: number
  readonly scales: readonly number[]
  readonly samples: Readonly<Record<string, number>>
  readonly floorSamples: number
  readonly corpusDir: string
  readonly a1WriterCounts: readonly number[]
  readonly a5: { readonly corpusScale: number; readonly randomEdits: number }
}

export function loadConfig(root: string, overrides: Partial<BenchConfig> = {}): BenchConfig {
  const file = JSON.parse(readFileSync(path.join(root, 'bench', 'bench.config.json'), 'utf8')) as BenchConfig
  const corpusDir = process.env['TREADLE_BENCH_DIR'] ?? file.corpusDir
  return { ...file, corpusDir, ...overrides }
}

export function samplesFor(config: BenchConfig, items: number): number {
  return config.samples[String(items)] ?? config.samples['default'] ?? 20
}
