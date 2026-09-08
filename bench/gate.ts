// SPDX-License-Identifier: Apache-2.0
// DR8's regression gate.
//
// A CI runner is not this laptop, so every row here is one that transfers between machines:
// the axis outcomes, the package facts (dependency count, install size, bundle size), and two
// ratios that price `doctor` and `next` against the workspace read taken in the same job. A
// ratio of two figures from one runner survives the move to another where a millisecond count
// does not.
//
// The cold-start row is checked as PROGRAM COST: the store-loading floor's median wall time
// minus the runner's own `node -e` median, measured in the same job. That subtraction removes
// what the machine charges to start a process and leaves what our code charges.
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
  /** Axis outcomes that transfer across machines, so they have teeth on any runner. */
  readonly axes: Readonly<Record<AxisBudgetKey, AbsoluteBudget>>
  readonly absolute: Readonly<Record<AbsoluteKey, AbsoluteBudget>>
}

export const AXIS_BUDGET_KEYS = [
  'a1Durability', 'a1Crashes', 'a5SilentDrops', 'a5WholeStoreRefusals', 'a5Crashes',
] as const
export type AxisBudgetKey = (typeof AXIS_BUDGET_KEYS)[number]

export const ABSOLUTE_KEYS = [
  'doctorRssOverWorkspace', 'nextCostOverWorkspace',
  'runtimeDependencies', 'installUnpackedBytes', 'bundleBytes',
] as const
export type AbsoluteKey = (typeof ABSOLUTE_KEYS)[number]

/** `why` carries what closed the budget or what it is watching, where the number alone does
 *  not say it. Every budget in this file is armed: a row that fails, fails the build. */
export type AbsoluteBudget = {
  readonly limit: number
  readonly source: string
  readonly why?: string
}

export type GateStatus = 'pass' | 'fail' | 'pending'

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
  options: { readonly note?: string } = {},
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
    status: over ? 'fail' : 'pass',
    ...(note === undefined ? {} : { note }),
  }
}

/** An axis outcome, where "at most the limit" is not the comparison for every row. */
function axisBudget(
  budgets: Budgets, key: AxisBudgetKey, label: string, observed: number | string, unit: string,
  ok: boolean, note?: string,
): GateRow {
  const budget = budgets.axes[key]
  if (typeof observed === 'string') {
    return { budget: `${label} (${budget.source})`, observed, limit: budget.limit, unit, status: 'pending' }
  }
  return {
    budget: `${label} (${budget.source})`,
    observed,
    limit: budget.limit,
    unit,
    status: ok ? 'pass' : 'fail',
    ...(note === undefined ? {} : { note }),
  }
}

function absolute(
  budgets: Budgets, key: AbsoluteKey, label: string, observed: number | string, unit: string, note?: string,
): GateRow {
  const budget = budgets.absolute[key]
  return compare(`${label} (${budget.source})`, observed, budget.limit, unit, note === undefined ? {} : { note })
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

  const largest = report.latency[report.latency.length - 1]
  // Two commands over the read every command performs, priced against that read in the same
  // job. A ratio of two figures taken on one runner survives the move to another where a
  // millisecond count does not, which is why these two can be armed: `doctor` held the whole
  // store at 6.2x the workspace read's peak and `next` ranked at 3.8x its cost, and no row
  // was watching either shape because each was measured as an absolute wall time on a
  // machine the budget did not name.
  const workspaceRss = largest?.operations['workspace']?.peakRssKb
  const doctorRss = largest?.operations['doctor']?.peakRssKb
  rows.push(absolute(budgets, 'doctorRssOverWorkspace', 'peak RSS of doctor over the workspace read at the largest scale',
    workspaceRss === undefined || doctorRss === undefined || workspaceRss === 0
      ? 'NOT MEASURED: doctor or workspace reported no RSS at the largest scale'
      : doctorRss / workspaceRss,
    'x', workspaceRss === undefined || doctorRss === undefined ? undefined : `${doctorRss} KiB over ${workspaceRss} KiB at ${largest?.items} items`))
  const workspaceCost = largest?.operations['workspace'] === undefined ? undefined : programCost(largest.operations['workspace'].wall.p50.ms, floor)
  const nextCost = largest?.operations['next'] === undefined ? undefined : programCost(largest.operations['next'].wall.p50.ms, floor)
  rows.push(absolute(budgets, 'nextCostOverWorkspace', 'program cost of next over the workspace read at the largest scale',
    workspaceCost === undefined || nextCost === undefined || workspaceCost === 0
      ? 'NOT MEASURED: next or workspace reported no median at the largest scale'
      : nextCost / workspaceCost,
    'x', workspaceCost === undefined || nextCost === undefined ? undefined : `${nextCost.toFixed(1)} ms over ${workspaceCost.toFixed(1)} ms at ${largest?.items} items, both above the node floor`))

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
    pending: rows.filter((r) => r.status === 'pending').length,
  }
}
