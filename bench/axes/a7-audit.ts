// SPDX-License-Identifier: Apache-2.0
// Axis A7: "why is item X in state S", answered with event evidence.
//
// 50 items are driven through 200 applied transitions, each one chosen at random from the
// targets the rule table calls legal for that item at that moment, and every move is made by
// running the command. Then each item is put back to the surface with `explain` and scored
// against its own event chain.
//
// The chain is read from `.work/events/*.jsonl`, which is the store's committed artefact and
// what a person auditing this workspace would open. There is no history verb, so the surface
// half of the answer is `explain` naming the one event that produced the current state; the
// log half is the replay that has to agree with it. An item counts as explained only when
// both hold, which is why the two are scored together rather than separately.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { hasReviewStep } from '../../src/application/services/context.ts'
import { legalTargetsFrom, type WorkItem, type WorkItemState } from '../../src/domain/index.ts'
import { random } from '../../test/helpers/store-fixtures.ts'
import { crossCheck, dataOf, openSurface, type CrossCheck } from './surface.ts'
import type { AxisResult } from './axis.ts'

const ITEMS = 50
const TRANSITIONS = 200

type Tracked = {
  readonly id: string
  readonly type: 'task' | 'story'
  state: WorkItemState
  heldFrom: WorkItemState | undefined
}

type LogEvent = {
  readonly id: string
  readonly at: string
  readonly actor?: string
  readonly entity: string
  readonly op: string
  readonly before?: { readonly state?: string }
  readonly after?: { readonly state?: string }
}

/**
 * The targets the table allows this item right now, resume resolved against held_from and the
 * `in_progress` exit against the type's review step, so the walk stops spending an attempt on
 * the one exit G5 refuses outright for that type.
 */
function targetsFor(item: Tracked): readonly WorkItemState[] {
  return legalTargetsFrom({
    state: item.state,
    ...(item.heldFrom === undefined ? {} : { held_from: item.heldFrom }),
  } as WorkItem, hasReviewStep(item.type))
}

function argsFor(item: Tracked, to: WorkItemState): readonly string[] {
  const base = ['transition', item.id, to, '--reason', `axis a7 moved ${item.id} to ${to}`]
  if (to === 'cancelled') return [...base, '--resolution', 'wont_do']
  // `release` is the in_progress to ready edge and is the one other move that records a
  // closed-set value; T6 refuses it without one.
  if (to === 'ready' && item.state === 'in_progress') return [...base, '--outcome', 'yielded']
  return base
}

export type AuditRow = {
  readonly item: string
  readonly type: string
  readonly state: string
  readonly explainState: string
  readonly fromEvent: string
  readonly since: string
  readonly reason: string
  readonly events: number
  readonly namedEventInLog: boolean
  readonly replayEndsInState: boolean
  readonly everyEventHasActor: boolean
  readonly explained: boolean
}

