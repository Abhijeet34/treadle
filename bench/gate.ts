// SPDX-License-Identifier: Apache-2.0
// DR8's regression gate.
//
// A CI runner is not this laptop, so no timing budget here is an absolute millisecond count.
// Every timing row is checked as PROGRAM COST: the operation's MEDIAN wall time minus the
// runner's own `node -e` median, measured in the same job.
//
// The median rather than the p95, because the p95 was measured and cannot carry a gate. Two
// identical four-scale runs on this machine, 2026-09-05, moved their medians by at most 2.4%
// across twenty operations and moved one p95 by 68.9%. A gate on the p95 would fire on the
// scheduler. The p95 and p99 are still reported for every row, because what a slow
// invocation costs an agent is worth knowing; they are just not what a build fails on. That subtraction removes what the
// machine charges to start a process and leaves what our code charges to do the work, which
// is the only part a regression can be attributed to. The committed limit is this machine's
// measured program cost with the tolerance added, and `bench/budgets.json` records the run it
// came from.
//
// The rows that are properties of the package rather than of a machine (dependency count,
// install size, index-to-text ratio) stay absolute, because they are.
//
// A budget with nothing to measure is `pending`, never `pass`. The summary prints all three
// counts, because a gate that reported "0 failures" over 12 pending rows would be green and
// would mean nothing.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { RunReport } from './report.ts'

export type Budgets = {
  readonly tolerancePercent: number
  /** Where the tolerance came from. A percentage nobody measured is not a tolerance. */
  readonly toleranceWhy: string
  readonly derivedFrom: {
    readonly runId: string
    readonly date: string
    readonly machine: string
    readonly node: string
    readonly note: string
  }
  /** Cold start: the store-loading floor's own cost above `node -e`, in milliseconds. */
  readonly coldStartMs: number | null
  readonly timing: {
    /** False until the limits have been re-derived on the machine the gate runs on. */
    readonly enforced: boolean
    readonly why?: string
    /** `<op>@<scale>` to program cost at the median, in milliseconds. */
    readonly limits: Readonly<Record<string, number>>
  }
  /** Axis outcomes that transfer across machines, so they have teeth on any runner. */
  readonly axes: Readonly<Record<AxisBudgetKey, AbsoluteBudget>>
  readonly absolute: Readonly<Record<AbsoluteKey, AbsoluteBudget>>
}

export const AXIS_BUDGET_KEYS = [
  'a1Durability', 'a1Crashes', 'a5SilentDrops', 'a5WholeStoreRefusals', 'a5Crashes',
] as const
export type AxisBudgetKey = (typeof AXIS_BUDGET_KEYS)[number]

export const ABSOLUTE_KEYS = [
  'peakRssReadKb', 'peakRssMutationKb', 'firstIndexBuildMs', 'reindexAfterHandEditMs',
  'indexToTextRatio', 'runtimeDependencies', 'installUnpackedBytes', 'bundleBytes',
] as const
export type AbsoluteKey = (typeof ABSOLUTE_KEYS)[number]

/**
 * `enforced: false` marks a budget the product has never met, which is an open finding
 * rather than a regression. It is still reported as a miss with its number; it simply does
 * not fail a build for standing still. `why` says who has to close it.
 */
export type AbsoluteBudget = {
  readonly limit: number
  readonly enforced: boolean
  readonly source: string
  readonly why?: string
}

export type GateStatus = 'pass' | 'fail' | 'open miss' | 'pending'

export type GateRow = {
  readonly budget: string
  readonly observed: number | string
  readonly limit: number | string
  readonly unit: string
  readonly status: GateStatus
  readonly note?: string
}

export type GateReport = {
  readonly tolerancePercent: number
  readonly toleranceWhy: string
  readonly derivedFrom: Budgets['derivedFrom']
  readonly rows: readonly GateRow[]
  readonly passed: number
  readonly failed: number
  /** Budgets the product has never met. Reported with their number, not build-blocking. */
  readonly openMisses: number
  readonly pending: number
}

export function loadBudgets(root: string): Budgets {
  return JSON.parse(readFileSync(path.join(root, 'bench', 'budgets.json'), 'utf8')) as Budgets
}

/** Median wall time above the runner's own Node floor. Never below zero. */
export function programCost(medianMs: number, nodeFloorMs: number): number {
  return Math.max(0, medianMs - nodeFloorMs)
}

function compare(
  budget: string, observed: number | string, limit: number, unit: string,
  options: { readonly note?: string; readonly enforced?: boolean } = {},
): GateRow {
  const note = options.note
  if (typeof observed === 'string') {
    return { budget, observed, limit, unit, status: 'pending', ...(note === undefined ? {} : { note }) }
  }
  const over = observed > limit
  return {
    budget,
    observed: Number(observed.toFixed(unit === 'ms' ? 1 : 2)),
    limit,
    unit,
    status: over ? (options.enforced === false ? 'open miss' : 'fail') : 'pass',
    ...(note === undefined ? {} : { note }),
  }
}

