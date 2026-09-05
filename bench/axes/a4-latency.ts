// SPDX-License-Identifier: Apache-2.0
// Axis A4: wall time of read, create and transition at 100, 1k, 10k and 50k items.
//
// Every sample is a cold process, because the figure the axis is about is what an agent pays
// per invocation and a warm loop measures neither V8 nor the index handle honestly. The
// spawn floor is measured with the same launcher and subtracted, so the net column is the
// program's cost rather than the shell's.
//
// These are store operations, not commands: the command layer does not exist yet. The rows
// keep the shape the command rows will have, and the label says which they are.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dropIndex, type Corpus } from '../corpus.ts'
import { launchOnce, measure, type Measurement } from '../timing.ts'
import type { AxisResult } from './axis.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OP = path.join(HERE, '..', 'children', 'op.ts')

export type ScaleRow = {
  readonly items: number
  readonly shards: number
  readonly largestShardRecords: number
  readonly readyMatches: number
  readonly operations: Readonly<Record<string, Measurement>>
  /** DR8 row: the cost of the first command on a fresh clone, index absent. */
  readonly firstIndexBuildMs: number | string
  /** DR8 row: re-index after a hand edit of the largest shard. */
  readonly reindexAfterHandEditMs: number | string
}

const READ_OPS = ['identity', 'get', 'list'] as const
const WRITE_OPS = ['create', 'transition'] as const

export async function runA4(
  corpora: readonly Corpus[],
  samplesFor: (items: number) => number,
  floorMedianMs: number,
): Promise<{ readonly axis: AxisResult; readonly rows: readonly ScaleRow[] }> {
  const rows: ScaleRow[] = []
  let operations = 0
  let samples = 0

  for (const corpus of corpora) {
    const n = samplesFor(corpus.spec.items)
    const operationsHere: Record<string, Measurement> = {}

    for (const op of READ_OPS) {
      const argument = op === 'get' ? corpus.probeIds.get : op === 'list' ? 'ready' : ''
      const m = measure(process.execPath, [OP, corpus.root, op, argument], {
        samples: n,
        label: `${op} @ ${corpus.spec.items}`,
        floorMedianMs,
      })
      operationsHere[op] = m
      operations += m.opsTotal
      samples += m.wall.n
    }
    for (const op of WRITE_OPS) {
      const argument = op === 'create' ? corpus.largestMonth : corpus.probeIds.transition
      const m = measure(process.execPath, [OP, corpus.root, op, argument], {
        samples: n,
        label: `${op} @ ${corpus.spec.items}`,
        floorMedianMs,
      })
      operationsHere[op] = m
      operations += m.opsTotal
      samples += m.wall.n
    }

    const reindex = await reindexAfterHandEdit(corpus)
    rows.push({
      items: corpus.itemsInStore,
      shards: corpus.months.length,
      largestShardRecords: corpus.largestMonthItems,
      readyMatches: corpus.readyMatches,
      operations: operationsHere,
      // Order matters: the hand edit is priced against a warm index, and dropping the index
      // for the first-build figure has to come after everything that needs a warm one.
      reindexAfterHandEditMs: reindex,
      firstIndexBuildMs: await firstIndexBuild(corpus),
    })
  }

  const largest = rows[rows.length - 1]
  const readP95 = largest?.operations['get']?.inProcess?.p95.ms
  const createP95 = largest?.operations['create']?.inProcess?.p95.ms
  const met = readP95 !== undefined && createP95 !== undefined && readP95 < 150 && createP95 < 150

  return {
    rows,
    axis: {
      axis: 'A4',
      name: 'Latency at scale',
      metric: 'wall time of read, create and transition at 100, 1k, 10k and 50k items',
      corpus: rows.map((r) => `${r.items} items in ${r.shards} shards`).join('; '),
      method: `best of N cold processes per operation, first launch reported separately, spawn floor of ${floorMedianMs.toFixed(2)} ms subtracted for the net column`,
      reference: '89/90 ms at 100, 154/141 ms at 5k, startup 83 ms (prior-art E11)',
      target: 'below 150 ms at 50k for read and create, startup excluded and reported separately',
      verdict: met ? 'MET' : readP95 === undefined || createP95 === undefined ? 'NOT MEASURED' : 'MISSED',
      observed: readP95 === undefined || createP95 === undefined
        ? 'NOT MEASURED: the largest corpus produced no in-process figure'
        : `at ${largest?.items} items, startup excluded: read p95 ${readP95.toFixed(1)} ms, create p95 ${createP95.toFixed(1)} ms`,
      operations,
      samples,
      detail: { note: 'store operations run from TypeScript source under Node type stripping, not the bundle DR1 specifies; see the floors table for the gap' },
    },
  }
}

/** DR8: the first command on a fresh clone pays the whole index build, once. */
async function firstIndexBuild(corpus: Corpus): Promise<number | string> {
  await dropIndex(corpus.root)
  const sample = launchOnce(process.execPath, [OP, corpus.root, 'list', 'ready'], { samples: 1 })
  if (sample.failure !== undefined) return `NOT MEASURED: ${sample.failure}`
  return Math.round(sample.report?.inProcessMs ?? -1)
}

/**
 * DR8: a hand edit of the largest shard re-indexes that one file on the next command. The
 * edit changes one title character, which is what a person doing it in an editor would do.
 */
async function reindexAfterHandEdit(corpus: Corpus): Promise<number | string> {
  const file = path.join(corpus.root, 'items', `${corpus.largestMonth}.md`)
  const text = await readFile(file, 'utf8')
  const at = text.lastIndexOf('\n# ')
  if (at < 0) return 'NOT MEASURED: the largest shard carries no record heading to edit'
  const lineEnd = text.indexOf('\n', at + 1)
  await writeFile(file, `${text.slice(0, lineEnd)} (hand edited)${text.slice(lineEnd)}`)
  const sample = launchOnce(process.execPath, [OP, corpus.root, 'get', corpus.probeIds.get], { samples: 1 })
  if (sample.failure !== undefined) return `NOT MEASURED: ${sample.failure}`
  return Number((sample.report?.inProcessMs ?? -1).toFixed(1))
}
