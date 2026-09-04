// SPDX-License-Identifier: Apache-2.0
// Axis A3: what a command's output costs, in bytes and in tokens.
//
// The command layer landed while this rig was being built, so the artefacts this axis needs
// now exist: the golden result objects and the line renderer that produces what an agent
// reads. Nothing here re-implements either.
//
// `test/cli/budget.test.ts` already gates the byte budgets, which is where a budget belongs.
// What it cannot do is tokens: its own header records that the token figures were taken
// "outside this tree", because the repository has zero runtime dependencies and a tokenizer
// is a package. This rig carries all three tokenizers as development dependencies, so the
// token half of DR8's output budget is measured here rather than by hand.

import { agentRenderer } from '../../src/adapters/render/agent.ts'
import type { ResultObject } from '../../src/application/result.ts'
import { goldenResults } from '../../test/helpers/cli-fixtures.ts'
import { account, type Accounting, type TokenizerLoad } from '../tokens.ts'
import type { AxisResult } from './axis.ts'

/**
 * Interface specification A.3, and the reference's own byte counts for the four artefacts
 * the prior-art axes table measured. The reference figures are quoted from that table and
 * are never re-derived; the reference is not in this tree.
 *
 * Duplicated from `test/cli/budget.test.ts`, which owns the same numbers for the byte gate.
 * Simplified: two copies of a twelve-row table, and they should collapse into one exported
 * constant once the command layer's branch is quiet enough to touch.
 */
const A3: readonly { readonly name: string; readonly budget: number; readonly reference?: number }[] = [
  { name: 'status', budget: 1070, reference: 1441 },
  { name: 'backlog', budget: 960, reference: 1781 },
  { name: 'backlog-empty', budget: 140 },
  { name: 'show', budget: 310, reference: 322 },
  { name: 'next', budget: 510, reference: 659 },
  { name: 'explain', budget: 750 },
  { name: 'transition', budget: 230 },
  { name: 'transition-already', budget: 110 },
  { name: 'transition-dry-run', budget: 250 },
  { name: 'transition-preview', budget: 250 },
  { name: 'not-found', budget: 160 },
  { name: 'guard-refused', budget: 270 },
]

/** A.3's budgets were stated against a three-character binary name; ours is four longer. */
const NAME_COST = 'treadle'.length - 'wmx'.length

export type OutputRow = Accounting & {
  readonly artefact: string
  readonly budgetBytes: number
  readonly nameOccurrences: number
  readonly allowedBytes: number
  readonly withinBudget: boolean
  readonly referenceBytes: number | string
  readonly againstReference: string
}

export async function runA3(loaded: readonly TokenizerLoad[]): Promise<{
  readonly axis: AxisResult
  readonly rows: readonly OutputRow[]
}> {
  const golden = await goldenResults()
  const rows: OutputRow[] = []

  for (const spec of A3) {
    const result = golden.get(spec.name)
    if (result === undefined) {
      throw new Error(`the command layer produced no golden result named ${spec.name}`)
    }
    const text = agentRenderer.render(result as ResultObject)
    const counted = account(spec.name, text, loaded)
    const occurrences = (text.match(/\btreadle\b/g) ?? []).length
    const allowed = spec.budget + occurrences * NAME_COST
    rows.push({
      ...counted,
      artefact: spec.name,
      budgetBytes: spec.budget,
      nameOccurrences: occurrences,
      allowedBytes: allowed,
      withinBudget: counted.bytes <= allowed,
      referenceBytes: spec.reference ?? 'NOT MEASURED: the prior-art axes table carries no byte count for this artefact',
      againstReference: spec.reference === undefined
        ? 'no reference figure'
        : `${counted.bytes} B against ${spec.reference} B, ${(counted.bytes / spec.reference).toFixed(2)}x`,
    })
  }

  const overBudget = rows.filter((r) => !r.withinBudget)
  const compared = rows.filter((r) => typeof r.referenceBytes === 'number')
  const overReference = compared.filter((r) => r.bytes > (r.referenceBytes as number))
  const met = overBudget.length === 0 && overReference.length === 0

  return {
    rows,
    axis: {
      axis: 'A3',
      name: 'Token cost',
      metric: 'bytes of output for dashboard, list of 9, single item, ready list',
      corpus: `${rows.length} golden result objects rendered by the line renderer, ${compared.length} of them with a reference figure`,
      method: 'byte count of the rendered artefact, plus a token count from each of three tokenizers, reported per tokenizer and never averaged',
      reference: '1441, 1781, 322, 659 bytes (prior-art E10)',
      target: 'at most the same bytes for the same information, every extra byte attributable to a field the reference lacks',
      verdict: met ? 'MET' : 'MISSED',
      observed: met
        ? `${compared.map((r) => `${r.artefact} ${r.bytes} B against ${r.referenceBytes} B`).join(', ')}; all ${rows.length} artefacts inside their A.3 budget`
        : `${overReference.length} of ${compared.length} over the reference, ${overBudget.length} of ${rows.length} over the A.3 budget`,
      operations: rows.length,
      samples: rows.length,
      detail: {
        rows,
        note: 'bytes are the gate and tokens are advisory, per DR8; the ratio column is where a byte budget alone mis-prices output',
      },
    },
  }
}
