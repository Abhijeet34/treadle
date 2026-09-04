// SPDX-License-Identifier: Apache-2.0
// Axis A1: persisted writes divided by writes that reported success, under N parallel
// callers from separate processes.
//
// The writers are real processes because that is what the guarantee is about; an in-process
// promise race shares one lock object and proves nothing about a lock file. Persistence is
// counted by reading the store back, never by trusting what a writer printed, which is the
// distinction the axis is built on.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ShardedStore } from '../../src/adapters/store/index.ts'
import type { Corpus } from '../corpus.ts'
import type { AxisResult } from './axis.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WRITER = path.join(HERE, '..', 'children', 'writer.ts')

type WriterOutcome = {
  readonly id: string
  readonly reported: 'ok' | 'refused' | 'crashed'
  readonly code?: string
  readonly ms?: number
}

function runWriter(root: string, id: string, month: string): Promise<WriterOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRITER, root, id, month], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('close', (status) => {
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
      if (line === undefined) {
        resolve({ id, reported: 'crashed', code: `exit ${status}: ${err.trim().slice(0, 200)}` })
        return
      }
      resolve(JSON.parse(line) as WriterOutcome)
    })
  })
}

export type ParallelRound = {
  readonly writers: number
  readonly reportedOk: number
  readonly reportedRefused: number
  readonly crashed: number
  readonly persisted: number
  /** The axis metric: persisted over reported ok. `1` is the target. */
  readonly durability: number | string
  readonly wallMs: number
  readonly maxWriterMs: number
  readonly refusalCodes: readonly string[]
  readonly lockFileLeft: boolean
  readonly tempFilesLeft: number
  readonly findings: number
}

export async function runA1(corpus: Corpus, writerCounts: readonly number[]): Promise<AxisResult> {
  const rounds: ParallelRound[] = []
  let operations = 0

  for (const n of writerCounts) {
    const ids = Array.from({ length: n }, (_, i) => `a1-${n}-${String(i).padStart(4, '0')}`)
    const started = performance.now()
    const outcomes = await Promise.all(ids.map((id) => runWriter(corpus.root, id, corpus.largestMonth)))
    const wallMs = performance.now() - started
    operations += n

    // Persistence is established by reading the files back through a fresh store, which is
    // the only evidence the axis accepts.
    const store = new ShardedStore(corpus.root)
    let persisted = 0
    for (const id of ids) {
      const found = await store.get(id)
      if (found.ok && found.value !== undefined) persisted += 1
    }
    const findings = await store.findings()
    await store.close()

    const reportedOk = outcomes.filter((o) => o.reported === 'ok').length
    const refusals = [...new Set(outcomes.filter((o) => o.reported !== 'ok').map((o) => o.code ?? o.reported))]
    const temps = existsSync(path.join(corpus.root, 'items'))
      ? readdirSync(path.join(corpus.root, 'items')).filter((f) => f.includes('.tmp.')).length
      : 0

    rounds.push({
      writers: n,
      reportedOk,
      reportedRefused: outcomes.filter((o) => o.reported === 'refused').length,
      crashed: outcomes.filter((o) => o.reported === 'crashed').length,
      persisted,
      durability: reportedOk === 0 ? 'NOT MEASURED: no writer reported success, so the ratio has no denominator' : persisted / reportedOk,
      wallMs: Math.round(wallMs),
      maxWriterMs: Math.max(...outcomes.map((o) => o.ms ?? 0)),
      refusalCodes: refusals as readonly string[],
      lockFileLeft: existsSync(path.join(corpus.root, '.lock')),
      tempFilesLeft: temps,
      findings: findings.ok ? findings.value.length : -1,
    })
  }

  const allPerfect = rounds.every((r) => r.durability === 1)
  const worst = rounds.find((r) => r.durability !== 1)

  return {
    axis: 'A1',
    name: 'Write durability',
    metric: 'persisted writes divided by writes that reported success, under N parallel callers',
    corpus: `store of ${corpus.itemsInStore} items, ${corpus.months.length} shards`,
    method: `N in {${writerCounts.join(', ')}} parallel creates from separate processes; persistence counted by reading the store`,
    reference: '100% at 5, 24, 60 on both builds (prior-art E1); 200 not run',
    target: '100% at every N, and zero silent mis-targets under the A6 scenarios',
    verdict: allPerfect ? 'MET' : 'MISSED',
    observed: allPerfect
      ? `${rounds.map((r) => `${r.writers}: ${r.persisted}/${r.reportedOk}`).join(', ')}; every reported write is on disk, zero refusals, zero lock or temp files left`
      : `${worst?.writers} writers: ${worst?.persisted} persisted of ${worst?.reportedOk} reported ok`,
    operations,
    samples: writerCounts.length,
    detail: { rounds, misTargetScenarios: 'NOT MEASURED: the A6 scenarios resolve a store from a working directory, which is the command layer' },
    blockedOn: 'the mis-target half of this target is axis A6, which resolves a store from a working directory and needs the command layer',
  }
}
