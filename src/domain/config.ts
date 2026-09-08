// SPDX-License-Identifier: Apache-2.0
// Workspace configuration: the closed key set, the compiled-in default of every key, and
// one parse and one render per key so the file, the command line, the event log and the
// `config` reading all spell a value the same way.
//
// Six things in this tree waited on this file by name, and each is a value that was a
// constant with a comment saying so: the review step G5 reads, the point scale
// `validateWorkItem` takes, `next`'s weights, G3's column limits, G4's boolean, and the
// second implementation of the Policy seam, which is a gate loaded from data and run
// through the one evaluator the built-in gates run through.
//
// Every key is optional. Absence is the default below, which is why a workspace that has
// never been configured behaves exactly as it did before this file existed, and why
// `config` prints a `source` column rather than only a value.

import { fail, ok, type Result } from './errors.ts'
import { isSafeText } from './text.ts'
import { DEFAULT_DONE_GATE, DEFAULT_READY_GATE, validateGate, type Gate, type GateCheck, type GateRule } from './gates.ts'
import { DEFAULT_POINT_SCALE, WORK_ITEM_STATES, WORK_ITEM_TYPES, type WorkItemState, type WorkItemType } from './types.ts'

/**
 * The closed set, in the order `config` prints it and the codec writes it. `ready_gate` and
 * `done_gate` are stored as sections rather than field lines, because a gate is a list of
 * rules and a field value is bounded at 8 KiB where a section is bounded at 128 KiB; every
 * other surface treats them as keys like the rest, which is what keeps `config set` one verb.
 */
export const CONFIG_KEYS = [
  'review_step',
  'point_scale',
  'next_weights',
  'wip_limits',
  'aging_days',
  'cycle_time_excludes_hold',
  'start_requires_sprint',
  'ready_gate',
  'done_gate',
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** The two keys the codec writes as an H2 section, and the section name each takes. */
export const GATE_SECTIONS: Readonly<Record<'ready_gate' | 'done_gate', string>> = {
  ready_gate: 'Ready gate',
  done_gate: 'Done gate',
}

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key)
}

export function isGateKey(key: ConfigKey): key is 'ready_gate' | 'done_gate' {
  return key === 'ready_gate' || key === 'done_gate'
}

/** The components of `next`'s score, which are the keys `next_weights` may name. */
export const WEIGHT_NAMES = ['pri', 'age', 'dep', 'spr', 'asg', 'due', 'sev'] as const
export type WeightName = (typeof WEIGHT_NAMES)[number]
export type Weights = Readonly<Record<WeightName, number>>

/**
 * Integer weights, so a score is an integer and two implementations cannot round apart.
 * `due` is four so a day past the date outranks four days of age and never a priority step:
 * a date the workspace agreed is evidence, and priority is still the thing a person set.
 * `sev` is six for the same reason read the other way: an S1 scores 4 and a priority level
 * is 10, so severity lifts a defect by at most 2.4 levels and priority stays the lever a
 * person sets. The two components answer different questions and both are printed.
 *
 * They live here rather than beside `next` because a configured workspace overrides them
 * and one table is what stops the default and the override disagreeing.
 */
export const DEFAULT_WEIGHTS: Weights = { pri: 10, age: 1, dep: 5, spr: 8, asg: 8, due: 4, sev: 6 }

export type WorkspaceConfig = {
  /** G5's input: the types whose work passes through `in_review`. */
  readonly review_step: readonly WorkItemType[]
  readonly point_scale: readonly number[]
  readonly next_weights: Weights
  /** G3's input, per target state. A state absent here is unlimited, as a limit of zero is. */
  readonly wip_limits: ReadonlyMap<WorkItemState, number>
  /** Doctor `H03`'s threshold in days. Zero disarms it, as a zero column limit disarms G3. */
  readonly aging_days: number
  readonly cycle_time_excludes_hold: boolean
  /** G4's input: with it false the guard passes, which is what ADR-0018 left it doing. */
  readonly start_requires_sprint: boolean
  readonly ready_gate: Gate
  readonly done_gate: Gate
  /** The keys this workspace's own file set, which is what `config` reports as `file`. */
  readonly from: ReadonlySet<ConfigKey>
}

