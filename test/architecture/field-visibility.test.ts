// SPDX-License-Identifier: Apache-2.0
// Every field the store persists, against every field a read surface prints.
//
// Three defects of one class have landed in this product, each found by using the tool and
// none by reading the code: `severity` was required at creation and printed nowhere, a
// severity or priority change was recorded in no event, and every event carried an actor
// that no command printed. Each was a field captured faithfully on a write and then never
// shown, which makes the tool unable to answer for what it stores.
//
// This file is the gate that makes a fourth one a failing test rather than a benchmark
// finding. The rule is not "print everything": adding every field to every output would
// blow the byte budgets in docs/architecture/history/BENCHMARKS-2026-09.md that this product competes on. The rule is
// that every persisted field carries a decision, and that a hidden field is declared with
// its reason rather than silently missing.
//
// WHAT A FUTURE FIELD'S AUTHOR HAS TO DO. Add the field to the dictionary in
// src/domain/fields.ts, or a key to `EVENT_KEYS` in src/adapters/store/event-log.ts, then
// add one line to `ITEM_FIELDS` or `EVENT_FIELDS` below:
//
//   `readable('<command>:<key>')` naming the result key or block column that carries it,
//   or `hidden('<why it is not printed>')` with a reason a reader can weigh.
//
// There is no third answer. A field with no line fails the first test in this file, by
// name; a `readable` line whose key no shape declares fails the third; and a `readable`
// line whose key a real record never prints fails the fifth, so declaring a surface that
// does not print it is not a way through.
//
// A KEY IS NOT CONTENT, WHICH IS WHAT THIS FILE MISSED. Every test above asks whether the
// field's name reaches a surface. `acceptance_criteria` passed all of them while the tool
// printed `ac 0/1` and no command anywhere would print the criteria: the name resolved, the
// content did not, and a team's committed checklist was unreadable through the tool that
// held it. The last suite in this file closes that: for every field a real record carries,
// the stored value's own text has to appear in `show <id>` or in `show <id> --field <name>`,
// and a field that deliberately prints a summary instead is declared in `CONTENT_HELD_BACK`
// with its reason. A count, a length or a tally is not a read surface for the thing counted.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { CONFIG_KEYS, WORK_ITEM_TYPES, canonicalField, fieldsOf, shortField, type WorkItem } from '../../src/domain/index.ts'
import { EVENT_KEYS } from '../../src/adapters/store/event-log.ts'
import { SHAPES } from '../../src/application/shapes.ts'
import { agentRenderer } from '../../src/adapters/render/agent.ts'
import type { ResultObject } from '../../src/application/result.ts'
import type { Store } from '../../src/application/ports/store.ts'
import { showItem } from '../../src/application/services/items.ts'
import { history } from '../../src/application/services/history.ts'
import { explain } from '../../src/application/services/insight.ts'
import { fileItem } from '../../src/application/services/items.ts'
import { addEvidence, markItem } from '../../src/application/services/marking.ts'
import { relate } from '../../src/application/services/relation.ts'
import { transition } from '../../src/application/services/lifecycle.ts'
import { makeEvent, type Actor } from '../../src/application/services/mutation.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { openWorkspace } from '../../src/adapters/store/index.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { initWorkspace } from '../../src/adapters/workspace.ts'

type Decision =
  | { readonly kind: 'readable'; readonly at: string; readonly note?: string }
  | { readonly kind: 'hidden'; readonly why: string }

const readable = (at: string, note?: string): Decision =>
  note === undefined ? { kind: 'readable', at } : { kind: 'readable', at, note }
const hidden = (why: string): Decision => ({ kind: 'hidden', why })

