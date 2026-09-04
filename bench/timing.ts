// SPDX-License-Identifier: Apache-2.0
// The timing rig. DR1's method is the one followed here: N sequential launches of a cold
// process, the first launch reported on its own rather than folded into the distribution,
// and a harness floor measured with the same launcher so a figure can be reported net of
// the shell rather than including it.
//
// Percentiles are nearest-rank and every one carries the rank it resolved to. At n=30 the
// 99th percentile IS the maximum, and a table that prints "p99" without saying so invites
// a reader to believe there were enough samples to separate the two.

import { spawnSync } from 'node:child_process'

export type Percentile = {
  readonly ms: number
  /** 1-based index into the sorted samples that this percentile selected. */
  readonly rank: number
  readonly of: number
}

export type Stats = {
  readonly n: number
  /** Discarded from the distribution and reported alone, as DR1 does. */
  readonly firstRunMs: number
  /** Best of N: the minimum of the retained runs. */
  readonly minMs: number
  readonly p50: Percentile
  readonly p95: Percentile
  readonly p99: Percentile
  readonly maxMs: number
}

export type ChildReport = {
  readonly inProcessMs?: number
  readonly maxRssKb?: number
  readonly ops?: number
  readonly detail?: Record<string, unknown>
}

export type Sample = {
  readonly wallMs: number
  readonly status: number | null
  readonly report?: ChildReport
  readonly failure?: string
}

export type Measurement = {
  readonly label: string
  readonly command: string
  readonly wall: Stats
  /** Wall stats with the floor's median removed. Absent when no floor was supplied. */
  readonly net?: Stats
  readonly floorMedianMs?: number
  readonly floorClamped: boolean
  readonly inProcess?: Stats
  readonly peakRssKb?: number
  /** Store operations the children actually performed, summed. Zero is the tell. */
  readonly opsTotal: number
  readonly failures: readonly string[]
}

function percentile(sorted: readonly number[], p: number): Percentile {
  const n = sorted.length
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)))
  return { ms: sorted[rank - 1] as number, rank, of: n }
}

export function stats(firstRunMs: number, retained: readonly number[]): Stats {
  const sorted = [...retained].sort((a, b) => a - b)
  return {
    n: sorted.length,
    firstRunMs,
    minMs: sorted[0] as number,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] as number,
  }
}

/** Subtracts a constant from every sample, which shifts each percentile by that constant. */
function shift(source: Stats, by: number): { readonly stats: Stats; readonly clamped: boolean } {
  let clamped = false
  const drop = (ms: number): number => {
    const out = ms - by
    if (out < 0) clamped = true
    return Math.max(0, out)
  }
  const move = (p: Percentile): Percentile => ({ ...p, ms: drop(p.ms) })
  return {
    stats: {
      n: source.n,
      firstRunMs: drop(source.firstRunMs),
      minMs: drop(source.minMs),
      p50: move(source.p50),
      p95: move(source.p95),
      p99: move(source.p99),
      maxMs: drop(source.maxMs),
    },
    clamped,
  }
}

export type LaunchOptions = {
  readonly samples: number
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly timeoutMs?: number
}

/** One cold process, timed end to end by the parent's monotonic clock. */
export function launchOnce(command: string, args: readonly string[], options: LaunchOptions): Sample {
  const started = process.hrtime.bigint()
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: options.env ?? process.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6
  if (result.error !== undefined) {
    return { wallMs, status: result.status, failure: result.error.message }
  }
  if (result.status !== 0) {
    return { wallMs, status: result.status, failure: `exit ${result.status}: ${(result.stderr || '').trim().slice(0, 400)}` }
  }
  const line = (result.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (line === undefined) {
    return { wallMs, status: result.status, failure: `no JSON report on stdout: ${(result.stdout || '').trim().slice(0, 200)}` }
  }
  try {
    return { wallMs, status: result.status, report: JSON.parse(line) as ChildReport }
  } catch (error) {
    return { wallMs, status: result.status, failure: `unparsable report: ${(error as Error).message}` }
  }
}

export type MeasureOptions = LaunchOptions & {
  readonly label: string
  /** Median of the harness floor, subtracted to give the program's own cost. */
  readonly floorMedianMs?: number
  /** A child that reports no JSON line, such as `/usr/bin/true`. */
  readonly expectNoReport?: boolean
}

export function measure(command: string, args: readonly string[], options: MeasureOptions): Measurement {
  const samples: Sample[] = []
  const failures: string[] = []
  for (let i = 0; i <= options.samples; i += 1) {
    const sample = launchOnce(command, args, options)
    if (sample.failure !== undefined && !(options.expectNoReport === true && sample.status === 0)) {
      failures.push(sample.failure)
    }
    samples.push(sample)
  }
  const first = samples[0] as Sample
  const retained = samples.slice(1)
  const wall = stats(first.wallMs, retained.map((s) => s.wallMs))

  const inProcessValues = retained
    .map((s) => s.report?.inProcessMs)
    .filter((v): v is number => typeof v === 'number')
  const inProcess = inProcessValues.length === retained.length && inProcessValues.length > 0
    ? stats(first.report?.inProcessMs ?? inProcessValues[0] as number, inProcessValues)
    : undefined

  const rss = retained.map((s) => s.report?.maxRssKb).filter((v): v is number => typeof v === 'number')
  const opsTotal = samples.reduce((sum, s) => sum + (s.report?.ops ?? 0), 0)

  const shifted = options.floorMedianMs === undefined ? undefined : shift(wall, options.floorMedianMs)
  return {
    label: options.label,
    command: [command, ...args].join(' '),
    wall,
    ...(shifted === undefined ? {} : { net: shifted.stats }),
    ...(options.floorMedianMs === undefined ? {} : { floorMedianMs: options.floorMedianMs }),
    floorClamped: shifted?.clamped ?? false,
    ...(inProcess === undefined ? {} : { inProcess }),
    ...(rss.length === 0 ? {} : { peakRssKb: Math.max(...rss) }),
    opsTotal,
    failures: failures.slice(0, 5),
  }
}