const NO_KEYS: ReadonlySet<ConfigKey> = new Set()

/**
 * What every key means when the file says nothing. The two gates are the built-in ones, so
 * the Policy seam's two implementations differ in where the rules came from and in nothing
 * else: `evaluateGate` is handed one `Gate` either way.
 */
export function defaultConfig(): WorkspaceConfig {
  return {
    review_step: ['story', 'bug', 'epic'],
    point_scale: DEFAULT_POINT_SCALE,
    next_weights: DEFAULT_WEIGHTS,
    wip_limits: new Map(),
    aging_days: 0,
    cycle_time_excludes_hold: false,
    start_requires_sprint: false,
    ready_gate: DEFAULT_READY_GATE,
    done_gate: DEFAULT_DONE_GATE,
    from: NO_KEYS,
  }
}

const WHOLE = /^\d{1,9}$/

/**
 * The two list-shaped keys can legitimately name nothing - a workspace that reviews no type,
 * a workspace that limits no column - and the record grammar refuses a field line with an
 * empty value ("an absent field is an absent line"). So an empty list is spelled with this
 * tool's own unset marker, which is what `show`, `explain` and the row grammar already print
 * for a value that is not there, and every key then renders to text that parses back.
 */
const EMPTY = '-'

/** A gate rule's sentence, bounded as `MAX_LINE` bounds every other single-line value. */
const MAX_RULE_SENTENCE = 200

function refuse<T>(rule: string, message: string, key: string): Result<T> {
  return fail('VALIDATION', rule, message, [key]) as Result<T>
}

/** The `<name>=<n>` pair grammar `next_weights` and `wip_limits` share. */
function pairs(key: ConfigKey, text: string): Result<readonly (readonly [string, number])[]> {
  const out: (readonly [string, number])[] = []
  const seen = new Set<string>()
  for (const entry of text.split(',')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) {
      return refuse('V8', `${key} has an empty entry; it is a comma-separated list of <name>=<n> pairs`, key)
    }
    const at = trimmed.indexOf('=')
    const name = at === -1 ? '' : trimmed.slice(0, at)
    const value = at === -1 ? '' : trimmed.slice(at + 1)
    if (at === -1 || !WHOLE.test(value)) {
      return refuse('V8', `${key} entry "${trimmed}" is not <name>=<n> with a whole number`, key)
    }
    if (seen.has(name)) return refuse('V8', `${key} names ${name} twice, and one name carries one value`, key)
    seen.add(name)
    out.push([name, Number(value)])
  }
  return ok(out)
}

/**
 * One rule line: `<id> <scope> <check>[:<argument>] <sentence>`. The sentence is last
 * because it is the one free-text field, which is the row grammar every other line in this
 * tool follows, and it is what makes a rule parseable without quoting.
 */
function gateRule(key: ConfigKey, line: string): Result<GateRule> {
  const words = line.trim().split(/ +/)
  const [id, scope, check] = words
  const sentence = words.slice(3).join(' ')
  if (id === undefined || scope === undefined || check === undefined || sentence.length === 0) {
    return refuse('V8', `${key} rule "${line.trim()}" is not "<id> <scope> <check>[:<field>] <sentence>"`, key)
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id)) {
    return refuse('V8', `${key} rule id "${id}" is not 1 to 32 letters, digits and underscores starting with a letter`, key)
  }
  // A rule is one row of the line grammar the rest of this tool writes: `explain` prints the
  // sentence in a cell and the parser reads a rule back off one line. A tab or a bidi
  // override in it would survive the round trip and reach a terminal, so it is held to the
  // same single-line class every other value on a line is held to (F5).
  if (!isSafeText(sentence, 'line') || sentence.length > MAX_RULE_SENTENCE) {
    return refuse('V8', `${key} rule ${id} has a sentence that is not a single line of 1 to ${MAX_RULE_SENTENCE} characters with no control or bidi override characters`, key)
  }
  if (scope !== 'all' && !(WORK_ITEM_TYPES as readonly string[]).includes(scope)) {
    return refuse('V8', `${key} rule ${id} is scoped to "${scope}", which is not all or one of ${WORK_ITEM_TYPES.join(', ')}`, key)
  }
  const at = check.indexOf(':')
  const kind = at === -1 ? check : check.slice(0, at)
  const argument = at === -1 ? undefined : check.slice(at + 1)
  const built = checkOf(kind, argument)
  if (built === undefined) {
    return refuse('V8', `${key} rule ${id} names the check "${check}", and the checks are ${CHECK_NAMES.join(', ')}`, key)
  }
  return ok({ id, scope: scope as GateRule['scope'], check: built, sentence })
}