/** Every field of the work-item dictionary, and the surface that prints it. */
const ITEM_FIELDS: Readonly<Record<string, Decision>> = {
  id: readable('show:item'),
  type: readable('show:type'),
  state: readable('show:state'),
  title: readable('show:title'),
  filed_at: readable('show:filed'),
  version: readable('show:v'),
  description: readable('show:desc', 'cut at 64 cells, whole under `show <id> --field desc`'),
  priority: readable('show:pri'),
  parent_id: readable('show:parent'),
  assignee: readable('show:assignee'),
  reporter: readable('show:reporter'),
  reviewer: readable('show:reviewer'),
  labels: readable('show:labels'),
  due: readable('show:due'),
  evidence: readable('show:evidence'),
  relations: readable('show:relations', 'the stored edges under their own kind, and the edges other records store against this one under the inverse kind'),
  hold_reason: readable('show:hold'),
  hold_until: readable('show:hold_until'),
  held_from: readable('show:held_from'),
  resolution: readable('show:resolution'),
  extra: readable('show:extra', 'the count and not the values: these are keys a newer writer produced that this build has no meaning for (DR3), and printing one as a field of the record invites a caller to act on a value nothing here can validate'),
  outcome: readable('show:outcome'),
  acceptance_criteria: readable('show:ac', 'ticked over total, with the criteria themselves in the `criteria` block beside it and under `show <id> --field ac`'),
  severity: readable('show:sev'),
  repro_steps: readable('show:repro'),
  expected: readable('show:expected'),
  actual: readable('show:actual'),
  found_in: readable('show:found'),
  fix_confirmed: readable('show:fixed'),
  question: readable('show:question'),
  findings: readable('show:findings'),
  proposed_resolution: readable('show:proposed_resolution', 'cut at 64 cells, whole under `show <id> --field proposed_resolution`, and a G2 refusal on work the impediment blocks names that command'),
}

/** Every key one line of the append-only event log carries, and the surface that prints it. */
const EVENT_FIELDS: Readonly<Record<string, Decision>> = {
  id: readable('explain:from_event', 'and the `event` line every mutation prints for the write it just made'),
  at: readable('history:at'),
  actor: readable('history:by'),
  actor_kind: readable('history:kind'),
  entity_kind: hidden('`item` and `workspace` are the two values written, and no command in this build writes both under one transaction, so the kind is the same on every row of either scope: a column of it would restate what the caller typed under `history <id>` and one op prefix under `history --txn`.'),
  entity: readable('history:what', 'as `entity=<id>`, and under `history --txn` alone: there the rows span records and the record is the only thing telling two rows of one op apart, where under `history <id>` every row is the id the caller named and the column would restate the `item` line above it'),
  op: readable('history:op'),
  before: hidden('the values a change moved away from. `history` names the fields a change moved and `show` prints what they are now, so a `before` column would put a per-row copy of the old record inside a list whose budget is per row. The one question the old value answers alone is whether the record still agrees with the log, and `doctor` H20 asks it against the record rather than printing it.'),
  after: readable('history:what', 'the field names, not the values: a value may carry a space and the row grammar allows one space-bearing column, which the actor is'),
  guards: readable('history:what', 'as `override=<guard>`. A guard that fails refuses the write, so every guard in a stored event passed and a column of `pass` would be noise; an overridden guard is the one that is not'),
  reason: readable('history:why', 'every recorded reason on the page, in a block of its own: a row carries one space-bearing field and that is the actor. `explain` prints the same field for the one event that put the item in the state it is in'),
  outcome: readable('history:what', 'as `outcome=<v>`'),
  cmd: hidden('`op` is the same fact in the vocabulary the store owns: `item.mark` for `mark`. `cmd` is kept in the log so a later rename of a command stays traceable against old events, and printing both prints one fact twice.'),
  txn: readable('history:transaction', 'as the scope of the read rather than as a column: `history --txn <txn>` is asked for one transaction and every row it prints belongs to it, so a column would restate the scalar above it. The mutation\'s own envelope is where a caller gets the id, and this is what spends it (R4).'),
}

/**
 * Every key of the workspace's configuration dictionary, and the surface that prints it.
 * `config` prints all six as rows of one block, each with the value in force and whether
 * this workspace set it, which is the surface the sweep below checks the shape declares.
 */
const CONFIG_KEY_DECISIONS: Readonly<Record<string, Decision>> = {
  review_step: readable('config:value'),
  next_weights: readable('config:value'),
  wip_limits: readable('config:value'),
  aging_days: readable('config:value'),
  ready_gate: readable('config:value', 'the rules as the file writes them, joined by | on one row; `explain` prints each rule of the gate in force with its verdict'),
  done_gate: readable('config:value', 'the same, and `explain` is where a rule is read against one item'),
}

/**
 * The event keys whose stored content a read surface projects rather than prints verbatim,
 * each with the reason. Everything else has to come back out of a reading whole.
 *
 * The key sweep above asked only whether a key's NAME reaches a surface, and `reason` passed
 * it on `explain`, which prints the reason of the event that put the item in the state it is
 * in. A mark moves no state, so `mark --reason "revenue path"` was recorded and readable
 * through no command at all. That is `acceptance_criteria`'s defect in the log rather than in
 * the record, and this table plus the sweep under it is the same gate for events.
 */