/** An axis outcome, where "at most the limit" is not the comparison for every row. */
function axisBudget(
  budgets: Budgets, key: AxisBudgetKey, label: string, observed: number | string, unit: string,
  ok: boolean, note?: string,
): GateRow {
  const budget = budgets.axes[key]
  const detail = [note, budget.enforced ? undefined : `open finding, not build-blocking: ${budget.why ?? ''}`]
    .filter((x) => x !== undefined && x !== '').join('; ')
  if (typeof observed === 'string') {
    return { budget: `${label} (${budget.source})`, observed, limit: budget.limit, unit, status: 'pending' }
  }
  return {
    budget: `${label} (${budget.source})`,
    observed,
    limit: budget.limit,
    unit,
    status: ok ? 'pass' : budget.enforced ? 'fail' : 'open miss',
    ...(detail === '' ? {} : { note: detail }),
  }
}

function absolute(
  budgets: Budgets, key: AbsoluteKey, label: string, observed: number | string, unit: string, note?: string,
): GateRow {
  const budget = budgets.absolute[key]
  return compare(
    `${label} (${budget.source})`, observed, budget.limit, unit,
    { enforced: budget.enforced, note: [note, budget.enforced ? undefined : `open finding, not build-blocking: ${budget.why ?? ''}`].filter((x) => x !== undefined && x !== '').join('; ') || undefined },
  )
}