/**
 * The checks a configured rule may name, and which of them takes an argument. It is the
 * `GateCheck` union spelled once for the parser; `test/domain/config.test.ts` holds the two
 * to each other, so a check added to the union with no line here fails rather than being
 * quietly unconfigurable.
 */
const FIELD_CHECKS = ['field_present', 'field_non_empty_list', 'list_all_ticked', 'field_is_true'] as const
const BARE_CHECKS = [
  'type_required_fields', 'estimate_set', 'no_active_blocker', 'parent_present',
  'no_open_child', 'no_open_impediment', 'blocks_something', 'not_a_duplicate',
  'reviewer_distinct_from_assignee', 'evidence_present',
] as const
export const CHECK_NAMES: readonly string[] = [...FIELD_CHECKS, ...BARE_CHECKS, 'child_present']

function checkOf(kind: string, argument: string | undefined): GateCheck | undefined {
  if ((FIELD_CHECKS as readonly string[]).includes(kind)) {
    return argument === undefined || argument.length === 0
      ? undefined
      : { kind: kind as (typeof FIELD_CHECKS)[number], field: argument }
  }
  if (kind === 'child_present') {
    if (argument === undefined) return { kind: 'child_present' }
    return (WORK_ITEM_TYPES as readonly string[]).includes(argument)
      ? { kind: 'child_present', childType: argument as WorkItemType }
      : undefined
  }
  if ((BARE_CHECKS as readonly string[]).includes(kind)) {
    return argument === undefined ? { kind: kind as (typeof BARE_CHECKS)[number] } : undefined
  }
  return undefined
}

function renderRule(rule: GateRule): string {
  const check = rule.check
  const argument = 'field' in check ? check.field : check.kind === 'child_present' ? check.childType : undefined
  const spelled = argument === undefined ? check.kind : `${check.kind}:${argument}`
  return `${rule.id} ${rule.scope} ${spelled} ${rule.sentence}`
}

/** A gate's rules as the file writes them, one per line. */
export function renderGateRules(gate: Gate): readonly string[] {
  return gate.rules.map(renderRule)
}

/**
 * One key's stored text as its value. Both separators a gate accepts are here rather than
 * at the two call sites: the file writes one rule per line and a command line writes them
 * separated by `|`, which is the list syntax `set <field>=` already takes.
 */