export async function runA7(seed: number): Promise<{
  readonly axis: AxisResult
  readonly rows: readonly AuditRow[]
  readonly applied: number
  readonly refusedByGuard: number
}> {
  const surface = await openSurface('a7')
  const rows: AuditRow[] = []
  let crossChecked: CrossCheck | undefined
  let applied = 0
  let refusedByGuard = 0
  let statesVisited: readonly string[] = []

  try {
    const next = random(seed)
    const tracked: Tracked[] = []
    for (let i = 0; i < ITEMS; i += 1) {
      // A story is the only type that can stand in in_review, and a task the only one that
      // reaches done, so a mixed population is what makes the walk visit all seven states.
      const type = i % 5 === 0 ? 'story' : 'task'
      const id = `a7-item-${String(i).padStart(2, '0')}`
      const filed = await surface.run([
        'file', type, `Audit item ${i}`, '--id', id, '--points', '3', '--priority', '3',
        ...(type === 'story' ? ['--set', 'acceptance_criteria=the chain reads back'] : []),
      ])
      if (filed.code !== 0) throw new Error(`${id}: file refused: ${filed.err}`)
      tracked.push({ id, type, state: 'draft', heldFrom: undefined })
    }

    let attempts = 0
    const visited = new Set<string>(['draft'])
    const ceiling = TRANSITIONS * 20
    while (applied < TRANSITIONS && attempts < ceiling) {
      attempts += 1
      const item = tracked[Math.floor(next() * tracked.length)] as Tracked
      const targets = targetsFor(item)
      if (targets.length === 0) continue
      const to = targets[Math.floor(next() * targets.length)] as WorkItemState
      const moved = await surface.run(argsFor(item, to))
      if (moved.code !== 0) {
        // A guard on a legal edge may still refuse: a story cannot pass the done gate with
        // no reviewer and no evidence. The walk records that and moves on.
        refusedByGuard += 1
        continue
      }
      if (to === 'on_hold') item.heldFrom = item.state
      item.state = to
      visited.add(to)
      applied += 1
    }
    if (applied < TRANSITIONS) {
      throw new Error(`only ${applied} of ${TRANSITIONS} transitions applied in ${attempts} attempts`)
    }

    statesVisited = [...visited].sort()
    const log = await readEvents(path.join(surface.root, '.work', 'events'))
    for (const item of tracked) {
      const explained = await surface.run(['explain', item.id, '--out', 'json'])
      if (crossChecked === undefined) crossChecked = await crossCheck(await surface.run(['explain', item.id]))
      rows.push(score(item, dataOf(explained), log.get(item.id) ?? []))
    }
  } finally {
    await surface.dispose()
  }

  const answered = rows.filter((row) => row.explained)
  const met = answered.length === rows.length

  return {
    rows,
    applied,
    refusedByGuard,
    axis: {
      axis: 'A7',
      name: 'Audit answerability',
      metric: '"why is item X in state S" answered with event evidence',
      corpus: `${ITEMS} items driven through ${applied} applied transitions chosen at random from the legal targets, seed ${seed}`,
      method: 'explain each item at the surface, then check the event it names against the committed event log and replay every state-changing event for that item',
      reference: '0 of 50, the reference keeps no history',
      target: '50 of 50',
      verdict: met ? 'MET' : 'MISSED',
      observed: `${answered.length} of ${rows.length} items explained: the named event is in the log, the replay of ${rows.reduce((sum, row) => sum + row.events, 0)} events ends in the state shown, and every event carries an actor`
        + (met ? '' : `; ${rows.filter((row) => !row.explained).map((row) => row.item).join(', ')} were not`),
      operations: surface.calls(),
      samples: rows.length,
      detail: {
        rows,
        appliedTransitions: applied,
        guardRefusalsDuringTheWalk: refusedByGuard,
        statesVisited,
        statesAtRest: [...new Set(rows.map((row) => row.state))].sort(),
        crossCheck: crossChecked ?? 'NOT MEASURED: no item reached the cross-check case',
      },
    },
  }
}

async function readEvents(dir: string): Promise<Map<string, LogEvent[]>> {
  const byEntity = new Map<string, LogEvent[]>()
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.jsonl')).sort()) {
    const text = await readFile(path.join(dir, name), 'utf8')
    for (const line of text.split('\n').filter((entry) => entry.trim() !== '')) {
      const event = JSON.parse(line) as LogEvent
      const list = byEntity.get(event.entity)
      if (list === undefined) byEntity.set(event.entity, [event])
      else list.push(event)
    }
  }
  return byEntity
}

function score(item: Tracked, data: Record<string, unknown>, events: readonly LogEvent[]): AuditRow {
  const text = (key: string): string => (typeof data[key] === 'string' ? data[key] : '')
  const chain = events.filter((event) => event.op === 'item.file' || event.op === 'item.transition')
  const fromEvent = text('from_event')

  let replayed: string | undefined
  for (const event of chain) {
    const after = event.after?.state
    if (typeof after === 'string') replayed = after
  }

  const row = {
    item: item.id,
    type: item.type,
    state: item.state,
    explainState: text('state'),
    fromEvent,
    since: text('since'),
    reason: text('reason'),
    events: chain.length,
    namedEventInLog: fromEvent !== '' && chain.some((event) => event.id === fromEvent),
    replayEndsInState: replayed === item.state,
    everyEventHasActor: chain.length > 0 && chain.every((event) => typeof event.actor === 'string' && event.actor !== ''),
  }
  return {
    ...row,
    explained: row.explainState === item.state
      && row.since !== ''
      && row.namedEventInLog
      && row.replayEndsInState
      && row.everyEventHasActor,
  }
}
