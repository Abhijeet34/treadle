// SPDX-License-Identifier: Apache-2.0
// The append-only monthly event log (DR3): one JSON object per line, keys in a fixed order,
// `merge=union` so two branches appending in the same month merge clean.
//
// Threat-model finding F6 lands here. `JSON.parse` gives a plain object whose `__proto__`
// is an ordinary own key, which is harmless until something merges it into a target; the
// design has no rule against that sink, so this file removes the sink instead of hoping.
// Every object reconstructed from a line has a null prototype, the three prototype-slot
// keys are refused by name, and nothing is ever merged into a shared target.
//
// Finding F8 lands here too: a line is bounded before it is parsed, JSON nesting is
// bounded before it is walked, and the file is read as a bounded stream rather than whole.

import { open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

import { FORBIDDEN_FIELD_KEYS, isSafeText } from '../../domain/index.ts'
import {
  storeFail,
  storeOk,
  type Finding,
  type StoreEvent,
  type StoreResult,
} from '../../application/ports/store.ts'
import {
  MAX_EVENTS_PER_FILE,
  MAX_EVENT_FILE_BYTES,
  MAX_EVENT_LINE_BYTES,
  MAX_JSON_DEPTH,
} from './limits.ts'

/** DR3's fixed key order. A rendered line is byte-identical whoever writes it. */
const EVENT_KEYS = [
  'id', 'at', 'actor', 'actor_kind', 'entity_kind', 'entity', 'op',
  'before', 'after', 'guards', 'reason', 'outcome', 'cmd', 'txn',
] as const

const REQUIRED = ['id', 'at', 'actor', 'actor_kind', 'entity_kind', 'entity', 'op', 'txn'] as const
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/**
 * Rebuilds parsed JSON with null-prototype objects, refusing a prototype-slot key by name
 * and a nesting depth past the ceiling. Two controls for one hole, as in the domain's
 * `buildRecord`: the null prototype means there is nothing to poison, and the deny-list
 * means a later change back to a plain object cannot silently reopen it.
 */
function harden(value: unknown, depth: number): StoreResult<unknown> {
  if (depth > MAX_JSON_DEPTH) {
    return storeFail('STORE_UNAVAILABLE', 'S7', `event JSON nests deeper than the ${MAX_JSON_DEPTH} level ceiling`, [])
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const entry of value) {
      const hardened = harden(entry, depth + 1)
      if (!hardened.ok) return hardened
      out.push(hardened.value)
    }
    return storeOk(out)
  }
  if (typeof value !== 'object' || value === null) return storeOk(value)

  const out = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_FIELD_KEYS as readonly string[]).includes(key)) {
      return storeFail('VALIDATION', 'V2', `the event carries the key ${key}, which names a JavaScript prototype slot`, [])
    }
    const hardened = harden((value as Record<string, unknown>)[key], depth + 1)
    if (!hardened.ok) return hardened
    out[key] = hardened.value
  }
  return storeOk(out)
}

/** One line to one event, or a named refusal that the caller records as a finding. */
export function parseEventLine(line: string, file: string, at: number): StoreResult<StoreEvent> {
  if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
    return storeFail('STORE_UNAVAILABLE', 'S7', `${file} line ${at} is over the ${MAX_EVENT_LINE_BYTES} byte ceiling for one event`, [file])
  }
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (error) {
    return storeFail('INTEGRITY', 'S1', `${file} line ${at} is not JSON: ${(error as Error).message}`, [file])
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return storeFail('INTEGRITY', 'S1', `${file} line ${at} is not a JSON object`, [file])
  }

  const hardened = harden(raw, 0)
  if (!hardened.ok) {
    return storeFail(hardened.error.code, hardened.error.rule, `${file} line ${at}: ${hardened.error.message}`, [file])
  }
  const event = hardened.value as Record<string, unknown>

  for (const key of REQUIRED) {
    const value = event[key]
    if (typeof value !== 'string' || value.length === 0 || !isSafeText(value, 'line')) {
      return storeFail('INTEGRITY', 'S1', `${file} line ${at}: ${key} must be a non-empty single-line string`, [file])
    }
  }
  if (!INSTANT.test(event['at'] as string)) {
    return storeFail('INTEGRITY', 'S1', `${file} line ${at}: at must be an RFC 3339 instant in UTC`, [file])
  }

  return storeOk(event as unknown as StoreEvent)
}

