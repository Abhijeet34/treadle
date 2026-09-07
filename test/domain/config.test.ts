// SPDX-License-Identifier: Apache-2.0
// The configuration dictionary: what each key accepts, what it refuses, and the round trip.
//
// The round trip is the load-bearing one. Four surfaces spell a value - the record file, a
// `config set` line, the `workspace.config` event and the `config` reading - and they are
// one parse and one render, so a value that renders to text the same parse cannot read back
// would put a workspace one command away from a file the store will not serve.
//
// The check vocabulary is held to the `GateCheck` union in the same file: a check added to
// the union with no name here is unconfigurable, and a name here the union has not got is a
// gate the parser accepts and the evaluator cannot run.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHECK_NAMES,
  CONFIG_KEYS,
  WEIGHT_NAMES,
  configLine,
  defaultConfig,
  evaluateGate,
  parseConfigValue,
  withConfigKey,
  type ConfigKey,
  type Gate,
} from '../../src/domain/index.ts'
import { gateContext, item } from '../helpers/fixtures.ts'

/** A value every key accepts, spelled as a caller would type it on a `config set` line. */
const ACCEPTED: Readonly<Record<ConfigKey, string>> = {
  review_step: 'story, bug',
  point_scale: '1, 2, 3, 5, 8, 13, 21',
  next_weights: 'pri=20, age=2',
  wip_limits: 'in_progress=5, in_review=2',
  aging_days: '5',
  cycle_time_excludes_hold: 'true',
  start_requires_sprint: 'true',
  ready_gate: 'DOR1 all field_present:title The item has a title|DOR5 story estimate_set The story is estimated',
  done_gate: 'DOD1 all no_open_child Every child is done or cancelled',
}

/** A value every key refuses, and the substring the refusal has to name. */
const REFUSED: Readonly<Record<ConfigKey, readonly (readonly [string, string])[]>> = {
  review_step: [['story, nonesuch', 'nonesuch'], ['story, story', 'twice']],
  point_scale: [['1, banana', 'banana'], ['', 'whole number'], ['1, 1', 'twice']],
  next_weights: [['pri=10, nope=1', 'nope'], ['pri', 'pri'], ['pri=-1', 'pri=-1']],
  wip_limits: [['nonesuch=5', 'nonesuch'], ['in_progress=x', 'in_progress=x'], ['in_progress=5, in_progress=6', 'twice']],
  aging_days: [['-1', 'whole number'], ['five', 'whole number']],
  cycle_time_excludes_hold: [['yes', 'true or false']],
  start_requires_sprint: [['1', 'true or false']],
  ready_gate: [
    ['DOR1 all field_present:nonesuch A field that is not one', 'nonesuch'],
    ['DOR1 all field_present:severity A story has no severity', 'severity'],
    ['DOR1 all field_present:title A title|DOR1 story estimate_set Estimated', 'twice'],
    ['DOR1 all no_such_check The check does not exist', 'no_such_check'],
    ['DOR1 nonesuch field_present:title A title', 'nonesuch'],
    ['DOR1 all field_present:title', 'is not'],
    ['', 'names no rule'],
  ],
  done_gate: [['DOD1 all field_is_true:nonesuch Not a field', 'nonesuch']],
}

