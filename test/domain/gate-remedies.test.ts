// SPDX-License-Identifier: Apache-2.0
// A gate rule that fails prints a remedy, and a remedy is a promise: do this and the rule
// passes. Firstmate filed a bug with no `expected` and no `actual`, was refused with
// `set expected on <id>`, and found that no command sets a stored field after creation. The
// item was permanently unadvanceable and `doctor` called the workspace clean, because every
// part worked correctly in isolation and nothing weighed one part against another.
//
// This file is that weighing. The invariant is that every remedy string a gate can emit
// names a command the inventory carries, that can perform it.
//
// WHAT A FUTURE CHECK'S AUTHOR HAS TO DO. Add the kind to `GateCheck` in
// src/domain/gates.ts, then add one line to `PERFORMED_BY` below naming the command its
// remedy invokes, and a context in `everyRemedy` that makes it fail. A kind with no line
// fails the first test here, by name; a kind no context reaches fails the sweep. There is
// no "no remedy" answer any more: `no_open_impediment` was declared unbuildable while the
// impediment entity did not exist, and gained `transition` when it did.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  DEFAULT_DONE_GATE,
  DEFAULT_READY_GATE,
  evaluateGate,
  type Gate,
  type GateCheck,
} from '../../src/domain/index.ts'
import { COMMANDS } from '../../src/cli/inventory.ts'
import { SRC } from '../helpers/src-scan.ts'
import { child, gateContext, item } from '../helpers/fixtures.ts'

/** Every check the gate evaluator can run, and the command whose remedy it emits. */
const PERFORMED_BY: Readonly<Record<string, string>> = {
  field_present: 'set',
  field_non_empty_list: 'set',
  list_all_ticked: 'set',
  field_is_true: 'set',
  type_required_fields: 'set',
  estimate_set: 'set',
  no_active_blocker: 'transition',
  parent_present: 'set',
  child_present: 'file',
  no_open_child: 'transition',
  // Resolving the impediment is reaching `done`, the same command DOR3 names for a blocker.
  no_open_impediment: 'transition',
  reviewer_distinct_from_assignee: 'set',
  evidence_present: 'evidence',
}

/** The kinds the evaluator's own switch handles, read from the source it is written in. */
function checkKinds(): readonly string[] {
  const source = readFileSync(path.join(SRC, 'domain', 'gates.ts'), 'utf8')
  return [...source.matchAll(/^ {4}case '([a-z_]+)':/gm)].map((match) => match[1] as string).sort()
}

/** Checks no shipped rule can fail on, each as a one-rule gate so the sweep still reaches it. */
const PROBES: readonly Gate[] = ([
  { kind: 'parent_present' },
  { kind: 'child_present' },
] as const satisfies readonly GateCheck[]).map((check): Gate => ({
  name: `probe-${check.kind}`,
  rules: [{ id: 'P1', scope: 'all', sentence: 'a probe.', check }],
}))

type Emitted = { readonly rule: string; readonly kind: string; readonly remedy: string }

/**
 * Every remedy the shipped gates and the probes can emit, against contexts built to fail
 * each. A `story` fails the list rules, a `bug` the field rules and an `epic` the child
 * rule, so one pass over the four covers every scoped rule the defaults carry.
 */
function everyRemedy(): readonly Emitted[] {
  const contexts = [
    gateContext(item('bug', { id: 'b1' }), { reviewStep: true }),
    gateContext(item('story', { id: 's1', acceptance_criteria: [{ text: 'the header row', ticked: false }] })),
    gateContext(item('story', { id: 's0' })),
    // A bug with its creation-required fields cleared, which is the only way DOR2 fails: the
    // store refuses to write one, and a record from an older writer or a hand edit carries it.
    gateContext(item('bug', { id: 'b0', severity: undefined, repro_steps: undefined, found_in: undefined })),
    gateContext(item('epic', { id: 'e1' }), {
      blockers: ['x1'],
      children: [child('c1', 'task', 'in_progress')],
    }),
    gateContext(item('task', { id: 't1' })),
    // Work an impediment is raised against, which is the only way DOD2 fails.
    gateContext(item('task', { id: 't2' }), { blockers: ['cert-expired'], openImpediments: ['cert-expired'] }),
  ]
  const gates = [DEFAULT_READY_GATE, DEFAULT_DONE_GATE, ...PROBES]

  const out: Emitted[] = []
  for (const context of contexts) {
    for (const gate of gates) {
      for (const verdict of evaluateGate(gate, context).rules) {
        if (verdict.pass || verdict.remedy === undefined) continue
        const kind = gate.rules.find((rule) => rule.id === verdict.rule)?.check.kind
        out.push({ rule: `${gate.name} ${verdict.rule}`, kind: kind as string, remedy: verdict.remedy })
      }
    }
  }
  return out
}

