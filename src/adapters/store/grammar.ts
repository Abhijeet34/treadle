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
//
// The third property, and the one ADR-0003 claims in its Context section: damaging or
// renaming a heading never silently changes which records exist. A record boundary is a
// line, and a line is the thing a person reformats, so the boundary cannot be made
// unreformattable; what it can be made is loud. `damagedHeadingAt` resynchronises on a
// heading a hand edit reshaped, and `parseFile` refuses an id that names more than one
// record, so this file is the one place a record's identity is decided.

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

/**
 * The field lines every record carries, whatever its type (`validateWorkItem`'s own list,
 * less the two the heading holds). Nothing else in the grammar writes these keys, which is
 * what lets a damaged heading be told apart from a line of prose that reads like one.
 */
const MANDATORY_FIELDS: readonly string[] = ['type', 'state', 'filed_at', 'version']

const MAX_TITLE_LENGTH = 200
const MAX_SECTION_NAME_LENGTH = 120
/** A heading a hand edit reshaped carries at most this much indent and this many hashes. */
const MAX_DAMAGED_INDENT = 3
const MAX_HEADING_LEVEL = 6

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
  /**
   * The file's one id-to-chunk map, and the only place a record's identity is resolved.
   * An id that names more than one chunk names none: every copy is quarantined above, so
   * this map can only point at a record or at a refusal, never at a winner picked by
   * document order. Every reader and the write path share it, which is what stops a read
   * and a write disagreeing about which record they mean.
   */
  readonly chunkById: ReadonlyMap<string, number>
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

/**
 * The record heading under an edit that reshaped it: a run of indent, a run of hashes, a
 * run of spaces, then the record grammar. Written as index arithmetic rather than a regular
 * expression because a leading `\x20*#*\x20*` before a greedy tail is the one shape in this
 * file that could backtrack, and F8's discipline is that no pattern here can.
 */
function damagedHeading(text: string): { readonly id: string; readonly title: string } | undefined {
  let at = 0
  while (at < text.length && text[at] === ' ') at += 1
  if (at > MAX_DAMAGED_INDENT) return undefined
  const from = at
  while (at < text.length && text[at] === '#') at += 1
  if (at - from > MAX_HEADING_LEVEL) return undefined
  while (at < text.length && text[at] === ' ') at += 1
  const match = RECORD_HEADING.exec(text.slice(at))
  return match === null ? undefined : { id: match[1] as string, title: match[2] as string }
}

/** Whether the lines from `at` are a record's field block rather than prose. */
function opensFieldBlock(lines: readonly Line[], at: number, to: number): boolean {
  for (let i = at; i < to; i += 1) {
    const line = (lines[i] as Line).text
    if (line.length === 0) continue
    const sep = line.indexOf(': ')
    if (sep <= 0) return false
    const key = line.slice(0, sep)
    if (!FIELD_KEY_PATTERN.test(key)) return false
    if (MANDATORY_FIELDS.includes(key)) return true
  }
  return false
}

/**
 * Where a segment hides a record heading a hand edit damaged, or undefined.
 *
 * ADR-0003 rule 1 makes `# ` at column 0 the resynchronisation point, which leaves every
 * other shape of the same edit silent: demote a heading to `## `, drop its space or drop its
 * hash and the record above absorbs the record below, taking its fields and sections as its
 * own prose while every command exits zero. Resynchronising here is what turns that into a
 * quarantine naming the absorbed record.
 *
 * Two conditions keep prose out. A candidate must be followed by a record's mandatory field
 * block, which a paragraph beginning `some-thing: a sentence` is not; and a line is exempt
 * while the record's own field block is still incomplete, so `state: draft` cannot be read as
 * a boundary just because `filed_at` follows it. A record carries its four mandatory fields
 * once, so a second block after them is a second record, whatever the line above it looks
 * like. `inRecord` is false for the file preamble, which has no field block to exempt.
 */
function damagedHeadingAt(lines: readonly Line[], from: number, to: number, inRecord: boolean): number | undefined {
  const mandatory = new Set<string>()
  for (let i = from; i < to; i += 1) {
    const line = (lines[i] as Line).text
    if (line.startsWith('## ')) {
      if (damagedHeading(line) !== undefined && opensFieldBlock(lines, i + 1, to)) return i
      continue
    }
    if (inRecord && mandatory.size < MANDATORY_FIELDS.length) {
      if (line.length === 0) continue
      const sep = line.indexOf(': ')
      const key = sep > 0 ? line.slice(0, sep) : ''
      if (sep > 0 && FIELD_KEY_PATTERN.test(key)) {
        if (MANDATORY_FIELDS.includes(key)) mandatory.add(key)
        continue
      }
    }
    if (damagedHeading(line) !== undefined && opensFieldBlock(lines, i + 1, to)) return i
  }
  return undefined
}

