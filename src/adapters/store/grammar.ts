// SPDX-License-Identifier: Apache-2.0
// DR3's record grammar, in both directions. One parser serves every record file the store
// owns, which is what makes "the same grammar for workspace.md, the item shards and the
// rest" true rather than asserted.
//
// Two properties this file exists to hold, both tested over generated documents rather
// than fixtures. A file the tool has not mutated re-renders byte for byte, because each
// record keeps its original bytes and is never re-rendered; and a rendered record is a
// fixed point, so parse and render agree on the canonical form.
//
// Parsing isolates per record (D1 obligation 2): a segment that breaks the grammar is
// quarantined with its file, line and reason, its bytes are still preserved for the
// round trip, and every other record in the file keeps serving.

import { FIELD_KEY_PATTERN, buildRecord, findUnsafeCharacter } from '../../domain/index.ts'
import { storeFail, storeOk, type StoreResult } from '../../application/ports/store.ts'
import {
  MAX_FIELDS_PER_RECORD,
  MAX_FIELD_VALUE_BYTES,
  MAX_FILE_BYTES,
  MAX_RECORDS_PER_FILE,
  MAX_SECTIONS_PER_RECORD,
  MAX_SECTION_BYTES,
} from './limits.ts'

/** The slug grammar of 2.14, anchored. One class per position, so it cannot backtrack. */
const RECORD_HEADING = /^([a-z0-9][a-z0-9-]{1,62}[a-z0-9]): (.+)$/
const SCHEMA_LINE = /^schema: (\d{1,9})$/

const MAX_TITLE_LENGTH = 200
const MAX_SECTION_NAME_LENGTH = 120

export type Section = { readonly name: string; readonly body: string }

export type ParsedRecord = {
  readonly id: string
  readonly title: string
  /** Field keys in the order the file carried them, values verbatim. */
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
  /** The record's original bytes, including whatever separates it from the next record. */
  readonly source: string
  /** One-based line of the record's heading. */
  readonly line: number
}

export type QuarantinedRecord = {
  readonly rule: string
  readonly reason: string
  readonly line: number
  readonly id?: string
  readonly source: string
}

export type Chunk =
  | { readonly kind: 'record'; readonly record: ParsedRecord }
  | { readonly kind: 'quarantine'; readonly quarantine: QuarantinedRecord }

export type ParsedFile = {
  readonly schema: number
  /** The schema line, any blank lines and any preamble, verbatim. */
  readonly header: string
  readonly chunks: readonly Chunk[]
  readonly records: readonly ParsedRecord[]
  readonly quarantined: readonly QuarantinedRecord[]
  /** The file arrived with CRLF terminators; DR3 rule 6 normalises it on the next write. */
  readonly crlf: boolean
}

type Line = { readonly text: string; readonly raw: string }

/** Splits so that joining every `raw` reproduces the input exactly, terminator or not. */
function splitLines(text: string): readonly Line[] {
  const out: Line[] = []
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    if (nl === -1) {
      if (start < text.length) out.push({ text: text.slice(start), raw: text.slice(start) })
      break
    }
    out.push({ text: text.slice(start, nl), raw: text.slice(start, nl + 1) })
    start = nl + 1
  }
  return out
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function quarantine(
  rule: string,
  reason: string,
  line: number,
  source: string,
  id?: string,
): Chunk {
  return {
    kind: 'quarantine',
    quarantine: id === undefined
      ? { rule, reason, line, source }
      : { rule, reason, line, source, id },
  }
}

export type SegmentOutcome = { readonly ok: true; readonly record: ParsedRecord }
  | { readonly ok: false; readonly rule: string; readonly reason: string; readonly id?: string }