const EVENT_CONTENT_HELD_BACK: Readonly<Record<string, string>> = {
  before: 'the values a change moved away from; `history` prints them inside `field=from->to` under the marker convention, which is a projection and not the stored object',
  after: 'the same, from the other side: prose is stored as its length and a value over 40 characters falls back to its field name, so the stored object is not what prints',
  guards: 'a guard verdict is an object; `history` prints the overridden ones as `override=<guard>` and a passing guard is every row\'s answer',
  id: 'the event id names one event, and `explain` prints the one it was asked about. `history` carries an event id in the cursor of its `page` line, which is what resumes a page rather than a column of every id; as a sweep it would demand a key no list prints',
}

/**
 * The fields whose stored content no read surface prints, each with the reason. Everything
 * else has to be recoverable verbatim, which is what the key sweep above never asked.
 */
const CONTENT_HELD_BACK: Readonly<Record<string, string>> = {
  extra: 'the count and not the values: these are keys a newer writer produced that this build has no meaning for, and printing one invites a caller to act on a value nothing here can validate',
  version: 'it is printed as `v`, and a bare integer is matched by any record; the first suite already holds its key',
}

/**
 * The atoms of a stored value that a read surface has to print: the value itself for a
 * scalar, and every string a collection's entries carry, because a list whose entries print
 * as a count is the defect this file exists for. A boolean inside an entry is a flag each
 * surface renders in its own vocabulary - the criteria block prints a tick as `x` - so what
 * has to survive is the entry's text and not the word `false`.
 */
function contentOf(value: unknown, nested = false): readonly string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.flatMap((entry) => contentOf(entry, true))
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) => contentOf(entry, true))
  }
  return nested && typeof value !== 'string' ? [] : [String(value)]
}

const ACTOR: Actor = { id: 'dana', kind: 'human' }
const AGENT: Actor = { id: 'agent-7', kind: 'agent' }
const NOW = '2026-09-05T09:00:00Z'

/** The seven records the fixture below builds, one per work-item type. */
const ITEMS = ['every-epic', 'every-story', 'every-bug', 'every-spike', 'every-held', 'every-stopped', 'every-raised'] as const

/** Every field name the record grammar can persist, over every type. */
function persistedItemFields(): readonly string[] {
  return [...new Set(WORK_ITEM_TYPES.flatMap((type) => fieldsOf(type)))].sort()
}

function shapeOf(command: string) {
  return SHAPES.find((shape) => shape.command === command)
}

/** Whether one shape declares a key, as a property of its own or as a column of a block. */
function declares(command: string, key: string): boolean {
  const shape = shapeOf(command)
  if (shape === undefined) return false
  return shape.properties.some((property) =>
    property.key === key
    || (property.kind === 'block' && property.columns.some((column) => column.name === key)))
}

/**
 * The keys one agent rendering actually printed. A scalar, a marked scalar, a text block, a
 * truncation note and a block opener all lead with their key; a `#` header names the columns
 * of the rows under it, each marked column carrying the same leading quote.
 */
