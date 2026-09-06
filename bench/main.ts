// SPDX-License-Identifier: Apache-2.0
// `npm run bench`. Reads bench/bench.config.json, generates the corpora through the store,
// measures what can be measured today and writes both renderings of the run.
//
// Order matters and is not incidental: the floors run first so every later figure has
// something to subtract, corpora are generated before anything is timed, and the axis that
// deletes the index runs last within its scale.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runA1 } from './axes/a1-durability.ts'
import { runA2 } from './axes/a2-questions.ts'
import { runA4 } from './axes/a4-latency.ts'
import { runA3 } from './axes/a3-output.ts'
import { runA5 } from './axes/a5-robustness.ts'
import { runA6 } from './axes/a6-mis-target.ts'
import { runA7 } from './axes/a7-audit.ts'
import { runA8 } from './axes/a8-lifecycle.ts'
import { runA10 } from './axes/a10-validation.ts'
import { runA12 } from './axes/a12-contract.ts'
import { remainingAxes } from './axes/remaining.ts'
import type { AxisResult } from './axes/axis.ts'
import { loadConfig, samplesFor, type BenchConfig } from './config.ts'
import { buildCorpus, type Corpus } from './corpus.ts'
import { measureFloors } from './floors.ts'
import { loadBudgets, programCost, runGate, ABSOLUTE_KEYS, AXIS_BUDGET_KEYS, type Budgets } from './gate.ts'
import { peakLoad, sampleLoad } from './load.ts'
import { describeMachine } from './machine.ts'
import { packageFacts } from './package-facts.ts'
import { toMarkdown, tokenizerFacts, type RunReport } from './report.ts'
import { account, loadTokenizers } from './tokens.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type Flags = {
  readonly out: string
  readonly reuseCorpus: boolean
  readonly writeBudgets: boolean
  readonly gate: boolean
  readonly scales?: readonly number[]
  readonly samples?: number
}

function parseFlags(argv: readonly string[]): Flags {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at < 0 ? undefined : argv[at + 1]
  }
  const scales = value('--scales')
  const samples = value('--samples')
  return {
    out: value('--out') ?? path.join(ROOT, 'bench', 'results'),
    reuseCorpus: argv.includes('--reuse-corpus'),
    writeBudgets: argv.includes('--write-budgets'),
    gate: argv.includes('--gate'),
    ...(scales === undefined ? {} : { scales: scales.split(',').map(Number) }),
    ...(samples === undefined ? {} : { samples: Number(samples) }),
  }
}

/** Artefacts the store really produces today, so the accounting instrument is exercised on
 *  bytes this product wrote rather than on a sample string. The per-command budgets of
 *  interface section A.3 are a different artefact and stay NOT MEASURED under axis A3. */
