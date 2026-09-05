// SPDX-License-Identifier: Apache-2.0
// Axis A8: every ordered pair of states attempted at the command surface, with the printed
// rule id read back.
//
// `test/domain/state-machine.test.ts` already exercises the rule table. What it cannot say
// is whether the surface enforces it: the reference's failure was that every pair was
// accepted by a command, not that its table was wrong. So each pair gets its own item,
// driven to the `from` state by real transitions, and one attempt at the `to` state.
//
// The oracle is `TRANSITION_TABLE` itself, which is the table the surface has to enforce.
// `resume` is the one edge whose legality depends on the item rather than on the pair, so
// the predicate below resolves it against `held_from` exactly as `specFor` does.

import { TRANSITION_TABLE, WORK_ITEM_STATES, type WorkItemState } from '../../src/domain/index.ts'
import { crossCheck, dataOf, openSurface, resultOf, type CrossCheck, type Invocation } from './surface.ts'
import type { AxisResult } from './axis.ts'

/** The rule ids a refusal on this axis may name: the transition rules and the guards. */
const RULE_IDS = new Set([
  'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7',
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8',
])

/** A held item restores the state it was held from, and every seed here is held from draft. */
const HELD_FROM: WorkItemState = 'draft'

function legalEdge(from: WorkItemState, to: WorkItemState): boolean {
  return TRANSITION_TABLE.some((spec) =>
    spec.from === from && spec.to === to && (spec.name !== 'resume' || to === HELD_FROM))
}

type Seed = { readonly type: 'task' | 'story'; readonly path: readonly WorkItemState[] }

/**
 * How each state is reached at the surface. A task has no review step, so `in_progress`
 * exits through `done`; a story has one, so it is the only type that can sit in `in_review`.
 * Neither choice is free: it is guard G5 deciding which type can stand in which state, and
 * the type used is reported on every row.
 */
const SEED_OF: Readonly<Record<WorkItemState, Seed>> = {
  draft: { type: 'task', path: [] },
  ready: { type: 'task', path: ['ready'] },
  in_progress: { type: 'task', path: ['ready', 'in_progress'] },
  in_review: { type: 'story', path: ['ready', 'in_progress', 'in_review'] },
  done: { type: 'task', path: ['ready', 'in_progress', 'done'] },
  on_hold: { type: 'task', path: ['on_hold'] },
  cancelled: { type: 'task', path: ['cancelled'] },
}

function argsFor(id: string, to: WorkItemState): readonly string[] {
  const base = ['transition', id, to, '--reason', 'axis a8 attempt']
  return to === 'cancelled' ? [...base, '--resolution', 'wont_do'] : base
}

export type PairRow = {
  readonly from: WorkItemState
  readonly to: WorkItemState
  readonly type: string
  readonly item: string
  readonly expected: 'legal' | 'illegal' | 'idempotent'
  readonly exit: number
  readonly code: string
  readonly rule: string
  readonly guard: string
  readonly outcome: 'allowed' | 'already' | 'refused'
  readonly namesRule: boolean
  readonly asExpected: boolean
}

