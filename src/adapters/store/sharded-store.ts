// SPDX-License-Identifier: Apache-2.0
// DR2's store: a directory of month-sharded record files, an append-only monthly event log
// and a gitignored SQLite index that is re-derived from a size, mtime and content-hash
// fingerprint before any query runs.
//
// The committed files are the authority (decision D1). Every read establishes freshness
// first, one corrupt record is quarantined rather than costing the file, and a mutation
// re-reads what it touches under the lock, so the tool never writes from stale memory and
// never overwrites a hand edit it did not see.

import { createHash } from 'node:crypto'
import { mkdir, open as openFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  findHierarchyCycle,
  hierarchyFrom,
  type WorkItem,
} from '../../domain/index.ts'
import {
  storeFail,
  storeOk,
  type Applied,
  type AppliedWrite,
  type EventQuery,
  type Finding,
  type ItemQuery,
  type Store,
  type StoreError,
  type StoreEvent,
  type StoreIdentity,
  type StoreResult,
  type StoreTransaction,
} from '../../application/ports/store.ts'
import { DIR_MODE, appendAndSync, isTempName, sweepTempFiles, writeFileAtomic } from './atomic.ts'
import { eventIdsInTail, renderEvent, scanEventFile } from './event-log.ts'
import {
  parseFile,
  parseRecordSource,
  renderFile,
  renderHeader,
  renderRecord,
  type Chunk,
  type ParsedFile,
  type ParsedRecord,
} from './grammar.ts'
import { IndexCache, type Fingerprint, type IndexedItem } from './index-cache.ts'
import { decodeItem, encodeItem } from './item-codec.ts'
import { MAX_EVENT_FILE_BYTES, MAX_EVENT_LINE_BYTES, MAX_FILE_BYTES } from './limits.ts'
import { acquireLock, type AcquireOptions } from './lock.ts'

/** The one compiled-in schema number. DR3: `migrate` is the only path that changes a file's. */
export const SCHEMA = 1

export const WORKSPACE_FILE = 'workspace.md'
const ITEMS_DIR = 'items'
const EVENTS_DIR = 'events'
const INDEX_DIR = '.index'
const JOURNAL_DIR = path.join(INDEX_DIR, 'txn')
const LOCK_FILE = '.lock'

export type ShardedStoreOptions = {
  readonly lockTimeoutMs?: number
  readonly onWaiting?: AcquireOptions['onWaiting']
}

type Journal = {
  readonly txn: string
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly events: readonly { readonly path: string; readonly lines: readonly string[]; readonly ids: readonly string[] }[]
}

function monthOf(instant: string): string {
  return instant.slice(0, 7)
}

