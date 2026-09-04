// SPDX-License-Identifier: Apache-2.0
// DR5's result object. Every command builds exactly one of these, every renderer takes one
// as its only input, and the exit status is a function of its `code` field alone. The shape
// beside it is the schema source: schemas/<command>.v<n>.json is generated from it, so the
// shipped schema and the projection a renderer performs cannot drift apart.

export const RESULT_CODES = [
  'OK',
  'VALIDATION',
  'GUARD_REFUSED',
  'CONFLICT',
  'NOT_FOUND',
  'STORE_UNAVAILABLE',
  'INTERNAL',
] as const
export type ResultCode = (typeof RESULT_CODES)[number]

export type Effect = 'read' | 'mutate'

/**
 * One column of a block. `text` marks free text that a person or an agent wrote: it renders
 * last so the row grammar's "only the last field may contain spaces" rule holds by
 * construction (F3), and its name carries the untrusted-content marker (F12).
 */
export type ColumnSpec = {
  readonly name: string
  readonly text?: true
}

/**
 * A property of a result, in the order it renders. `text` is third-party content and may
 * carry newlines; every other kind is the tool's own speech and is single-line by contract.
 */
export type PropertySpec =
  | { readonly kind: 'scalar'; readonly key: string; readonly type: 'string' | 'integer' | 'boolean' }
  | { readonly kind: 'list'; readonly key: string }
  /**
   * `whole` never truncates: a refusal's sentence and a help page's prose are not excerpts,
   * and neither is a field the store already bounds. A.4 names `title` for that second
   * reason, because the field dictionary caps it at 200 characters.
   */
  | { readonly kind: 'text'; readonly key: string; readonly whole?: true }
  | { readonly kind: 'block'; readonly key: string; readonly columns: readonly ColumnSpec[] }

export type ResultShape = {
  readonly command: string
  readonly version: number
  readonly effect: Effect
  /** The one sentence the inventory, the help page and the schema description all use. */
  readonly summary: string
  /**
   * One shape that any command's result may carry. Only the error object is one, and it is
   * why its schema pins neither the command name nor the effect: DR5's error is the result
   * object with `ok: false`, rendered by the same renderer, whichever verb produced it.
   */
  readonly anyCommand?: true
  readonly properties: readonly PropertySpec[]
}

export type Cell = string | number | null
export type Row = Readonly<Record<string, Cell>>

export type Block = {
  readonly columns: readonly ColumnSpec[]
  readonly shown: number
  readonly total: number
  readonly rows: readonly Row[]
}

export type Value = string | number | boolean | null | readonly string[] | Block

export type ResultData = Readonly<Record<string, Value>>

export type ResultObject = {
  /** `<command>/<version>`, the same string the JSON rendering carries as its `schema`. */
  readonly schema: string
  readonly ok: boolean
  readonly code: ResultCode
  readonly command: string
  /** The store identity resolved before the command ran, printed on line 1 (R5). */
  readonly workspace: string
  /** Read or mutate, declared rather than inferred from the command word (R6). */
  readonly effect: Effect
  /** A mutation's transaction id, `null` on a read and on an idempotent no-op (R4). */
  readonly txn: string | null
  /** Entities actually changed, `null` on a read. */
  readonly changed: number | null
  readonly data: ResultData
}

export type OkInput = {
  readonly workspace: string
  readonly txn?: string | null
  readonly changed?: number | null
  readonly data: ResultData
}

/** The success half of the contract: the shape names the command, the version and the effect. */
export function okResult(shape: ResultShape, input: OkInput): ResultObject {
  const mutation = shape.effect === 'mutate'
  return {
    schema: `${shape.command}/${shape.version}`,
    ok: true,
    code: 'OK',
    command: shape.command,
    workspace: input.workspace,
    effect: shape.effect,
    txn: mutation ? (input.txn ?? null) : null,
    changed: mutation ? (input.changed ?? 0) : null,
    data: input.data,
  }
}

/** The declared columns of one block property, which help and the services both read. */
export function columnsOf(shape: ResultShape, key: string): readonly ColumnSpec[] {
  const property = shape.properties.find((entry) => entry.key === key)
  return property !== undefined && property.kind === 'block' ? property.columns : []
}

export function isBlock(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The error object is the result object with `ok: false`; one shape serves every command. */
export const ERROR_SHAPE: ResultShape = {
  command: 'error',
  version: 1,
  effect: 'read',
  anyCommand: true,
  summary: 'The one refusal object every command produces on every failure path.',
  properties: [
    { kind: 'scalar', key: 'rule', type: 'string' },
    { kind: 'scalar', key: 'guard', type: 'string' },
    { kind: 'scalar', key: 'entity', type: 'string' },
    { kind: 'text', key: 'cause', whole: true },
    { kind: 'list', key: 'near' },
    { kind: 'list', key: 'fix' },
  ],
}

export type ErrorInput = {
  readonly code: Exclude<ResultCode, 'OK'>
  readonly command: string
  readonly workspace: string
  readonly effect: Effect
  /** A rule id from a closed set, so a caller looks it up instead of parsing the sentence. */
  readonly rule?: string
  readonly guard?: string
  readonly entity?: string
  /** One sentence naming the entity and the observed value. Never a restatement of the code. */
  readonly cause: string
  readonly near?: readonly string[]
  /**
   * Remediation commands, most likely first, each runnable as written. Built only from
   * bounded values: validated ids, guard ids from a closed set, and literal flag names.
   * No user-supplied free text is ever spliced into one (A.6).
   */
  readonly fix?: readonly string[]
}

export function errorResult(input: ErrorInput): ResultObject {
  const data: Record<string, Value> = {}
  if (input.rule !== undefined) data['rule'] = input.rule
  if (input.guard !== undefined) data['guard'] = input.guard
  if (input.entity !== undefined) data['entity'] = input.entity
  data['cause'] = input.cause
  if (input.near !== undefined && input.near.length > 0) data['near'] = input.near
  if (input.fix !== undefined && input.fix.length > 0) data['fix'] = input.fix
  return {
    schema: `error/${ERROR_SHAPE.version}`,
    ok: false,
    code: input.code,
    command: input.command,
    workspace: input.workspace,
    effect: input.effect,
    txn: null,
    changed: null,
    data,
  }
}