export function parseConfigValue(key: ConfigKey, text: string): Result<unknown> {
  switch (key) {
    case 'review_step': {
      if (text.trim() === EMPTY) return ok([] as readonly WorkItemType[])
      const types = text.split(',').map((word) => word.trim()).filter((word) => word.length > 0)
      if (types.length === 0) {
        return refuse('V8', `review_step is "${text}" and it names the types that pass through review, or ${EMPTY} for none`, key)
      }
      for (const type of types) {
        if (!(WORK_ITEM_TYPES as readonly string[]).includes(type)) {
          return refuse('V8', `review_step names "${type}", which is not one of ${WORK_ITEM_TYPES.join(', ')}`, key)
        }
      }
      if (new Set(types).size !== types.length) return refuse('V8', 'review_step names a type twice', key)
      return ok(types as readonly WorkItemType[])
    }
    case 'point_scale': {
      const words = text.split(',').map((word) => word.trim())
      const scale: number[] = []
      for (const word of words) {
        if (!WHOLE.test(word)) return refuse('V8', `point_scale entry "${word}" is not a whole number`, key)
        scale.push(Number(word))
      }
      if (scale.length === 0) return refuse('V8', 'point_scale is empty, and an estimate has to be one of its values', key)
      if (new Set(scale).size !== scale.length) return refuse('V8', 'point_scale carries a value twice', key)
      return ok(scale as readonly number[])
    }
    case 'next_weights': {
      const parsed = pairs(key, text)
      if (!parsed.ok) return parsed
      const weights: Record<string, number> = { ...DEFAULT_WEIGHTS }
      for (const [name, value] of parsed.value) {
        if (!(WEIGHT_NAMES as readonly string[]).includes(name)) {
          return refuse('V8', `next_weights names "${name}", and the components are ${WEIGHT_NAMES.join(', ')}`, key)
        }
        weights[name] = value
      }
      return ok(weights as Weights)
    }
    case 'wip_limits': {
      if (text.trim() === EMPTY) return ok(new Map() as ReadonlyMap<WorkItemState, number>)
      const parsed = pairs(key, text)
      if (!parsed.ok) return parsed
      const limits = new Map<WorkItemState, number>()
      for (const [name, value] of parsed.value) {
        if (!(WORK_ITEM_STATES as readonly string[]).includes(name)) {
          return refuse('V8', `wip_limits names the column "${name}", and the states are ${WORK_ITEM_STATES.join(', ')}`, key)
        }
        limits.set(name as WorkItemState, value)
      }
      return ok(limits as ReadonlyMap<WorkItemState, number>)
    }
    case 'aging_days':
      if (!WHOLE.test(text.trim())) return refuse('V8', `aging_days is "${text}" and it is a whole number of days, zero meaning no threshold`, key)
      return ok(Number(text.trim()))
    case 'cycle_time_excludes_hold':
    case 'start_requires_sprint': {
      const word = text.trim()
      if (word !== 'true' && word !== 'false') return refuse('V8', `${key} is "${text}" and it is true or false`, key)
      return ok(word === 'true')
    }
    case 'ready_gate':
    case 'done_gate': {
      const lines = text.split(/[|\n]/).map((line) => line.trim()).filter((line) => line.length > 0)
      if (lines.length === 0) {
        return refuse('V8', `${key} names no rule; a gate section that replaces the default names at least one`, key)
      }
      const rules: GateRule[] = []
      for (const line of lines) {
        const rule = gateRule(key, line)
        if (!rule.ok) return rule
        rules.push(rule.value)
      }
      // The same check `doctor` reports as `H14` and `config set` refuses with, run in the
      // one place a gate is built from text, so the load path and the write path cannot
      // disagree about what a safe gate is.
      const gate: Gate = { name: key === 'ready_gate' ? 'ready' : 'done', rules }
      const valid = validateGate(gate)
      if (!valid.ok) return valid
      return ok(gate)
    }
  }
}

/** One key's value as the one line the command surface and the event log spell it. */
export function configLine(key: ConfigKey, config: WorkspaceConfig): string {
  switch (key) {
    case 'review_step': return config.review_step.length === 0 ? EMPTY : config.review_step.join(', ')
    case 'point_scale': return config.point_scale.join(', ')
    case 'next_weights': return WEIGHT_NAMES.map((name) => `${name}=${config.next_weights[name]}`).join(', ')
    case 'wip_limits': return config.wip_limits.size === 0 ? EMPTY : [...config.wip_limits].map(([state, limit]) => `${state}=${limit}`).join(', ')
    case 'aging_days': return String(config.aging_days)
    case 'cycle_time_excludes_hold': return String(config.cycle_time_excludes_hold)
    case 'start_requires_sprint': return String(config.start_requires_sprint)
    case 'ready_gate': return renderGateRules(config.ready_gate).join('|')
    case 'done_gate': return renderGateRules(config.done_gate).join('|')
  }
}

/** A config with one key replaced, which is what `config set` validates and writes. */
export function withConfigKey(config: WorkspaceConfig, key: ConfigKey, value: unknown): WorkspaceConfig {
  return {
    ...config,
    [key]: value,
    from: new Set([...config.from, key]),
  } as WorkspaceConfig
}