export type SegmentOutcome = { readonly ok: true; readonly record: ParsedRecord }
  | { readonly ok: false; readonly rule: string; readonly reason: string; readonly id?: string }

function parseSegment(lines: readonly Line[], first: number): SegmentOutcome {
  const heading = (lines[0] as Line).text
  if (!heading.startsWith('# ')) {
    // A segment `damagedHeadingAt` resynchronised on. The id is recovered from the reshaped
    // heading so the refusal names the record a person lost, not only the line it sat on.
    const damaged = damagedHeading(heading)
    const reason = 'a record heading is "# <slug>: <title>" at column 0, and this line is not'
    return damaged === undefined
      ? { ok: false, rule: 'S1', reason }
      : { ok: false, rule: 'S1', id: damaged.id, reason }
  }
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
  const sectionNames = new Set<string>()
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
      // A section name is an identity inside the record exactly as an id is one inside the
      // file, and `decodeItem` reads a section by name. Two of a name would resolve to the
      // last one silently, which is the same defect as a duplicated id one level down.
      if (sectionNames.has(sectionName)) {
        return { ok: false, rule: 'S1', id, reason: `line ${at}: the section ${sectionName} appears twice, and a section name names one value` }
      }
      sectionNames.add(sectionName)
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
  // The preamble is scanned too, because the first record's heading is the one whose damage
  // has no record above it to be absorbed into: it is absorbed into the header instead, which
  // the round trip preserves byte for byte and no finding ever mentions.
  const inHeader = damagedHeadingAt(lines, 1, firstRecord, false)
  const starts: number[] = []
  if (inHeader !== undefined) {
    firstRecord = inHeader
    starts.push(inHeader)
  }
  for (let i = firstRecord; i < lines.length; i += 1) {
    if ((lines[i] as Line).text.startsWith('# ')) starts.push(i)
  }

  // Resynchronise before the ceiling is checked, so the count the ceiling sees is the count
  // the file holds. A split segment is re-examined on the next turn of the loop, because a
  // second damaged heading can hide inside the first one's remainder.
  for (let s = 0; s < starts.length; s += 1) {
    const from = starts[s] as number
    const to = s + 1 < starts.length ? (starts[s + 1] as number) : lines.length
    const at = damagedHeadingAt(lines, from + 1, to, true)
    if (at !== undefined) starts.splice(s + 1, 0, at)
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

  return storeOk({ schema, ...resolveIdentity(chunks), header: lines.slice(0, firstRecord).map((l) => l.raw).join(''), crlf })
}

function idOf(chunk: Chunk): string | undefined {
  return chunk.kind === 'record' ? chunk.record.id : chunk.quarantine.id
}

function lineOf(chunk: Chunk): number {
  return chunk.kind === 'record' ? chunk.record.line : chunk.quarantine.line
}

/**
 * D1 obligation 4, decided once for the whole file. An id that names more than one chunk
 * names none: every copy is quarantined, so no consumer downstream has a tie left to break
 * and the store cannot serve one copy while a write moves another. Every projection of the
 * file is built from the same pass, so `chunkById`, `records` and `quarantined` cannot drift.
 */
function resolveIdentity(chunks: Chunk[]): Pick<ParsedFile, 'chunks' | 'chunkById' | 'records' | 'quarantined'> {
  const copies = new Map<string, number[]>()
  for (let i = 0; i < chunks.length; i += 1) {
    const id = idOf(chunks[i] as Chunk)
    if (id === undefined) continue
    const seen = copies.get(id)
    if (seen === undefined) copies.set(id, [i])
    else seen.push(i)
  }
  for (const [id, at] of copies) {
    if (at.length < 2) continue
    const where = at.map((i) => lineOf(chunks[i] as Chunk)).join(', ')
    for (const i of at) {
      const chunk = chunks[i] as Chunk
      chunks[i] = quarantine(
        'S3',
        `${id} names ${at.length} records in this file, at lines ${where}, so it names none of them`,
        lineOf(chunk), sourceOf(chunk), id,
      )
    }
  }
  return {
    chunks,
    chunkById: new Map([...copies].map(([id, at]) => [id, at[0] as number])),
    records: chunks.flatMap((c) => (c.kind === 'record' ? [c.record] : [])),
    quarantined: chunks.flatMap((c) => (c.kind === 'quarantine' ? [c.quarantine] : [])),
  }
}

/**
 * One record placed into a parsed file: it replaces the chunk its id names, or is appended
 * when the file does not hold it. The write path calls this rather than searching the chunks
 * itself, so a write resolves an id through exactly the map every read resolves it through.
 */
export function withRecord(file: ParsedFile, record: ParsedRecord): ParsedFile {
  const at = file.chunkById.get(record.id)
  const chunks = [...file.chunks]
  if (at === undefined) chunks.push({ kind: 'record', record })
  else chunks[at] = { kind: 'record', record }
  return { ...file, ...resolveIdentity(chunks) }
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