function parseSegment(lines: readonly Line[], first: number): SegmentOutcome {
  const heading = (lines[0] as Line).text
  const match = RECORD_HEADING.exec(heading.slice(2))
  if (match === null) {
    return {
      ok: false,
      rule: 'S1',
      reason: 'record heading is not "# <slug>: <title>"',
    }
  }
  const id = match[1] as string
  const title = match[2] as string

  if (title.length > MAX_TITLE_LENGTH || title.trim() !== title) {
    return { ok: false, rule: 'S1', id, reason: `title must be 1 to ${MAX_TITLE_LENGTH} characters with no surrounding space` }
  }
  const unsafeTitle = findUnsafeCharacter(title, 'line')
  if (unsafeTitle !== undefined) {
    return { ok: false, rule: 'S2', id, reason: `title carries ${unsafeTitle.label} at character ${unsafeTitle.at}` }
  }

  const entries: [string, string][] = []
  const sections: Section[] = []
  let body: string[] | undefined
  let sectionName = ''

  const closeSection = (): void => {
    if (body === undefined) return
    sections.push({ name: sectionName, body: trimBlankEdges(body).join('\n') })
    body = undefined
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = (lines[i] as Line).text
    const at = first + i

    if (line.startsWith('## ')) {
      closeSection()
      sectionName = line.slice(3)
      if (sectionName.length === 0 || sectionName.length > MAX_SECTION_NAME_LENGTH || sectionName.trim() !== sectionName) {
        return { ok: false, rule: 'S1', id, reason: `line ${at}: a section name must be 1 to ${MAX_SECTION_NAME_LENGTH} characters with no surrounding space` }
      }
      const unsafeName = findUnsafeCharacter(sectionName, 'line')
      if (unsafeName !== undefined) {
        return { ok: false, rule: 'S2', id, reason: `line ${at}: section name carries ${unsafeName.label}` }
      }
      body = []
      continue
    }

    if (body !== undefined) {
      body.push(line)
      continue
    }

    if (line.length === 0) continue

    const sep = line.indexOf(': ')
    if (sep <= 0) {
      return { ok: false, rule: 'S1', id, reason: `line ${at}: expected "<key>: <value>", a "## <section>" heading or a blank line` }
    }
    const key = line.slice(0, sep)
    const value = line.slice(sep + 2)
    if (!FIELD_KEY_PATTERN.test(key)) {
      return { ok: false, rule: 'V1', id, reason: `line ${at}: the field key ${key} does not match ${FIELD_KEY_PATTERN.source}` }
    }
    if (value.length === 0 || value.trim() !== value) {
      return { ok: false, rule: 'S1', id, reason: `line ${at}: ${key} has an empty or space-padded value; an absent field is an absent line` }
    }
    if (bytes(value) > MAX_FIELD_VALUE_BYTES) {
      return { ok: false, rule: 'S5', id, reason: `line ${at}: ${key} is ${bytes(value)} bytes, over the ${MAX_FIELD_VALUE_BYTES} byte ceiling` }
    }
    const unsafe = findUnsafeCharacter(value, 'line')
    if (unsafe !== undefined) {
      return { ok: false, rule: 'S2', id, reason: `line ${at}: ${key} carries ${unsafe.label} at character ${unsafe.at}` }
    }
    entries.push([key, value])
  }
  closeSection()

  if (entries.length > MAX_FIELDS_PER_RECORD) {
    return { ok: false, rule: 'S5', id, reason: `${entries.length} fields is over the ${MAX_FIELDS_PER_RECORD} ceiling` }
  }
  if (sections.length > MAX_SECTIONS_PER_RECORD) {
    return { ok: false, rule: 'S5', id, reason: `${sections.length} sections is over the ${MAX_SECTIONS_PER_RECORD} ceiling` }
  }
  for (const section of sections) {
    if (bytes(section.body) > MAX_SECTION_BYTES) {
      return { ok: false, rule: 'S5', id, reason: `section ${section.name} is ${bytes(section.body)} bytes, over the ${MAX_SECTION_BYTES} byte ceiling` }
    }
    const unsafe = findUnsafeCharacter(section.body, 'text')
    if (unsafe !== undefined) {
      return { ok: false, rule: 'S2', id, reason: `section ${section.name} carries ${unsafe.label} at character ${unsafe.at}` }
    }
  }

  // buildRecord is the domain's one door for parsed field keys: it refuses `__proto__`,
  // `constructor` and `prototype` by name and a key that appears twice (F6, rules V2, V3).
  const record = buildRecord(entries)
  if (!record.ok) {
    return { ok: false, rule: record.error.rule ?? 'V1', id, reason: record.error.message }
  }

  return {
    ok: true,
    record: {
      id,
      title,
      fields: record.value,
      sections,
      source: lines.map((l) => l.raw).join(''),
      line: first,
    },
  }
}

function trimBlankEdges(lines: readonly string[]): readonly string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] as string).length === 0) start += 1
  while (end > start && (lines[end - 1] as string).length === 0) end -= 1
  return lines.slice(start, end)
}

/**
 * Reads one record file. A file-level refusal (no schema line, a ceiling crossed) is an
 * error; a record-level one is a quarantine, so one bad record never costs the file.
 */