function hashOf(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Resolves the store by walking up from a directory, as DR2 specifies. Never creates one. */
export async function resolveWorkspace(from: string): Promise<string | undefined> {
  let at = path.resolve(from)
  for (;;) {
    try {
      await stat(path.join(at, WORKSPACE_FILE))
      return at
    } catch {
      const up = path.dirname(at)
      if (up === at) return undefined
      at = up
    }
  }
}

/**
 * Writes the layout DR2 draws, including the two git attributes it depends on: the index
 * and the lock are ignored because they are derived and transient, and the event log merges
 * union because two branches appending in one month must not conflict.
 */
export async function createWorkspace(
  root: string,
  workspace: { readonly id: string; readonly name: string; readonly at: string },
): Promise<StoreResult<undefined>> {
  await mkdir(path.join(root, ITEMS_DIR), { recursive: true, mode: DIR_MODE })
  await mkdir(path.join(root, EVENTS_DIR), { recursive: true, mode: DIR_MODE })
  await writeFileAtomic(
    path.join(root, WORKSPACE_FILE),
    `${renderHeader(SCHEMA)}${renderRecord({
      id: workspace.id,
      title: workspace.name,
      fields: new Map([['created_at', workspace.at]]),
      sections: [],
    })}`,
  )
  await writeFileAtomic(path.join(root, '.gitignore'), `${INDEX_DIR}/\n${LOCK_FILE}\n`)
  await writeFileAtomic(path.join(root, '.gitattributes'), `${EVENTS_DIR}/*.jsonl merge=union\n`)
  return storeOk(undefined)
}

export class ShardedStore implements Store {
  readonly #root: string
  readonly #index: IndexCache
  readonly #options: ShardedStoreOptions
  #cycleFindings: readonly Finding[] = []

  constructor(root: string, options: ShardedStoreOptions = {}) {
    this.#root = root
    this.#index = new IndexCache(path.join(root, INDEX_DIR))
    this.#options = options
  }

  async identity(): Promise<StoreResult<StoreIdentity>> {
    const file = path.join(this.#root, WORKSPACE_FILE)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return storeFail('STORE_UNAVAILABLE', 'S1', `${file} is not there, so this directory is not a treadle workspace`, [this.#root])
    }
    const parsed = parseFile(text, WORKSPACE_FILE)
    if (!parsed.ok) return parsed
    const schema = this.#schemaRefusal(parsed.value, WORKSPACE_FILE)
    if (schema !== undefined) return { ok: false, error: schema }
    const record = parsed.value.records[0]
    if (record === undefined) {
      return storeFail('INTEGRITY', 'S1', `${WORKSPACE_FILE} carries no workspace record`, [WORKSPACE_FILE])
    }
    return storeOk({ id: record.id, name: record.title, path: this.#root })
  }

  async get(id: string): Promise<StoreResult<WorkItem | undefined>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    const row = this.#index.itemRow(id)
    if (row === undefined) return storeOk(undefined)
    return this.#decodeRow(row)
  }

  async list(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItem[]>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    const items: WorkItem[] = []
    for (const row of this.#index.listItems(query)) {
      const item = this.#decodeRow(row)
      if (!item.ok) return item
      if (item.value !== undefined) items.push(item.value)
    }
    return storeOk(items)
  }

  async events(query: EventQuery = {}): Promise<StoreResult<readonly StoreEvent[]>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    return storeOk(this.#index.listEvents(query))
  }

  async findings(): Promise<StoreResult<readonly Finding[]>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    return storeOk([...this.#index.findings(), ...this.#cycleFindings])
  }

  async apply(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    const lock = await acquireLock(path.join(this.#root, LOCK_FILE), {
      ...(this.#options.lockTimeoutMs === undefined ? {} : { timeoutMs: this.#options.lockTimeoutMs }),
      ...(this.#options.onWaiting === undefined ? {} : { onWaiting: this.#options.onWaiting }),
    })
    if (!lock.ok) return lock
    try {
      await this.#recoverJournals()
      await sweepTempFiles(path.join(this.#root, ITEMS_DIR))
      return await this.#applyUnderLock(transaction)
    } finally {
      await lock.value.release()
    }
  }

  async close(): Promise<void> {
    this.#index.close()
  }

  // -- reading ---------------------------------------------------------------------------

  #decodeRow(row: IndexedItem): StoreResult<WorkItem | undefined> {
    const parsed = parseRecordSource(row.source, row.line)
    if (!parsed.ok) {
      return storeFail('INTEGRITY', parsed.rule, `${row.file} line ${row.line}: ${parsed.reason}`, [row.id])
    }
    return decodeItem(parsed.record)
  }

  #schemaRefusal(file: ParsedFile, name: string): StoreError | undefined {
    if (file.schema > SCHEMA) {
      return {
        code: 'SCHEMA_NEWER', rule: 'S8',
        message: `${name} is schema ${file.schema} and this tool understands ${SCHEMA}; every other file keeps serving`,
        entities: [name], details: { file: file.schema, tool: SCHEMA },
      }
    }
    return undefined
  }

  async #storeFiles(): Promise<readonly string[]> {
    const out: string[] = [WORKSPACE_FILE]
    for (const [dir, ext] of [[ITEMS_DIR, '.md'], [EVENTS_DIR, '.jsonl']] as const) {
      let names: string[]
      try {
        names = await readdir(path.join(this.#root, dir))
      } catch {
        continue
      }
      for (const name of names.sort()) {
        if (isTempName(name) || !name.endsWith(ext)) continue
        out.push(`${dir}/${name}`)
      }
    }
    return out
  }

  /**
   * DR2's freshness rule. A stat per file decides; only a file whose size or mtime moved is
   * re-read, and an event file that only grew has its old prefix hash checked so an append
   * costs the append rather than the file.
   */
  async #refresh(): Promise<StoreResult<undefined>> {
    const known = this.#index.fingerprints()
    const seen = new Set<string>()

    for (const file of await this.#storeFiles()) {
      const full = path.join(this.#root, file)
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      seen.add(file)
      const previous = known.get(file)
      if (previous !== undefined && previous.size === info.size && previous.mtime === info.mtimeMs) continue

      const outcome = file.endsWith('.jsonl')
        ? await this.#indexEventFile(file, full, info.size, info.mtimeMs, previous)
        : await this.#indexRecordFile(file, full, info.size, info.mtimeMs)
      if (!outcome.ok) return outcome
    }

    for (const file of known.keys()) if (!seen.has(file)) this.#index.dropFile(file)

    this.#cycleFindings = this.#hierarchyFindings()
    return storeOk(undefined)
  }

  async #indexRecordFile(
    file: string, full: string, size: number, mtime: number,
  ): Promise<StoreResult<undefined>> {
    // The ceiling is checked against the size the stat already gave us, before the file is
    // read: a limit that only fires after the read has happened is not a limit (F8).
    if (size > MAX_FILE_BYTES) {
      this.#index.replaceRecordFile(file, { size, mtime, hash: '', lines: 0 }, [], [{
        file, line: 1, rule: 'S4',
        reason: `${file} is ${size} bytes, over the ${MAX_FILE_BYTES} byte ceiling for a record file; it is not served`,
      }])
      return storeOk(undefined)
    }
    const text = await readFile(full, 'utf8')
    const parsed = parseFile(text, file)
    if (!parsed.ok) {
      this.#index.replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, [], [
        { file, line: 1, rule: parsed.error.rule, reason: parsed.error.message },
      ])
      return storeOk(undefined)
    }
    const schema = this.#schemaRefusal(parsed.value, file)
    if (schema !== undefined) {
      this.#index.replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, [], [
        { file, line: 1, rule: schema.rule, reason: schema.message },
      ])
      return storeOk(undefined)
    }

    const items: IndexedItem[] = []
    const findings: Finding[] = parsed.value.quarantined.map((q) => (q.id === undefined
      ? { file, line: q.line, rule: q.rule, reason: q.reason }
      : { file, line: q.line, rule: q.rule, reason: q.reason, id: q.id }))

    if (file !== WORKSPACE_FILE) {
      for (const record of parsed.value.records) {
        const item = decodeItem(record)
        if (!item.ok) {
          findings.push({ file, line: record.line, rule: item.error.rule, reason: item.error.message, id: record.id })
          continue
        }
        items.push(rowOf(item.value, file, record.line, record.source))
      }
    }
    if (parsed.value.crlf) {
      findings.push({ file, line: 1, rule: 'H16', reason: `${file} carries CRLF line endings; the next write to it normalises them to LF` })
    }
    this.#index.replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, items, findings)
    return storeOk(undefined)
  }

  async #indexEventFile(
    file: string, full: string, size: number, mtime: number, previous: Fingerprint | undefined,
  ): Promise<StoreResult<undefined>> {
    if (size > MAX_EVENT_FILE_BYTES) {
      this.#index.replaceEventFile(file, { size, mtime, hash: '', lines: 0 }, [], [{
        file, line: 1, rule: 'S6',
        reason: `${file} is ${size} bytes, over the ${MAX_EVENT_FILE_BYTES} byte ceiling for an event file; it is not served`,
      }], false)
      return storeOk(undefined)
    }
    const grew = previous !== undefined && size > previous.size
    const appendOnly = grew && await this.#prefixUnchanged(full, previous)

    const from = appendOnly ? (previous as Fingerprint).size : 0
    const fromLine = appendOnly ? (previous as Fingerprint).lines : 0
    const read = await scanEventFile(full, file, from, fromLine)
    if (!read.ok) {
      this.#index.replaceEventFile(file, { size, mtime, hash: '', lines: 0 }, [], [
        { file, line: 1, rule: read.error.rule, reason: read.error.message },
      ], false)
      return storeOk(undefined)
    }
    const whole = await readFile(full)
    this.#index.replaceEventFile(
      file,
      { size, mtime, hash: hashOf(whole), lines: fromLine + read.value.events.length + read.value.findings.length },
      read.value.events, read.value.findings, appendOnly,
    )
    return storeOk(undefined)
  }

  async #prefixUnchanged(full: string, previous: Fingerprint): Promise<boolean> {
    const handle = await openFile(full, 'r')
    try {
      const buffer = Buffer.alloc(previous.size)
      const { bytesRead } = await handle.read(buffer, 0, previous.size, 0)
      return bytesRead === previous.size && hashOf(buffer) === previous.hash
    } catch {
      return false
    } finally {
      await handle.close()
    }
  }

  /**
   * Load-time hierarchy validation (finding F8). A write-time cycle check cannot see an edge
   * a hand edit or a git merge put in a file, and the roll-up runs over exactly that data.
   * The graph reads five fields, so it is built from index columns rather than by decoding
   * every record on every command.
   */
  #hierarchyFindings(): readonly Finding[] {
    const items = this.#index.parentEdges().map(([id, parent, type, state, points]) => ({
      id, type, state,
      ...(parent === null ? {} : { parent_id: parent }),
      ...(points === null ? {} : { points }),
    }))
    const cycle = findHierarchyCycle(hierarchyFrom(items as unknown as readonly WorkItem[]))
    if (cycle === undefined) return []
    return [{
      file: WORKSPACE_FILE, line: 1, rule: 'S12',
      reason: `the stored hierarchy closes a cycle: ${cycle.join(' -> ')}`,
      id: cycle[0] as string,
    }]
  }

  // -- writing ---------------------------------------------------------------------------

  async #applyUnderLock(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    const shards = new Map<string, ParsedFile>()
    const applied: AppliedWrite[] = []

    for (const write of transaction.writes) {
      const file = `${ITEMS_DIR}/${monthOf(write.item.filed_at)}.md`
      const shard = shards.get(file) ?? await this.#readShard(file)
      if (!('chunks' in shard)) return shard
      shards.set(file, shard)

      const at = shard.chunks.findIndex((c) => c.kind === 'record' && c.record.id === write.item.id)
      const stored = at === -1 ? undefined : (shard.chunks[at] as { record: ParsedRecord }).record
      const conflict = await this.#compareAndSet(write.item.id, stored, write.ifVersion)
      if (conflict !== undefined) return conflict

      const version = (stored === undefined ? 0 : Number(stored.fields.get('version') ?? 0)) + 1
      const encoded = encodeItem({ ...write.item, version }, stored)
      if (!encoded.ok) return encoded

      const chunk: Chunk = { kind: 'record', record: { ...encoded.value, source: renderRecord(encoded.value), line: 0 } }
      const chunks = at === -1 ? [...shard.chunks, chunk] : shard.chunks.with(at, chunk)
      shards.set(file, { ...shard, chunks })
      applied.push({ id: write.item.id, version })
    }

    const duplicate = this.#duplicateAcrossShards(transaction, shards)
    if (duplicate !== undefined) return duplicate

    const files = [...shards].map(([file, parsed]) => ({
      path: file,
      content: renderFile({ header: parsed.header || renderHeader(SCHEMA), chunks: parsed.chunks }),
    }))
    const eventFiles = groupEvents(transaction.events)

    const journal: Journal = { txn: transaction.txn, files, events: eventFiles }
    const journalPath = path.join(this.#root, JOURNAL_DIR, `${transaction.txn}.json`)
    await mkdir(path.dirname(journalPath), { recursive: true, mode: DIR_MODE })
    await writeFileAtomic(journalPath, JSON.stringify(journal))

    await this.#applyJournal(journal)
    await rm(journalPath, { force: true })

    return storeOk({ txn: transaction.txn, writes: applied, events: transaction.events.length })
  }

  async #readShard(file: string): Promise<ParsedFile | StoreResult<never>> {
    let text: string
    try {
      text = await readFile(path.join(this.#root, file), 'utf8')
    } catch {
      return { schema: SCHEMA, header: renderHeader(SCHEMA), chunks: [], records: [], quarantined: [], crlf: false }
    }
    const parsed = parseFile(text, file)
    if (!parsed.ok) return parsed
    const newer = this.#schemaRefusal(parsed.value, file)
    if (newer !== undefined) return { ok: false, error: newer }
    if (parsed.value.schema < SCHEMA) {
      return storeFail(
        'SCHEMA_OLDER', 'S9',
        `${file} is schema ${parsed.value.schema} and this tool writes ${SCHEMA}; run migrate before writing to it`,
        [file], { file: parsed.value.schema, tool: SCHEMA },
      )
    }
    return parsed.value
  }

  /** DR4: a stale version is a structured conflict naming who moved it, never an overwrite. */
  async #compareAndSet(
    id: string, stored: ParsedRecord | undefined, ifVersion: number | undefined,
  ): Promise<StoreResult<never> | undefined> {
    const actual = stored === undefined ? undefined : Number(stored.fields.get('version') ?? 0)
    if (ifVersion === undefined) {
      if (stored === undefined) return undefined
      return storeFail('CONFLICT', 'S10', `${id} already exists at version ${actual}; a create names no version`, [id], { actual: actual as number })
    }
    if (stored === undefined) {
      return storeFail('CONFLICT', 'S10', `${id} is not in the store, so version ${ifVersion} cannot be matched`, [id], { expected: ifVersion })
    }
    if (actual === ifVersion) return undefined

    const last = this.#index.lastEventFor(id)
    const details: Record<string, string | number> = { expected: ifVersion, actual: actual as number }
    if (last !== undefined) { details['actor'] = last.actor; details['at'] = last.at; details['txn'] = last.txn }
    return storeFail(
      'CONFLICT', 'S10',
      last === undefined
        ? `${id} is at version ${actual} and the write named ${ifVersion}`
        : `${id} is at version ${actual} and the write named ${ifVersion}; ${last.actor} moved it at ${last.at} in transaction ${last.txn}`,
      [id], details,
    )
  }

  /** An id may live in exactly one shard; a create into a second month is a named refusal. */
  #duplicateAcrossShards(
    transaction: StoreTransaction, shards: ReadonlyMap<string, ParsedFile>,
  ): StoreResult<never> | undefined {
    for (const write of transaction.writes) {
      const home = `${ITEMS_DIR}/${monthOf(write.item.filed_at)}.md`
      const row = this.#index.itemRow(write.item.id)
      if (row !== undefined && row.file !== home && shards.has(home)) {
        return storeFail('CONFLICT', 'S3', `${write.item.id} is already a record in ${row.file}; a record never moves between shards`, [write.item.id])
      }
    }
    return undefined
  }

  async #applyJournal(journal: Journal): Promise<void> {
    for (const file of journal.files) {
      const full = path.join(this.#root, file.path)
      await mkdir(path.dirname(full), { recursive: true, mode: DIR_MODE })
      await writeFileAtomic(full, file.content)
    }
    for (const log of journal.events) {
      const full = path.join(this.#root, log.path)
      await mkdir(path.dirname(full), { recursive: true, mode: DIR_MODE })
      // Replay is idempotent by event id: only lines the file's tail does not already
      // carry are appended, so re-applying a journal after a crash duplicates nothing.
      const already = await eventIdsInTail(full, log.lines.length * MAX_EVENT_LINE_BYTES + 4096)
      const missing = log.lines.filter((_, at) => !already.has(log.ids[at] as string))
      if (missing.length > 0) await appendAndSync(full, missing.join(''))
    }
  }

  /** A lock holder that finds a journal re-applies it before doing its own work (DR4). */
  async #recoverJournals(): Promise<void> {
    const dir = path.join(this.#root, JOURNAL_DIR)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const full = path.join(dir, name)
      try {
        const journal = JSON.parse(await readFile(full, 'utf8')) as Journal
        await this.#applyJournal(journal)
      } catch {
        // A journal we cannot read is a journal we cannot replay; the doctor reports it.
        continue
      }
      await rm(full, { force: true })
    }
  }
}