function printedKeys(text: string): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith('#')) {
      for (const column of line.slice(1).split(' ')) keys.add(column.replace(/^"/, ''))
      continue
    }
    const head = line.split(' ')[0] as string
    keys.add(head.replace(/^["~|+]/, ''))
  }
  return keys
}

type Rig = {
  readonly store: Store
  readonly dispose: () => Promise<void>
}

/**
 * One workspace carrying every field of every type, and a log carrying every kind of event.
 * The items are filed through the real use cases, so a field that no write path can set is
 * a finding here rather than a fixture the suite writes by hand; `extra` is the exception
 * and is applied to the store directly, because by construction only a newer writer produces
 * one, and the overridden guard is appended so the bug's log carries one without a second
 * item filed only to block it.
 */
async function aWorkspaceCarryingEveryField(): Promise<Rig> {
  const parent = await mkdtemp(path.join(tmpdir(), 'treadle-fields-'))
  const root = path.join(parent, 'platform', '.work')
  const ids = sequentialIds()
  const clock = fixedClock(NOW)
  await initWorkspace(clock, ids, { at: root, name: 'field-sweep', actor: ACTOR })

  const opened = await openWorkspace(root)
  if (!opened.ok) throw new Error(opened.error.message)
  const store = opened.value
  const apply = targetFor(store, 'apply')

  const file = async (type: string, title: string, id: string, fields: Record<string, string>) => {
    const result = await fileItem(apply, clock, ids, {
      type: type as 'task', title, id, fields, actor: ACTOR,
    })
    if (!result.ok) throw new Error(`${id}: ${String(result.data['cause'])}`)
  }
  const move = async (id: string, target: string, extra: Record<string, string> = {}) => {
    const result = await transition(apply, clock, ids, {
      id, target: target as 'ready', actor: ACTOR, reason: 'fixture', ...extra,
    })
    if (!result.ok) throw new Error(`${id} -> ${target}: ${String(result.data['cause'])}`)
  }

  await file('epic', 'Checkout works end to end', 'every-epic', {
    outcome: 'a customer can pay without a support ticket',
  })
  await file('story', 'Refresh the access token on a 401', 'every-story', {
    description: 'the client drops the session when the token expires',
    acceptance_criteria: 'a 401 refreshes once|the retry carries the new token',
    priority: '2', parent_id: 'every-epic',
    assignee: 'kim', reporter: 'ravi', reviewer: 'dana',
    labels: 'revenue,regression', due: '2026-09-30T09:00:00Z',
  })
  await file('bug', 'Checkout drops paid orders', 'every-bug', {
    severity: 'S2', found_in: 'production', fix_confirmed: 'false',
    repro_steps: 'add two items to the cart and pay with a saved card',
    expected: 'both orders are listed', actual: 'one order is listed and the other is charged',
  })
  await file('spike', 'Which payment retry strategy', 'every-spike', {
    question: 'do we retry on the gateway or in the queue',
    findings: 'the gateway retries twice already',
  })
  await file('task', 'Rotate the payment signing key', 'every-held', { priority: '3' })
  const linked = await relate(apply, clock, ids, {
    verb: 'add', id: 'every-held', kind: 'blocks', other: 'every-story', actor: ACTOR,
  })
  if (!linked.ok) throw new Error(String(linked.data['cause']))
  await move('every-held', 'ready')
  await move('every-held', 'on_hold', { until: '2026-10-15T09:00:00Z' })
  await file('chore', 'Remove OAuth 1 support', 'every-stopped', {})
  await move('every-stopped', 'cancelled', { resolution: 'superseded' })
  await file('impediment', 'Staging certificate expired', 'every-raised', {
    severity: 'S1', proposed_resolution: 'the platform team renews it from the vault',
  })

  const raised = await relate(apply, clock, ids, {
    verb: 'add', id: 'every-raised', kind: 'blocks', other: 'every-spike', actor: ACTOR,
  })
  if (!raised.ok) throw new Error(String(raised.data['cause']))

  // The bug's own log: a mark, an evidence pointer and a release that names its outcome.
  const marked = await markItem(apply, clock, ids, {
    id: 'every-bug', severity: 'S1', reason: 'it drops paid orders', actor: AGENT,
  })
  if (!marked.ok) throw new Error(String(marked.data['cause']))
  const pointed = await addEvidence(apply, clock, ids, {
    id: 'every-bug', kind: 'run', ref: '8813', label: '664 pass', actor: ACTOR,
  })
  if (!pointed.ok) throw new Error(String(pointed.data['cause']))
  await move('every-bug', 'ready')
  await move('every-bug', 'in_progress')
  await move('every-bug', 'ready', { outcome: 'failed' })

  const stored = await store.get('every-story')
  if (!stored.ok || stored.value === undefined) throw new Error('every-story is not stored')
  const withExtra = { ...stored.value, extra: new Map([['a_field_from_2027', 'kept verbatim']]) } as WorkItem
  const applied = await store.apply({
    txn: 'tfields1',
    writes: [{ item: withExtra, ifVersion: stored.value.version }],
    events: [makeEvent({
      id: 'efields1', at: NOW, actor: ACTOR, entity: 'every-bug', op: 'item.transition',
      before: { state: 'ready' }, after: { state: 'in_progress' },
      guards: [{ guard: 'G2', pass: true, overridden: true }],
      reason: 'an override is the one guard verdict a stored event can disagree about',
      txn: 'tfields1', command: 'transition',
    })],
  })
  if (!applied.ok) throw new Error(applied.error.message)

  return {
    store,
    dispose: async () => {
      await store.close()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

describe('every persisted field carries a visibility decision', () => {
  it('has one decision per field of the work-item dictionary, and none for a field it has not got', () => {
    assert.deepEqual(
      Object.keys(ITEM_FIELDS).sort(),
      persistedItemFields(),
      'a field of the dictionary with no line in ITEM_FIELDS, or a line naming a field the dictionary does not carry; see the header of this file',
    )
  })

  it('has one decision per key of the configuration dictionary, and none for a key it has not got', () => {
    assert.deepEqual(Object.keys(CONFIG_KEY_DECISIONS).sort(), [...CONFIG_KEYS].sort())
  })

  it('has one decision per key of the event log', () => {
    assert.deepEqual(
      Object.keys(EVENT_FIELDS).sort(),
      [...EVENT_KEYS].sort(),
      'a key of EVENT_KEYS with no line in EVENT_FIELDS, or a line naming a key the log does not carry',
    )
  })

  it('names, for every readable decision, a key its command declares', () => {
    for (const [scope, table] of [['item', ITEM_FIELDS], ['event', EVENT_FIELDS], ['config', CONFIG_KEY_DECISIONS]] as const) {
      for (const [field, decision] of Object.entries(table)) {
        if (decision.kind !== 'readable') continue
        const [command, key] = decision.at.split(':')
        assert.ok(command !== undefined && key !== undefined, `${scope} ${field}: a readable decision is written <command>:<key>`)
        assert.ok(
          declares(command as string, key as string),
          `${scope} ${field} claims ${decision.at}, and the ${command} shape declares no ${key}`,
        )
      }
    }
  })

  // The alias table is what makes `--set desc=` and `--set description=` the same field, so it
  // has to agree with the surface these decisions name. Two tables saying one thing is how the
  // write path and the read path came to deny each other's spelling in the first place.
  it('agrees with the field dictionary\'s alias table, for every readable item decision', () => {
    for (const [field, decision] of Object.entries(ITEM_FIELDS)) {
      if (decision.kind !== 'readable') continue
      const [command, key] = decision.at.split(':') as [string, string]
      if (command !== 'show') continue
      assert.equal(canonicalField(key), field, `${field} is printed as ${key} and canonicalField(${key}) is not ${field}`)
      assert.equal(shortField(field), key, `${field} is printed as ${key} and shortField(${field}) is not ${key}`)
    }
  })

  it('gives, for every hidden decision, a reason rather than a restatement', () => {
    for (const [scope, table] of [['item', ITEM_FIELDS], ['event', EVENT_FIELDS]] as const) {
      for (const [field, decision] of Object.entries(table)) {
        if (decision.kind !== 'hidden') continue
        assert.ok(
          decision.why.length >= 40 && decision.why !== field,
          `${scope} ${field} is hidden with no reason a reader can weigh`,
        )
      }
    }
  })
})

/** The transaction of one event this entity's log holds, which `history --txn` is read with. */
async function aTransactionOf(store: Store, entity: string): Promise<string> {
  const log = await store.events({ entity })
  assert.ok(log.ok && log.value.length > 0, `${entity} has no recorded event to take a transaction from`)
  return (log.value[0] as { txn: string }).txn
}

describe('a real record and a real log print what the decisions claim', () => {
  let rig: Rig
  let itemKeys: ReadonlySet<string>
  let eventKeys: ReadonlySet<string>

  before(async () => {
    rig = await aWorkspaceCarryingEveryField()
    const clock = fixedClock(NOW)
    const shown = new Set<string>()
    for (const id of ITEMS) {
      const result = await showItem(rig.store, clock, id)
      assert.equal(result.ok, true, `show ${id} refused`)
      for (const key of printedKeys(agentRenderer.render(result))) shown.add(key)
    }
    itemKeys = shown

    const printed = new Set<string>()
    const log = await history(rig.store, { scope: { kind: 'item', id: 'every-bug' }, limit: 20 })
    assert.equal(log.ok, true)
    const why = await explain(rig.store, fixedClock(NOW), 'every-bug')
    assert.equal(why.ok, true)
    // The other scope is a second reading and not a variation of the first: `transaction` and
    // the `entity=` part of `what` reach no output at all under `history <id>`, so a decision
    // naming either would pass the sweep below on a surface that never prints it.
    const scoped = await history(rig.store, { scope: { kind: 'txn', txn: await aTransactionOf(rig.store, 'every-bug') }, limit: 20 })
    assert.equal(scoped.ok, true)
    for (const result of [log, why, scoped] as readonly ResultObject[]) {
      for (const key of printedKeys(agentRenderer.render(result))) printed.add(key)
    }
    // `what` names the column; the values it carries are what the three decisions claim.
    const rows = agentRenderer.render(log)
    assert.match(rows, /override=G2/, 'an overridden guard reaches the what column')
    assert.match(rows, /outcome=failed/, 'the attempt outcome reaches the what column')
    assert.match(rows, /item\.mark severity/, 'the fields a change moved reach the what column')
    // The entity decision claims `history:what`, and `printedKeys` sees the column whether or
    // not the record is in it: `every-bug` is also the `item` scalar of the read above, so
    // the content sweep passes on that line alone. This is what holds the claim where it is made.
    assert.match(agentRenderer.render(scoped), /entity=every-bug/, 'the record an event moved reaches the what column of a transaction-scoped read')
    eventKeys = printed
  })

  after(async () => { await rig.dispose() })

  it('prints every key an item decision calls readable', () => {
    for (const [field, decision] of Object.entries(ITEM_FIELDS)) {
      if (decision.kind !== 'readable') continue
      const key = decision.at.split(':')[1] as string
      assert.ok(itemKeys.has(key), `${field} claims ${decision.at} and no record printed ${key}`)
    }
  })

  it('prints every key an event decision calls readable', () => {
    for (const [field, decision] of Object.entries(EVENT_FIELDS)) {
      if (decision.kind !== 'readable') continue
      const key = decision.at.split(':')[1] as string
      assert.ok(eventKeys.has(key), `${field} claims ${decision.at} and no log printed ${key}`)
    }
  })

  it('prints the stored content of every readable field, and not merely its name', async (t) => {
    const clock = fixedClock(NOW)
    let checked = 0
    for (const id of ITEMS) {
      const stored = await rig.store.get(id)
      assert.equal(stored.ok && stored.value !== undefined, true, `${id} is not stored`)
      const item = (stored as { value: WorkItem }).value as unknown as Record<string, unknown>
      for (const [field, decision] of Object.entries(ITEM_FIELDS)) {
        if (decision.kind !== 'readable') continue
        if (field in CONTENT_HELD_BACK) continue
        const value = item[field]
        if (value === undefined) continue
        const whole = await showItem(rig.store, clock, id, field)
        assert.equal(whole.ok, true, `show ${id} --field ${field} refused`)
        const printed = `${agentRenderer.render(await showItem(rig.store, clock, id))}\n${agentRenderer.render(whole)}`
        for (const atom of contentOf(value)) {
          assert.ok(
            printed.includes(atom),
            `${id}: ${field} holds ${JSON.stringify(atom)} and no read surface printed it; see the header of this file`,
          )
          checked += 1
        }
      }
    }
    t.diagnostic(`${checked} stored values checked for content, over ${ITEMS.length} records`)
  })

  // The same assertion for the log. `reason` satisfied every key test in this file while no
  // command would print a mark's reason, which is the defect the tests above cannot see.
  it('prints the stored content of every readable event field, and not merely its name', async (t) => {
    let checked = 0
    for (const entity of ['every-bug', 'every-story', 'every-held'] as const) {
      const log = await rig.store.events({ entity })
      assert.ok(log.ok, `the log for ${entity} is unreadable`)
      assert.ok(log.value.length > 0, `${entity} has no recorded event, so this sweep is vacuous`)
      const transactions = [...new Set(log.value.map((event) => event.txn))]
      const printed = [
        agentRenderer.render(await history(rig.store, { scope: { kind: 'item', id: entity }, limit: 200 })),
        agentRenderer.render(await explain(rig.store, fixedClock(NOW), entity)),
        ...await Promise.all(transactions.map(async (txn) =>
          agentRenderer.render(await history(rig.store, { scope: { kind: 'txn', txn }, limit: 200 })))),
      ].join('\n')
      for (const event of log.value) {
        for (const [key, decision] of Object.entries(EVENT_FIELDS)) {
          if (decision.kind !== 'readable' || key in EVENT_CONTENT_HELD_BACK) continue
          const value = (event as unknown as Record<string, unknown>)[key]
          if (value === undefined) continue
          for (const atom of contentOf(value)) {
            assert.ok(
              printed.includes(atom),
              `${entity}: an event carries ${key} ${JSON.stringify(atom)} and no reading printed it; see the header of this file`,
            )
            checked += 1
          }
        }
      }
    }
    t.diagnostic(`${checked} stored event values checked for content`)
  })
})