describe('the configuration dictionary accepts what its keys name', () => {
  it('parses one accepted value per key, and the table covers the closed set', () => {
    assert.deepEqual(Object.keys(ACCEPTED).sort(), [...CONFIG_KEYS].sort())
    for (const key of CONFIG_KEYS) {
      const parsed = parseConfigValue(key, ACCEPTED[key])
      assert.equal(parsed.ok, true, `${key} refused ${ACCEPTED[key]}: ${parsed.ok ? '' : parsed.error.message}`)
    }
  })

  it('round-trips every accepted value: parse, render, parse again', () => {
    for (const key of CONFIG_KEYS) {
      const parsed = parseConfigValue(key, ACCEPTED[key])
      assert.equal(parsed.ok, true)
      if (!parsed.ok) continue
      const config = withConfigKey(defaultConfig(), key, parsed.value)
      const rendered = configLine(key, config)
      const again = parseConfigValue(key, rendered)
      assert.equal(again.ok, true, `${key} rendered ${rendered}, which does not parse back`)
      if (!again.ok) continue
      assert.equal(configLine(key, withConfigKey(defaultConfig(), key, again.value)), rendered,
        `${key} is not a fixed point: a second render of the same value differs`)
    }
  })

  it('renders every default to text that parses back to the same default', () => {
    const base = defaultConfig()
    for (const key of CONFIG_KEYS) {
      const rendered = configLine(key, base)
      const parsed = parseConfigValue(key, rendered)
      assert.equal(parsed.ok, true, `the default of ${key} renders as ${rendered}, which does not parse`)
      if (!parsed.ok) continue
      assert.equal(configLine(key, withConfigKey(base, key, parsed.value)), rendered)
    }
  })

  it('refuses a wrong value per key, naming what it refused', () => {
    assert.deepEqual(Object.keys(REFUSED).sort(), [...CONFIG_KEYS].sort())
    for (const key of CONFIG_KEYS) {
      for (const [value, named] of REFUSED[key]) {
        const parsed = parseConfigValue(key, value)
        assert.equal(parsed.ok, false, `${key} accepted ${JSON.stringify(value)}, which it should refuse`)
        if (parsed.ok) continue
        assert.ok(parsed.error.message.includes(named),
          `${key} refused ${JSON.stringify(value)} with "${parsed.error.message}", which does not name ${named}`)
        assert.ok(/^V[678]$/.test(parsed.error.rule ?? ''),
          `${key} refused ${JSON.stringify(value)} under rule ${String(parsed.error.rule)}, and a configuration refusal is V6, V7 or V8`)
      }
    }
  })

  it('takes a zero limit and a zero threshold, which is what disarms G3 and H03', () => {
    for (const [key, text] of [['wip_limits', 'in_progress=0'], ['aging_days', '0']] as const) {
      const parsed = parseConfigValue(key, text)
      assert.equal(parsed.ok, true, `${key} refused ${text}`)
    }
  })

  // The record grammar refuses a field line with an empty value, so an empty list needs a
  // spelling of its own or a workspace that reviews no type and one that never said so
  // become the same file.
  it('spells an empty list with the unset marker, both ways', () => {
    for (const key of ['review_step', 'wip_limits'] as const) {
      const parsed = parseConfigValue(key, '-')
      assert.equal(parsed.ok, true, `${key} refused the unset marker`)
      if (!parsed.ok) continue
      assert.equal(configLine(key, withConfigKey(defaultConfig(), key, parsed.value)), '-')
    }
    const blank = parseConfigValue('review_step', '')
    assert.equal(blank.ok, false, 'an empty review_step is a line the record grammar cannot hold')
  })
})

describe('the configurable vocabulary is the vocabulary the evaluator runs', () => {
  // A name in `CHECK_NAMES` that `checkOf` cannot build, or that the evaluator's switch
  // cannot run, fails here: each name is parsed into a real one-rule gate and handed to the
  // real evaluator, rather than compared against a second list.
  const FIELD_TAKING = new Set(['field_present', 'field_non_empty_list', 'list_all_ticked', 'field_is_true'])

  it('parses and evaluates every check CHECK_NAMES names, through parseConfigValue and evaluateGate', () => {
    assert.ok(CHECK_NAMES.length >= 10, `only ${CHECK_NAMES.length} checks are named`)
    for (const name of CHECK_NAMES) {
      const spelled = FIELD_TAKING.has(name) ? `${name}:title` : name === 'child_present' ? `${name}:task` : name
      const text = `T1 all ${spelled} a rule naming the check ${name}`
      const parsed = parseConfigValue('ready_gate', text)
      assert.equal(parsed.ok, true, `${name} did not parse: ${parsed.ok ? '' : parsed.error.message}`)
      if (!parsed.ok) continue
      const verdict = evaluateGate(parsed.value as Gate, gateContext(item('task')))
      assert.equal(verdict.rules.length, 1, `${name} produced ${verdict.rules.length} rule verdicts, not one`)
      assert.equal(verdict.rules[0]?.rule, 'T1')
      assert.equal(typeof verdict.rules[0]?.pass, 'boolean', `${name} did not report a pass/fail verdict`)
    }
  })

  it('names every component of the score next weights may set', () => {
    const line = configLine('next_weights', defaultConfig())
    assert.deepEqual(line.split(', ').map((pair) => pair.split('=')[0]), [...WEIGHT_NAMES])
  })
})