function groupEvents(events: readonly StoreEvent[]): Journal['events'] {
  const byFile = new Map<string, { lines: string[]; ids: string[] }>()
  for (const event of events) {
    const file = `${EVENTS_DIR}/${monthOf(event.at)}.jsonl`
    const entry = byFile.get(file) ?? { lines: [], ids: [] }
    entry.lines.push(renderEvent(event))
    entry.ids.push(event.id)
    byFile.set(file, entry)
  }
  return [...byFile].map(([file, entry]) => ({ path: file, lines: entry.lines, ids: entry.ids }))
}

function rowOf(item: WorkItem, file: string, line: number, source: string): IndexedItem {
  return {
    id: item.id, file, line, type: item.type, state: item.state,
    parent: item.parent_id ?? null,
    sprint: item.sprint_id ?? null,
    points: item.points ?? null,
    priority: item.priority ?? null,
    version: item.version,
    assignee: item.assignee ?? null,
    filed_at: item.filed_at,
    title: item.title,
    source,
  }
}

export async function openWorkspace(
  root: string, options: ShardedStoreOptions = {},
): Promise<StoreResult<ShardedStore>> {
  const store = new ShardedStore(root, options)
  const identity = await store.identity()
  if (!identity.ok) return identity
  return storeOk(store)
}