/** The canonical line. Keys in DR3's order, no whitespace, exactly one trailing newline. */
export function renderEvent(event: StoreEvent): string {
  const ordered = Object.create(null) as Record<string, unknown>
  for (const key of EVENT_KEYS) {
    const value = (event as unknown as Record<string, unknown>)[key]
    if (value !== undefined) ordered[key] = value
  }
  return `${JSON.stringify(ordered)}\n`
}

export type EventScan = {
  readonly events: readonly StoreEvent[]
  readonly findings: readonly Finding[]
  /** Bytes consumed, so a caller can record the fingerprint it just indexed. */
  readonly bytes: number
}

/**
 * Streams one event file. The pending line is bounded before it is ever handed to the JSON
 * parser, so a single hostile line cannot be buffered without limit; `fromByte` reads only
 * the tail, which is what makes an append re-index O(the append) rather than O(the file).
 */
export async function scanEventFile(
  path: string,
  file: string,
  fromByte = 0,
  fromLine = 0,
): Promise<StoreResult<EventScan>> {
  const events: StoreEvent[] = []
  const findings: Finding[] = []
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let consumed = fromByte
  let line = fromLine

  const take = (text: string): StoreResult<never> | undefined => {
    line += 1
    if (line > MAX_EVENTS_PER_FILE) {
      return storeFail('STORE_UNAVAILABLE', 'S6', `${file} holds more than the ${MAX_EVENTS_PER_FILE} event ceiling for one file`, [file], { limit: MAX_EVENTS_PER_FILE })
    }
    if (text.length === 0) return undefined
    const event = parseEventLine(text, file, line)
    if (event.ok) events.push(event.value)
    else findings.push({ file, line, rule: event.error.rule, reason: event.error.message })
    return undefined
  }

  const stream = createReadStream(path, { start: fromByte, highWaterMark: 64 * 1024 })
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer
      consumed += buffer.byteLength
      if (consumed > MAX_EVENT_FILE_BYTES) {
        return storeFail('STORE_UNAVAILABLE', 'S6', `${file} is over the ${MAX_EVENT_FILE_BYTES} byte ceiling for an event file`, [file], { limit: MAX_EVENT_FILE_BYTES })
      }
      pending += decoder.write(buffer)
      let nl = pending.indexOf('\n')
      while (nl !== -1) {
        const refusal = take(pending.slice(0, nl))
        if (refusal !== undefined) return refusal
        pending = pending.slice(nl + 1)
        nl = pending.indexOf('\n')
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_EVENT_LINE_BYTES) {
        return storeFail('STORE_UNAVAILABLE', 'S7', `${file} carries an unterminated line over the ${MAX_EVENT_LINE_BYTES} byte ceiling`, [file], { limit: MAX_EVENT_LINE_BYTES })
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return storeOk({ events: [], findings: [], bytes: 0 })
    return storeFail('STORE_UNAVAILABLE', 'S6', `${file} could not be read: ${(error as Error).message}`, [file])
  }

  pending += decoder.end()
  if (pending.length > 0) {
    const refusal = take(pending)
    if (refusal !== undefined) return refusal
  }
  return storeOk({ events, findings, bytes: consumed })
}

/** The ids already in the file's last `window` bytes, for journal replay's idempotence. */
export async function eventIdsInTail(path: string, window: number): Promise<ReadonlySet<string>> {
  const ids = new Set<string>()
  let text: string
  try {
    const handle = await open(path, 'r')
    try {
      const size = (await handle.stat()).size
      const from = Math.max(0, size - window)
      const buffer = Buffer.alloc(size - from)
      await handle.read(buffer, 0, buffer.byteLength, from)
      text = buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ids
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as { id?: unknown }
      if (typeof parsed.id === 'string') ids.add(parsed.id)
    } catch {
      continue
    }
  }
  return ids
}