async function accountArtefacts(corpus: Corpus): Promise<readonly { label: string; text: string }[]> {
  const shard = await readFile(path.join(corpus.root, 'items', `${corpus.largestMonth}.md`), 'utf8')
  const events = await readFile(path.join(corpus.root, 'events', `${corpus.largestMonth}.jsonl`), 'utf8')
  const records = shard.split(/\n(?=# )/)
  return [
    { label: 'one stored record, rendered by the grammar', text: records[1] ?? records[0] ?? '' },
    { label: 'nine stored records, the shape of the reference fixture', text: records.slice(1, 10).join('\n') },
    { label: 'one event-log line', text: events.split('\n')[0] ?? '' },
    { label: 'ten event-log lines, dense identifiers and instants', text: events.split('\n').slice(0, 10).join('\n') },
  ]
}

function deriveBudgets(report: Omit<RunReport, 'gate'>, previous: Budgets): Budgets {
  const floor = report.floors.nodeMedianMs
  const timing: Record<string, number> = {}
  for (const scale of report.latency) {
    for (const [op, m] of Object.entries(scale.operations)) {
      timing[`${op}@${scale.items}`] = Number(programCost(m.wall.p50.ms, floor).toFixed(1))
    }
  }
  const coldStart = report.floors.rows.find((r) => r.label.startsWith('node + the store adapter'))
  return {
    tolerancePercent: previous.tolerancePercent,
    toleranceWhy: previous.toleranceWhy,
    derivedFrom: {
      runId: report.runId,
      date: report.startedAt.slice(0, 10),
      machine: `${report.machine.cpuModel}, ${report.machine.cores} cores, ${report.machine.platform} ${report.machine.release}`,
      node: report.machine.node,
      note: 'timing limits are program cost at the median: the operation wall median minus the runner\'s own node floor median, measured in the same job',
    },
    coldStartMs: coldStart === undefined ? previous.coldStartMs : Number(programCost(coldStart.wall.p50.ms, floor).toFixed(1)),
    timing: { ...previous.timing, limits: timing },
    axes: Object.fromEntries(AXIS_BUDGET_KEYS.map((k) => [k, previous.axes[k]])) as Budgets['axes'],
    absolute: Object.fromEntries(ABSOLUTE_KEYS.map((k) => [k, previous.absolute[k]])) as Budgets['absolute'],
  }
}

/**
 * A record id is a slug: lowercase letters, digits and hyphens. The run id is an ISO instant
 * and ends in an uppercase `Z`, which the field dictionary refuses, so it is folded here
 * rather than at the call site where the constraint is invisible.
 */
function runToken(runId: string): string {
  return runId.slice(11).replace(/[^0-9a-z]/gi, '').toLowerCase()
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const base = loadConfig(ROOT)
  const config: BenchConfig = {
    ...base,
    ...(flags.scales === undefined ? {} : { scales: flags.scales }),
    ...(flags.samples === undefined ? {} : { samples: { default: flags.samples } }),
  }
  const startedAt = new Date()
  const loadAtStart = sampleLoad()
  const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}`
  const started = performance.now()

  const say = (line: string): void => { process.stderr.write(`${line}\n`) }

  // Every axis carries the load either side of it, for the same reason every measurement
  // does: this machine is shared, and a figure without the machine's state beside it cannot
  // be judged.
  const withLoad = async (run: () => Promise<AxisResult>): Promise<AxisResult> => {
    const before = sampleLoad()
    const axis = await run()
    const after = sampleLoad()
    return { ...axis, load: { before, after, peak1m: peakLoad(before, after) } }
  }

  const machine = describeMachine('24.15.0')

  await mkdir(config.corpusDir, { recursive: true })
  const corpora: Corpus[] = []
  for (const items of config.scales) {
    say(`bench: corpus of ${items} items`)
    corpora.push(await buildCorpus(config.corpusDir, {
      items,
      eventsPerItem: config.eventsPerItem,
      months: config.months,
      seed: config.seed,
      lastMonth: config.lastMonth,
      relationsPerHundredItems: config.relationsPerHundredItems,
      impedimentsPerHundredItems: config.impedimentsPerHundredItems,
    }, flags.reuseCorpus))
  }

  // Floors AFTER the corpora and immediately before the operations they are subtracted from,
  // so both are measured in the same conditions. Generating the four corpora writes about
  // 430 MB, and a floor taken on an idle machine before that write against operations timed
  // while it is still draining puts the whole of the writeback into program cost: measured
  // 2026-09-05, that ordering opened six small-scale timing rows by up to 58% while the 50k
  // rows, which run once the flush has drained, sat on their nine-run medians.
  say(`bench ${runId}: floors, ${config.floorSamples} samples each`)
  const floors = measureFloors(config.floorSamples)

  say('bench: A4, latency at scale')
  const a4 = await runA4(corpora, (items) => samplesFor(config, items), floors.spawnMedianMs)

  const a1Corpus = corpora.find((c) => c.spec.items === config.a5.corpusScale) ?? corpora[0] as Corpus
  say(`bench: A1, ${config.a1WriterCounts.join('/')} parallel writers`)
  const a1 = await withLoad(() => runA1(a1Corpus, config.a1WriterCounts, runToken(runId)))

  say(`bench: A5, ${config.a5.randomEdits} random line edits plus the shaped cases`)
  const a5 = await withLoad(() => runA5(a1Corpus, config.corpusDir, config.a5.randomEdits, config.seed))

  say('bench: A6, mis-target across the three scenarios at the command surface')
  const a6 = await withLoad(async () => (await runA6(a1Corpus)).axis)

  // The five surface axes run after the store axes and before the token accounting, because
  // each builds and tears down its own workspace and none of them touches a corpus.
  say('bench: A2, the 25 questions put to the command surface')
  const a2 = await withLoad(async () => (await runA2()).axis)

  say('bench: A7, 50 items through 200 random legal transitions')
  const a7 = await withLoad(async () => (await runA7(config.seed)).axis)

  say('bench: A8, every ordered state pair at the command surface')
  const a8 = await withLoad(async () => (await runA8()).axis)

  say('bench: A10, one invalid creation per rule at the command surface')
  const a10 = await withLoad(async () => (await runA10()).axis)

  say('bench: A12, every verb on both paths against the shipped schemas')
  const a12 = await withLoad(async () => (await runA12()).axis)

  const loaded = loadTokenizers()
  const artefacts = await accountArtefacts(a1Corpus)
  const accounting = artefacts.map((a) => account(a.label, a.text, loaded))

  say('bench: A3, output bytes and tokens over the golden command results')
  const a3 = await runA3(loaded)

  const axes: AxisResult[] = [a1, a2, a3.axis, a4.axis, a5, a6, a7, a8, a10, a12, ...remainingAxes()]
    .sort((a, b) => Number(a.axis.slice(1)) - Number(b.axis.slice(1)))

  const committed = loadBudgets(ROOT)
  const finished = new Date()
  const skeleton = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.round(performance.now() - started),
    machine,
    machineState: { atStart: loadAtStart, atEnd: sampleLoad() },
    config,
    floors,
    corpora,
    latency: a4.rows,
    packageFacts: packageFacts(ROOT),
    tokenizers: tokenizerFacts(loaded),
    accounting,
    outputBudgets: a3.rows,
    axes,
  }
  // With --write-budgets the limits come from this run, so the gate is reported against the
  // budgets it just established rather than against the stale ones it is replacing. Every
  // timing row then reads as a pass by construction, which is what establishing a baseline
  // is; the derivedFrom block in budgets.json says which run it was.
  const budgets = flags.writeBudgets ? deriveBudgets(skeleton, committed) : committed
  const report: RunReport = { ...skeleton, gate: runGate(skeleton, budgets) }

  await mkdir(flags.out, { recursive: true })
  await writeFile(path.join(flags.out, 'bench.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(flags.out, 'bench.md'), `${toMarkdown(report)}\n`)
  say(`bench: wrote ${path.join(flags.out, 'bench.json')} and bench.md`)

  if (flags.writeBudgets) {
    await writeFile(path.join(ROOT, 'bench', 'budgets.json'), `${JSON.stringify(budgets, null, 2)}\n`)
    say('bench: rewrote bench/budgets.json from this run')
  }

  const g = report.gate
  say(`bench: ${g.rows.length} budgets, ${g.passed} pass, ${g.failed} fail, ${g.openMisses} open miss, ${g.pending} pending`)
  for (const row of g.rows) {
    if (row.status === 'fail' || row.status === 'open miss') say(`  ${row.status.toUpperCase()}: ${row.budget} = ${row.observed} ${row.unit}, limit ${row.limit}`)
  }
  for (const axis of report.axes) {
    say(`  ${axis.axis} ${axis.verdict}: ${axis.observed}`)
  }
  if (flags.gate && g.failed > 0) process.exitCode = 1
}

await main()
