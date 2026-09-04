// SPDX-License-Identifier: Apache-2.0
// What else the machine was doing while a figure was taken.
//
// This rig does not run on an idle machine and will not: sibling workers share it, and
// waiting for quiet is not a method. So the confound is recorded instead of dodged. Every
// measurement carries a load sample from immediately before and immediately after it, and a
// reader who sees a figure above its series can check whether the machine was busy for it.
//
// `pgrep` rather than `ps`, which the sandbox refuses.

import { execFileSync } from 'node:child_process'
import { freemem, loadavg, totalmem } from 'node:os'

export type LoadSample = {
  readonly at: string
  /** Kernel run-queue averages over 1, 5 and 15 minutes. */
  readonly load1: number
  readonly load5: number
  readonly load15: number
  readonly freeMemMiB: number
  readonly usedMemPercent: number
  /** Every `node` process on the machine, this run's own children included. */
  readonly nodeProcesses: number | string
}

function processCount(pattern: string): number | string {
  // Lines counted here rather than `pgrep -c`, which is a Linux flag that macOS pgrep does
  // not carry; asking for it fails outright rather than counting.
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').filter((line) => line.trim().length > 0).length
  } catch (error) {
    // pgrep exits 1 when nothing matches, which is a count of zero rather than a failure.
    if ((error as { status?: number }).status === 1) return 0
    return `NOT MEASURED: pgrep failed: ${(error as Error).message.split('\n')[0]}`
  }
}

export function sampleLoad(): LoadSample {
  const [one, five, fifteen] = loadavg()
  const total = totalmem()
  return {
    at: new Date().toISOString(),
    load1: Number((one ?? 0).toFixed(2)),
    load5: Number((five ?? 0).toFixed(2)),
    load15: Number((fifteen ?? 0).toFixed(2)),
    freeMemMiB: Math.round(freemem() / 1024 / 1024),
    usedMemPercent: Number((((total - freemem()) / total) * 100).toFixed(1)),
    nodeProcesses: processCount('node'),
  }
}

/** The busier of two samples, which is the one a reader should judge a figure against. */
export function peakLoad(before: LoadSample, after: LoadSample): number {
  return Math.max(before.load1, after.load1)
}