export function parseFile(text: string, file: string): StoreResult<ParsedFile> {
  if (bytes(text) > MAX_FILE_BYTES) {
    return storeFail(
      'STORE_UNAVAILABLE', 'S4',
      `${file} is ${bytes(text)} bytes, over the ${MAX_FILE_BYTES} byte ceiling for a record file`,
      [file],
      { limit: MAX_FILE_BYTES, observed: bytes(text) },
    )
  }

  const crlf = text.includes('\r\n')
  const lines = splitLines(crlf ? text.replaceAll('\r\n', '\n') : text)

  const schemaMatch = lines.length === 0 ? null : SCHEMA_LINE.exec((lines[0] as Line).text)
  if (schemaMatch === null) {
    return storeFail(
      'INTEGRITY', 'S1',
      `${file} line 1 is not "schema: <n>", so it is not a record file this tool wrote`,
      [file],
    )
  }
  const schema = Number(schemaMatch[1])

  let firstRecord = lines.length
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] as Line).text.startsWith('# ')) { firstRecord = i; break }
  }

  const starts: number[] = []
  for (let i = firstRecord; i < lines.length; i += 1) {
    if ((lines[i] as Line).text.startsWith('# ')) starts.push(i)
  }
  if (starts.length > MAX_RECORDS_PER_FILE) {
    return storeFail(
      'STORE_UNAVAILABLE', 'S4',
      `${file} holds ${starts.length} records, over the ${MAX_RECORDS_PER_FILE} ceiling for one file`,
      [file],
      { limit: MAX_RECORDS_PER_FILE, observed: starts.length },
    )
  }

  const chunks: Chunk[] = []
  for (let s = 0; s < starts.length; s += 1) {
    const from = starts[s] as number
    const to = s + 1 < starts.length ? (starts[s + 1] as number) : lines.length
    const segment = lines.slice(from, to)
    const source = segment.map((l) => l.raw).join('')
    const outcome = parseSegment(segment, from + 1)
    chunks.push(outcome.ok
      ? { kind: 'record', record: outcome.record }
      : quarantine(outcome.rule, outcome.reason, from + 1, source, outcome.id))
  }

  return storeOk({
    schema,
    header: lines.slice(0, firstRecord).map((l) => l.raw).join(''),
    chunks,
    records: chunks.flatMap((c) => (c.kind === 'record' ? [c.record] : [])),
    quarantined: chunks.flatMap((c) => (c.kind === 'quarantine' ? [c.quarantine] : [])),
    crlf,
  })
}

/**
 * A section body line beginning with `#` at column 0 would re-parse as a record heading or
 * a section heading, so DR3 rule 1 refuses to write one. Read stays permissive: such a line
 * in a hand-edited file is quarantined by the segment split, never silently re-homed.
 */
export function unwritableBodyLine(body: string): string | undefined {
  return body.split('\n').find((line) => line.startsWith('#'))
}

/**
 * One record's bytes back to a record, for a caller holding the source alone: the index
 * caches the canonical source rather than the columns, so `get` returns the whole item
 * without reopening the shard.
 */
export function parseRecordSource(source: string, line: number): SegmentOutcome {
  const lines = splitLines(source)
  if (lines.length === 0 || !(lines[0] as Line).text.startsWith('# ')) {
    return { ok: false, rule: 'S1', reason: 'a record starts with "# <slug>: <title>"' }
  }
  return parseSegment(lines, line)
}

export function sourceOf(chunk: Chunk): string {
  return chunk.kind === 'record' ? chunk.record.source : chunk.quarantine.source
}

/** Byte-exact for a file the tool has not mutated, because no chunk is re-rendered. */
export function renderFile(file: { readonly header: string; readonly chunks: readonly Chunk[] }): string {
  return file.header + file.chunks.map(sourceOf).join('')
}

export function renderHeader(schema: number): string {
  return `schema: ${schema}\n\n`
}

/**
 * The canonical form of one record. Field order is the caller's, because the field
 * dictionary's order is the item codec's knowledge and not the grammar's; a section body
 * is trimmed of its blank edges here so that rendering is idempotent.
 */
export function renderRecord(record: {
  readonly id: string
  readonly title: string
  readonly fields: ReadonlyMap<string, string>
  readonly sections: readonly Section[]
}): string {
  let out = `# ${record.id}: ${record.title}\n\n`
  for (const [key, value] of record.fields) out += `${key}: ${value}\n`
  for (const section of record.sections) {
    const body = trimBlankEdges(section.body.split('\n')).join('\n')
    out += `\n## ${section.name}\n\n${body === '' ? '' : `${body}\n`}`
  }
  return `${out}\n`
}
