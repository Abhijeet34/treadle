// SPDX-License-Identifier: Apache-2.0
// Axis A10: one invalid creation per rule, at the command surface.
//
// The axes table names "11 rules in 2.1" without numbering them, so the eleven are numbered
// here and each row carries the cell it comes from: five are the prior-art model's own
// "invalid at creation" column, and six are the common-field validations that column defers
// to when it says "none beyond common". Publishing the enumeration is what makes the 11 of
// 11 checkable rather than asserted; the reference's own 0 of 11 is quoted, never re-derived.
//
// Refusal alone is not the target. The model says the item is not created, so every row runs
// `show` on the id afterwards and a row that refused but wrote anyway fails.

import { crossCheck, dataOf, openSurface, resultOf, type CrossCheck } from './surface.ts'
import type { AxisResult } from './axis.ts'

type Rule = {
  readonly n: number
  readonly rule: string
  readonly source: string
  readonly id: string
  readonly argv: readonly string[]
  /** Counted in the eleven, or observed beside them because this product adds it. */
  readonly beyond?: true
}

const TOO_LONG = 'x'.repeat(201)

const RULES: readonly Rule[] = [
  {
    n: 1, rule: 'an epic without an outcome', source: '2.1, epic row, invalid at creation',
    id: 'a10-epic-no-outcome',
    argv: ['file', 'epic', 'An epic with no outcome statement'],
  },
  {
    n: 2, rule: 'a bug without a severity', source: '2.1, bug row, invalid at creation',
    id: 'a10-bug-no-severity',
    argv: ['file', 'bug', 'A defect with no severity', '--set', 'repro_steps=open the page', '--set', 'found_in=production'],
  },
  {
    n: 3, rule: 'a bug without repro steps', source: '2.1, bug row, invalid at creation',
    id: 'a10-bug-no-repro',
    argv: ['file', 'bug', 'A defect with no repro steps', '--set', 'severity=S2', '--set', 'found_in=production'],
  },
  {
    n: 4, rule: 'a spike without a question', source: '2.1, spike row, invalid at creation',
    id: 'a10-spike-no-question',
    argv: ['file', 'spike', 'A spike with no question', '--set', 'timebox_hours=4'],
  },
  {
    n: 5, rule: 'a spike without a timebox', source: '2.1, spike row, invalid at creation',
    id: 'a10-spike-no-timebox',
    argv: ['file', 'spike', 'A spike with no timebox', '--set', 'question=which ranker'],
  },
  {
    n: 6, rule: 'a type outside the closed set of six', source: '2.14, common field type',
    id: 'a10-unknown-type',
    argv: ['file', 'epicc', 'A type that is not one of the six'],
  },
  {
    n: 7, rule: 'a title over 200 characters', source: '2.14, common field title',
    id: 'a10-long-title',
    argv: ['file', 'task', TOO_LONG],
  },
  {
    n: 8, rule: 'a priority outside 1 to 5', source: '2.14, common field priority',
    id: 'a10-priority-range',
    argv: ['file', 'task', 'A task at priority nine', '--priority', '9'],
  },
  {
    n: 9, rule: 'points off the workspace scale', source: '2.14, common field points',
    id: 'a10-points-scale',
    argv: ['file', 'task', 'A task estimated at four points', '--points', '4'],
  },
  {
    n: 10, rule: 'a label that is not a slug', source: '2.14, common field labels',
    id: 'a10-label-slug',
    argv: ['file', 'task', 'A task with a label that is not a slug', '--set', 'labels=Not A Slug'],
  },
  {
    n: 11, rule: 'a field the dictionary does not define', source: '2.14, the dictionary is closed',
    id: 'a10-unknown-field',
    argv: ['file', 'task', 'A task carrying a field that does not exist', '--set', 'squad=platform'],
  },
  {
    n: 12, rule: 'a bug without a found-in stage', source: 'this product requires it; 2.14 gives it a default instead',
    id: 'a10-bug-no-found-in', beyond: true,
    argv: ['file', 'bug', 'A defect with no found_in', '--set', 'severity=S2', '--set', 'repro_steps=open the page'],
  },
]

export type ValidationRow = {
  readonly n: number
  readonly rule: string
  readonly source: string
  readonly beyond: boolean
  readonly exit: number
  readonly code: string
  readonly ruleId: string
  readonly cause: string
  readonly refused: boolean
  readonly notCreated: boolean
  readonly scored: boolean
}

export async function runA10(): Promise<{ readonly axis: AxisResult; readonly rows: readonly ValidationRow[] }> {
  const surface = await openSurface('a10')
  const rows: ValidationRow[] = []
  let crossChecked: CrossCheck | undefined

  try {
    for (const spec of RULES) {
      const attempt = await surface.run([...spec.argv, '--id', spec.id, '--out', 'json'])
      const data = dataOf(attempt)
      const result = resultOf(attempt)
      const code = typeof result?.['code'] === 'string' ? result['code'] : ''
      const ruleId = typeof data['rule'] === 'string' ? data['rule'] : ''
      const cause = typeof data['cause'] === 'string' ? data['cause'] : ''
      const refused = attempt.code !== 0 && code === 'VALIDATION' && ruleId !== ''

      const after = await surface.run(['show', spec.id, '--out', 'json'])
      const notCreated = after.code !== 0
      if (crossChecked === undefined) crossChecked = await crossCheck(after)

      rows.push({
        n: spec.n, rule: spec.rule, source: spec.source, beyond: spec.beyond === true,
        exit: attempt.code, code, ruleId, cause,
        refused, notCreated, scored: refused && notCreated,
      })
    }
  } finally {
    await surface.dispose()
  }

  const counted = rows.filter((row) => !row.beyond)
  const passed = counted.filter((row) => row.scored)
  const met = passed.length === counted.length

  return {
    rows,
    axis: {
      axis: 'A10',
      name: 'Type validation',
      metric: 'invalid creations refused',
      corpus: `one invalid creation per rule, ${counted.length} rules enumerated from the prior-art model plus ${rows.length - counted.length} this product adds`,
      method: 'file the invalid item at the surface, read the rule id out of the refusal, then run show on the id to prove nothing was created',
      reference: '0 of 11 refused, the reference has a single free-text kind',
      target: '11 of 11',
      verdict: met ? 'MET' : 'MISSED',
      observed: `${passed.length} of ${counted.length} refused with a rule id and nothing created; rule ids ${[...new Set(passed.map((row) => row.ruleId))].sort().join(', ')}`
        + (met ? '' : `; ${counted.filter((row) => !row.scored).map((row) => row.rule).join('; ')} did not`),
      operations: surface.calls(),
      samples: rows.length,
      detail: { rows, crossCheck: crossChecked ?? 'NOT MEASURED: no row reached the cross-check case' },
    },
  }
}
