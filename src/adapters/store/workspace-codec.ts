// SPDX-License-Identifier: Apache-2.0
// The workspace record to a value and back, over the one record grammar every file in the
// store shares. It is the item codec's shape over the configuration dictionary: the
// grammar knows lines, and this file knows which keys are single-line, that the two gates
// are H2 sections, and the order a rendered workspace record takes.
//
// DR2 always drew this file as carrying "the workspace id, name, flow mode, gates, columns,
// people, components", and until now it carried `created_at` alone. Adding optional fields
// and two named sections to a record file is the additive change ADR-0003 says never bumps
// the schema, so a workspace written by an older build reads here with every key defaulted
// and a workspace written here reads there as the record it always was plus lines that build
// preserves verbatim.

import {
  CONFIG_KEYS,
  GATE_SECTIONS,
  configLine,
  defaultConfig,
  isConfigKey,
  isGateKey,
  parseConfigValue,
  renderGateRules,
  type ConfigKey,
  type WorkspaceConfig,
} from '../../domain/index.ts'
import { storeFail, storeOk, type StoreResult } from '../../application/ports/store.ts'
import type { ParsedRecord, Section } from './grammar.ts'

/** The record's own field, written by `init` and never changed. */
const CREATED_AT = 'created_at'

/**
 * The workspace record's compare-and-set token, absent on every workspace written before
 * `config set` existed. Absent reads as zero and the first write puts `version: 1` on the
 * record, which is the same token an item carries and the same refusal (`S10`)
 * when two writers race.
 */
const VERSION = 'version'

/** The single-line fields, in render order; the two gates follow as sections. */
const FIELD_ORDER: readonly string[] = [
  CREATED_AT,
  VERSION,
  ...CONFIG_KEYS.filter((key) => !isGateKey(key)),
]

const KNOWN: ReadonlySet<string> = new Set([CREATED_AT, VERSION, ...CONFIG_KEYS])
const SECTION_NAMES: ReadonlySet<string> = new Set(Object.values(GATE_SECTIONS))

export type WorkspaceRecord = {
  readonly id: string
  readonly name: string
  readonly created_at?: string
  readonly version: number
  readonly config: WorkspaceConfig
  /** Field keys a newer writer produced that this build has no meaning for (DR3). */
  readonly extra: ReadonlyMap<string, string>
}

/**
 * The workspace record as it is stored. A key this build knows and cannot read is a refusal
 * naming the key: an `aging_days` of "banana" cannot be defaulted quietly, because the
 * estimate check would then accept a set the file does not name. A key it does not know is
 * carried forward untouched, which is the same forward-compatibility rule the item and
 * item codec keeps, and `config set` is where the key set is closed.
 */
export function decodeWorkspace(record: ParsedRecord): StoreResult<WorkspaceRecord> {
  let config = defaultConfig()
  const from = new Set<ConfigKey>()
  const extra = new Map<string, string>()
  let createdAt: string | undefined
  let version = 0

  const refuse = (rule: string, reason: string): StoreResult<WorkspaceRecord> =>
    storeFail('VALIDATION', rule, `${record.id}: ${reason}`, [record.id])

  for (const [key, value] of record.fields) {
    if (key === CREATED_AT) { createdAt = value; continue }
    if (key === VERSION) {
      if (!/^\d{1,15}$/.test(value)) return refuse('S1', `${VERSION} must be a whole number, not "${value}"`)
      version = Number(value)
      continue
    }
    // A field line spelling a gate is a newer writer's key rather than one of ours: the two
    // gates are sections here, and reading a one-line gate would be a second grammar.
    if (!isConfigKey(key) || isGateKey(key)) { extra.set(key, value); continue }
    const parsed = parseConfigValue(key, value)
    if (!parsed.ok) return refuse(parsed.error.rule ?? 'S1', parsed.error.message)
    config = { ...config, [key]: parsed.value } as WorkspaceConfig
    from.add(key)
  }

  for (const key of ['ready_gate', 'done_gate'] as const) {
    const section = record.sections.find((entry) => entry.name === GATE_SECTIONS[key])
    if (section === undefined) continue
    const parsed = parseConfigValue(key, section.body)
    // `V6` and `V7` are `validateGate`'s own ids and travel outward unchanged, so the rule a
    // `doctor` row prints for a hand-edited gate is the rule `config set` refuses it with.
    if (!parsed.ok) return refuse(parsed.error.rule ?? 'S1', parsed.error.message)
    config = { ...config, [key]: parsed.value } as WorkspaceConfig
    from.add(key)
  }

  return storeOk({
    id: record.id,
    name: record.title,
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    version,
    config: { ...config, from },
    extra,
  })
}

export type EncodedWorkspace = {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
}

/**
 * One workspace record to one record. Only the keys this workspace set are written, so a
 * file records what a team chose rather than the whole default table, and `config` is where
 * the effective value and its source are read. Unknown keys and unknown sections travel
 * from the stored record unchanged (DR3).
 */
export function encodeWorkspace(record: WorkspaceRecord, base?: ParsedRecord): EncodedWorkspace {
  const fields = new Map<string, string>()
  for (const key of FIELD_ORDER) {
    if (key === CREATED_AT) {
      if (record.created_at !== undefined) fields.set(key, record.created_at)
      continue
    }
    if (key === VERSION) { fields.set(key, String(record.version)); continue }
    const configKey = key as ConfigKey
    if (!record.config.from.has(configKey)) continue
    fields.set(key, configLine(configKey, record.config))
  }
  for (const [key, value] of base?.fields ?? new Map<string, string>()) {
    if (!KNOWN.has(key) && !fields.has(key)) fields.set(key, value)
  }
  for (const [key, value] of record.extra) if (!fields.has(key)) fields.set(key, value)

  const sections: Section[] = []
  for (const key of ['ready_gate', 'done_gate'] as const) {
    if (!record.config.from.has(key)) continue
    sections.push({ name: GATE_SECTIONS[key], body: renderGateRules(record.config[key]).join('\n') })
  }
  for (const section of base?.sections ?? []) {
    if (!SECTION_NAMES.has(section.name)) sections.push(section)
  }
  return { id: record.id, title: record.name, fields, sections }
}