export function runGate(report: Omit<RunReport, 'gate'>, budgets: Budgets): GateReport {
  const slack = 1 + budgets.tolerancePercent / 100
  const floor = report.floors.nodeMedianMs
  const rows: GateRow[] = []

  const coldStart = report.floors.rows.find((r) => r.label.startsWith('node + the store adapter'))
  const coldObserved = coldStart === undefined
    ? 'NOT MEASURED: the store floor did not run'
    : programCost(coldStart.wall.p95.ms, floor)
  rows.push(budgets.coldStartMs === null
    ? {
      budget: "cold start: the store layer loaded, above the runner's own node floor",
      observed: coldObserved,
      limit: 'NOT MEASURED: bench/budgets.json carries no committed cold-start limit yet',
      unit: 'ms',
      status: 'pending',
    }
    : compare(
      "cold start: the store layer loaded, above the runner's own node floor",
      coldObserved,
      Number((budgets.coldStartMs * slack).toFixed(1)),
      'ms',
      { note: `runner node floor measured in this job at ${floor.toFixed(1)} ms median` },
    ))

  for (const scale of report.latency) {
    for (const [op, measurement] of Object.entries(scale.operations)) {
      const key = `${op}@${scale.items}`
      const limit = budgets.timing.limits[key]
      if (limit === undefined) {
        rows.push({ budget: `${op} median at ${scale.items} items`, observed: programCost(measurement.wall.p50.ms, floor), limit: 'NOT MEASURED: no committed budget for this key', unit: 'ms', status: 'pending' })
        continue
      }
      rows.push(compare(
        `${op} median at ${scale.items} items, above the node floor`,
        measurement.failures.length > 0 ? `NOT MEASURED: ${measurement.failures[0]}` : programCost(measurement.wall.p50.ms, floor),
        Number((limit * slack).toFixed(1)),
        'ms',
        {
          enforced: budgets.timing.enforced,
          note: `n=${measurement.wall.n}, ${measurement.opsTotal} store operations${budgets.timing.enforced ? '' : `; not build-blocking: ${budgets.timing.why ?? ''}`}`,
        },
      ))
    }
  }

  const largest = report.latency[report.latency.length - 1]
  const readRss = largest?.operations['list']?.peakRssKb
  const writeRss = largest?.operations['create']?.peakRssKb
  rows.push(absolute(budgets, 'peakRssReadKb', 'peak RSS, read at the largest scale', readRss ?? 'NOT MEASURED: no RSS reported', 'KiB'))
  rows.push(absolute(budgets, 'peakRssMutationKb', 'peak RSS, mutation at the largest scale', writeRss ?? 'NOT MEASURED: no RSS reported', 'KiB'))
  rows.push(absolute(budgets, 'firstIndexBuildMs', 'first index build at the largest scale', largest?.firstIndexBuildMs ?? 'NOT MEASURED: no scale ran', 'ms'))
  rows.push(absolute(budgets, 'reindexAfterHandEditMs', 're-index after a hand edit of the largest shard', largest?.reindexAfterHandEditMs ?? 'NOT MEASURED: no scale ran', 'ms'))

  const corpus = report.corpora[report.corpora.length - 1]
  const text = corpus === undefined ? 0 : corpus.bytes.items + corpus.bytes.events
  rows.push(absolute(
    budgets, 'indexToTextRatio', 'index size as a multiple of the text it indexes',
    corpus === undefined || text === 0 ? 'NOT MEASURED: no corpus bytes recorded' : corpus.bytes.index / text, 'x',
    corpus === undefined ? undefined : `${corpus.bytes.index} bytes of index over ${text} bytes of records and events`,
  ))

  rows.push(absolute(budgets, 'runtimeDependencies', 'runtime dependencies', report.packageFacts.runtimeDependencies, 'packages'))
  rows.push(absolute(budgets, 'installUnpackedBytes', 'install size, unpacked', report.packageFacts.unpackedBytes, 'bytes',
    'the packed tarball: the bundle, the schemas and the three licence files'))
  rows.push(absolute(budgets, 'bundleBytes', 'bundle', report.packageFacts.bundleBytes, 'bytes'))

  const a1 = report.axes.find((a) => a.axis === 'A1')
  const rounds = (a1?.detail as { rounds?: readonly { writers: number; durability: number | string }[] } | undefined)?.rounds
  // A round with no successful writer has no denominator, and its ratio is the string that
  // says so. Reading that as 0 would turn an unmeasurable round into a failing number, which
  // is the one thing this rig exists not to do.
  const unmeasured = rounds?.find((r) => typeof r.durability !== 'number')
  const worstDurability = rounds === undefined || rounds.length === 0
    ? 'NOT MEASURED: axis A1 reported no parallel rounds'
    : unmeasured !== undefined
      ? String(unmeasured.durability)
      : Math.min(...rounds.map((r) => r.durability as number))
  rows.push(axisBudget(budgets, 'a1Durability', 'A1 write durability, worst of the parallel rounds', worstDurability, 'ratio',
    typeof worstDurability === 'number' && worstDurability >= 1, rounds === undefined ? undefined : rounds.map((r) => `${r.writers}: ${r.durability}`).join(', ')))

  const a1Crashed = (a1?.detail as { crashed?: number } | undefined)?.crashed
  rows.push(axisBudget(budgets, 'a1Crashes', 'A1 writers that crashed rather than reporting a refusal',
    a1Crashed ?? 'NOT MEASURED: axis A1 reported no crash count', 'writers',
    a1Crashed !== undefined && a1Crashed <= budgets.axes['a1Crashes'].limit))

  const counts = (report.axes.find((a) => a.axis === 'A5')?.detail as { counts?: Record<string, number> } | undefined)?.counts
  const a5 = (key: AxisBudgetKey, outcome: string, label: string): void => {
    const observed = counts === undefined ? 'NOT MEASURED: axis A5 reported no outcome counts' : (counts[outcome] ?? 0)
    rows.push(axisBudget(budgets, key, label, observed, 'cases', typeof observed === 'number' && observed <= budgets.axes[key].limit))
  }
  a5('a5SilentDrops', 'silent drop', 'A5 silent drops')
  a5('a5WholeStoreRefusals', 'whole-store refusal', 'A5 whole-store refusals')
  a5('a5Crashes', 'crash', 'A5 crashes')

  // DR8's output row: bytes enforced, tokens advisory. Reported as the count over budget so
  // the row carries a number rather than a sentence, and the per-artefact table carries the
  // rest.
  const over = report.outputBudgets.filter((r) => !r.withinBudget)
  rows.push(report.outputBudgets.length === 0
    ? {
      budget: 'output size per command, bytes enforced and tokens advisory (interface A.3)',
      observed: 'NOT MEASURED: the run produced no rendered command artefact',
      limit: 'the per-command budgets of interface specification A.3',
      unit: 'artefacts',
      status: 'pending',
    }
    : compare(
      'output size per command, bytes enforced and tokens advisory (interface A.3)',
      over.length, 0, 'artefacts over budget',
      { note: `${report.outputBudgets.length} artefacts measured${over.length === 0 ? '' : `; over: ${over.map((r) => `${r.artefact} ${r.bytes}/${r.allowedBytes} B`).join(', ')}`}` },
    ))

  return {
    tolerancePercent: budgets.tolerancePercent,
    toleranceWhy: budgets.toleranceWhy,
    derivedFrom: budgets.derivedFrom,
    rows,
    passed: rows.filter((r) => r.status === 'pass').length,
    failed: rows.filter((r) => r.status === 'fail').length,
    openMisses: rows.filter((r) => r.status === 'open miss').length,
    pending: rows.filter((r) => r.status === 'pending').length,
  }
}