describe('every gate check declares what performs its remedy', () => {
  it('has one line per kind the evaluator handles, and none for a kind it has not got', () => {
    assert.deepEqual(
      Object.keys(PERFORMED_BY).sort(),
      checkKinds(),
      'a GateCheck kind with no line in PERFORMED_BY, or a line naming a kind the evaluator does not run; see the header of this file',
    )
  })

  it('names a command the inventory carries, for every kind that has one', () => {
    for (const [kind, performer] of Object.entries(PERFORMED_BY)) {
      assert.ok(
        COMMANDS.some((command) => command.name === performer),
        `${kind} says ${performer} performs its remedy, and the inventory has no such command`,
      )
    }
  })
})

describe('every remedy a gate can emit names a command that exists', () => {
  const remedies = everyRemedy()

  it('has a remedy from every shipped rule that can fail, so a pass is not vacuous', () => {
    const rules = new Set(remedies.map((entry) => entry.rule))
    for (const wanted of ['ready DOR6', 'ready DOR7', 'done DOD3', 'done DOD6']) {
      assert.ok(rules.has(wanted), `no context in this file makes ${wanted} fail`)
    }
    assert.ok(remedies.length >= 12, `only ${remedies.length} remedies were collected`)
  })

  // Declaring a command and then never exercising the kind would pass every assertion below
  // while proving nothing, so the sweep has to reach each kind it claims to have covered.
  it('reaches every kind, so a declared command is exercised rather than asserted', () => {
    const swept = new Set(remedies.map((entry) => entry.kind))
    for (const [kind, performer] of Object.entries(PERFORMED_BY)) {
      assert.ok(swept.has(kind), `${kind} names ${performer} and no context here makes it fail`)
    }
  })

  for (const { rule, remedy } of remedies) {
    it(`${rule}: ${remedy}`, () => {
      const [tool, name] = remedy.split(' ')
      assert.equal(tool, 'treadle', `${rule} remedies with prose rather than a command: ${remedy}`)
      assert.ok(
        COMMANDS.some((command) => command.name === name),
        `${rule} names ${String(name)}, which is not a treadle command: ${remedy}`,
      )
      const command = COMMANDS.find((entry) => entry.name === name)
      assert.equal(command?.effect, 'mutate', `${rule} remedies with a read: ${remedy}`)
    })
  }

  // Imported here rather than at the top of the file, so a tree with no field editor at all
  // fails this one assertion by name instead of failing to load and reporting nothing.
  it('names, in every assignment it writes, a field that set will accept', async () => {
    const { SETTABLE_FIELDS } = await import('../../src/application/services/editing.ts')
    const sets = remedies.filter((entry) => entry.remedy.includes('='))
    assert.ok(sets.length >= 6, `only ${sets.length} remedies carry an assignment`)
    for (const { rule, remedy } of sets) {
      // A quoted value can carry a space and an `=`, so the quoted spans go first and the
      // assignments are read off what is left.
      const bare = remedy.replaceAll(/"[^"]*"/g, '<quoted>')
      const fields = [...bare.matchAll(/(?:^|\s)([a-z_]+)=/g)].map((match) => match[1] as string)
      assert.ok(fields.length > 0, `${rule} carries an = and no assignment: ${remedy}`)
      for (const field of fields) {
        assert.ok(
          (SETTABLE_FIELDS as readonly string[]).includes(field),
          `${rule} tells a caller to set ${field}, which set refuses: ${remedy}`,
        )
      }
    }
  })
})