export async function runA8(): Promise<{ readonly axis: AxisResult; readonly rows: readonly PairRow[] }> {
  const surface = await openSurface('a8')
  const rows: PairRow[] = []
  let crossChecked: CrossCheck | undefined

  try {
    let n = 0
    for (const from of WORK_ITEM_STATES) {
      for (const to of WORK_ITEM_STATES) {
        n += 1
        const seed = SEED_OF[from]
        const id = `pair-${n}-${from}-${to}`.replace(/_/g, '-')
        const filed = await surface.run([
          'file', seed.type, `Pair ${n}: ${from} to ${to}`, '--id', id,
          '--points', '3', '--priority', '3',
          ...(seed.type === 'story' ? ['--set', 'acceptance_criteria=the pair was attempted'] : []),
          '--out', 'json',
        ])
        if (filed.code !== 0) throw new Error(`${id}: file refused: ${filed.err}`)

        for (const step of seed.path) {
          const moved = await surface.run(argsFor(id, step))
          if (moved.code !== 0) throw new Error(`${id}: could not reach ${step}: ${moved.err}`)
        }

        const attempt = await surface.run([...argsFor(id, to), '--out', 'json'])
        rows.push(scorePair(from, to, seed.type, id, attempt))
        if (crossChecked === undefined && from === 'draft' && to === 'done') {
          // A read is the only invocation that can be run twice and mean the same thing, so
          // the shim comparison is taken on `explain` for the item this pair just attempted.
          crossChecked = await crossCheck(await surface.run(['explain', id]))
        }
      }
    }
  } finally {
    await surface.dispose()
  }

  const illegal = rows.filter((row) => row.expected === 'illegal')
  const refusedWithRule = illegal.filter((row) => row.outcome === 'refused' && row.namesRule)
  const idempotent = rows.filter((row) => row.expected === 'idempotent')
  const legal = rows.filter((row) => row.expected === 'legal')
  const wrong = rows.filter((row) => !row.asExpected)
  const met = refusedWithRule.length === illegal.length && wrong.length === 0

  return {
    rows,
    axis: {
      axis: 'A8',
      name: 'Lifecycle enforcement',
      metric: 'illegal transitions refused with a rule name',
      corpus: `every ordered pair of the ${WORK_ITEM_STATES.length} states, ${rows.length} attempts, one freshly filed item per attempt`,
      method: 'file an item, drive it to the from state through real transitions, attempt the to state, and read the rule id out of the result object',
      reference: '0 refused of 6 illegal pairs tried (prior-art E8)',
      target: 'every illegal pair refused with a guard id',
      verdict: met ? 'MET' : 'MISSED',
      observed: met
        ? `${refusedWithRule.length} of ${illegal.length} illegal pairs refused naming a rule id, ${legal.length} legal pairs behaved as the table says, ${idempotent.length} same-state requests returned the idempotent marker`
        : `${refusedWithRule.length} of ${illegal.length} illegal pairs refused naming a rule id; ${wrong.length} of ${rows.length} pairs did not match the table`,
      operations: surface.calls(),
      samples: rows.length,
      detail: {
        rows,
        rulesSeen: [...new Set(illegal.map((row) => row.rule))].sort(),
        guardRefusedLegalEdges: legal.filter((row) => row.outcome === 'refused')
          .map((row) => `${row.from}->${row.to} ${row.guard || row.rule}`),
        crossCheck: crossChecked ?? 'NOT MEASURED: no pair reached the cross-check case',
      },
    },
  }
}

function scorePair(
  from: WorkItemState, to: WorkItemState, type: string, item: string, attempt: Invocation,
): PairRow {
  const data = dataOf(attempt)
  const rule = typeof data['rule'] === 'string' ? data['rule'] : ''
  const guard = typeof data['guard'] === 'string' ? data['guard'] : ''
  const result = resultOf(attempt)
  const code = typeof result?.['code'] === 'string' ? result['code'] : ''
  const already = data['already'] !== undefined
  const outcome = attempt.code !== 0 ? 'refused' : already ? 'already' : 'allowed'
  const expected = from === to ? 'idempotent' : legalEdge(from, to) ? 'legal' : 'illegal'
  const namesRule = RULE_IDS.has(guard === '' ? rule : guard)

  // A legal edge may still be refused by a guard, which is the table working rather than
  // failing; what would not match the table is an illegal edge that was allowed, or a
  // same-state request that wrote something.
  const asExpected = expected === 'illegal'
    ? outcome === 'refused' && namesRule
    : expected === 'idempotent'
      ? outcome === 'already'
      : outcome !== 'allowed' ? namesRule : true

  return { from, to, type, item, expected, exit: attempt.code, code, rule, guard, outcome, namesRule, asExpected }
}
