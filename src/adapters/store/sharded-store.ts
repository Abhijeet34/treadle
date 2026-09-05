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
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'

import {
  cycleAbove,
  findParentCycle,
  type WorkItem,
} from '../../domain/index.ts'
import {
  duplicateRefusal,
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
  withRecord,
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
  // The return type says this reports a failure, so it has to. A path already occupied by a
  // file, a read-only parent and a full disk all arrive here as an errno, and `init`'s
  // caller already has the branch that turns one into a refusal naming the path.
  try {
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
    // `linguist-generated` collapses the log in a forge's diff view by default. It is 7.7
    // times the record bytes per mutation and no reviewer reads it line by line, so the
    // review surface becomes the shard while the log stays committed and authoritative.
    await writeFileAtomic(
      path.join(root, '.gitattributes'),
      `${EVENTS_DIR}/*.jsonl merge=union linguist-generated=true\n`,
    )
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    return storeFail(
      'STORE_UNAVAILABLE', 'S13',
      `the workspace at ${root} could not be created: ${errno.syscall ?? 'a write'} failed with ${errno.code ?? 'an error'}`,
      [root],
    )
  }
  return storeOk(undefined)
}

export class ShardedStore implements Store {
  readonly #root: string
  readonly #index: IndexCache
  readonly #options: ShardedStoreOptions
  #cycleFindings: readonly Finding[] = []
  /** Ids whose parent edge the current refresh moved, which is what it has to re-walk. */
  #movedParents: Set<string> = new Set()
  /** Whether the current refresh moved any item row at all, edge or not. */
  #rowsChanged = false
  /**
   * Shards the refresh inside `apply` re-parsed, for the write that follows it under the
   * same lock. Only the write path fills it, because a read that retained a 1 MB parse for
   * the rest of the process would pay in resident memory for something nothing reads.
   */
  #parsedUnderLock = new Map<string, { readonly size: number; readonly mtime: number; readonly parsed: ParsedFile }>()

  constructor(root: string, options: ShardedStoreOptions = {}) {
    this.#root = root
    this.#index = new IndexCache(path.join(root, INDEX_DIR))
    this.#options = options
  }

  async identity(): Promise<StoreResult<StoreIdentity>> {
    const file = path.join(this.#root, WORKSPACE_FILE)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(file)
    } catch {
      return storeFail('STORE_UNAVAILABLE', 'S1', `${file} is not there, so this directory is not a treadle workspace`, [this.#root])
    }
    if (info.size > MAX_FILE_BYTES) {
      return storeFail(
        'STORE_UNAVAILABLE', 'S4',
        `${file} is ${info.size} bytes, over the ${MAX_FILE_BYTES} byte ceiling for a record file; it is not served`,
        [this.#root],
      )
    }
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
      // Freshness first, inside the lock: the conflict message and the cross-shard id check
      // both read the index, and a check that decides a refusal may not read a stale cache.
      const fresh = await this.#refresh(true)
      if (!fresh.ok) return fresh
      return await this.#applyUnderLock(transaction)
    } catch (error) {
      // The signature says every failure leaves as a result, so an errno the filesystem
      // raised has to as well: a read-only shard directory or a full disk is the store being
      // unavailable, not an exception for the caller to guess at. The journal the write left
      // behind is what the next apply replays, so nothing is lost by refusing here.
      const errno = error as NodeJS.ErrnoException
      if (typeof errno.code !== 'string' || typeof errno.syscall !== 'string') throw error
      return storeFail(
        'STORE_UNAVAILABLE', 'S13',
        `the transaction ${transaction.txn} could not be written: ${errno.syscall} failed with ${errno.code}${errno.path === undefined ? '' : ` on ${errno.path}`}`,
        [transaction.txn],
      )
    } finally {
      this.#parsedUnderLock.clear()
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
  async #refresh(keepParses = false): Promise<StoreResult<undefined>> {
    const known = this.#index.fingerprints()
    const seen = new Set<string>()
    const moved = new Set<string>()
    this.#parsedUnderLock.clear()
    this.#movedParents = moved
    this.#rowsChanged = false

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
        : await this.#indexRecordFile(file, full, info.size, info.mtimeMs, keepParses)
      if (!outcome.ok) return outcome
    }

    for (const file of known.keys()) if (!seen.has(file)) this.#index.dropFile(file)

    this.#cycleFindings = this.#hierarchyFindings()
    return storeOk(undefined)
  }

  /** The S12 finding a cycle raises, from the verdict this refresh is entitled to reuse. */
  #hierarchyFindings(): readonly Finding[] {
    const cycle = this.#hierarchyCycle()
    if (cycle === null || cycle === undefined) return []
    return [{
      file: WORKSPACE_FILE, line: 1, rule: 'S12',
      reason: `the stored hierarchy closes a cycle: ${cycle.join(' -> ')}`,
      id: cycle[0] as string,
    }]
  }

  async #indexRecordFile(
    file: string, full: string, size: number, mtime: number, keepParse = false,
  ): Promise<StoreResult<undefined>> {
    // The ceiling is checked against the size the stat already gave us, before the file is
    // read: a limit that only fires after the read has happened is not a limit (F8).
    if (size > MAX_FILE_BYTES) {
      this.#replaceRecordFile(file, { size, mtime, hash: '', lines: 0 }, [], [{
        file, line: 1, rule: 'S4',
        reason: `${file} is ${size} bytes, over the ${MAX_FILE_BYTES} byte ceiling for a record file; it is not served`,
      }])
      return storeOk(undefined)
    }
    const text = await readFile(full, 'utf8')
    const parsed = parseFile(text, file)
    if (!parsed.ok) {
      this.#replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, [], [
        { file, line: 1, rule: parsed.error.rule, reason: parsed.error.message },
      ])
      return storeOk(undefined)
    }
    const schema = this.#schemaRefusal(parsed.value, file)
    if (schema !== undefined) {
      this.#replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, [], [
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
    this.#replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, items, findings)
    if (keepParse) this.#parsedUnderLock.set(file, { size, mtime, parsed: parsed.value })
    return storeOk(undefined)
  }

  /** Re-indexes one record file and keeps the parent edges it moved, for the cycle check. */
  #replaceRecordFile(
    file: string, fingerprint: Fingerprint, items: readonly IndexedItem[], findings: readonly Finding[],
  ): void {
    const outcome = this.#index.replaceRecordFile(file, fingerprint, items, findings)
    if (outcome.changed) this.#rowsChanged = true
    for (const id of outcome.movedParents) this.#movedParents.add(id)
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
    if (previous.size === 0) return true
    const hash = createHash('sha256')
    let read = 0
    try {
      for await (const chunk of createReadStream(full, { start: 0, end: previous.size - 1 })) {
        hash.update(chunk as Buffer)
        read += (chunk as Buffer).byteLength
      }
    } catch {
      return false
    }
    return read === previous.size && hash.digest('hex') === previous.hash
  }

  /**
   * Load-time hierarchy validation (finding F8). A write-time cycle check cannot see an edge
   * a hand edit or a git merge put in a file, and the roll-up runs over exactly that data.
   * The walk needs the parent edges and nothing else, so it reads two index columns rather
   * than decoding every record.
   *
   * The verdict is then written back beside the rows it came from. Every transaction that
   * moves an item row drops it, so this recomputes exactly when the row set moved: at 50,000
   * items the walk is 111 ms of a 218 ms read, and a command that changed nothing was paying
   * it to reach the same answer as the command before it.
   */
  #recheckHierarchy(): readonly string[] | null {
    const cycle = findParentCycle(this.#index.parentEdges()) ?? null
    this.#index.setHierarchyVerdict(JSON.stringify(cycle))
    return cycle
  }

  /**
   * The verdict this refresh is entitled to, at the cost the refresh's own findings earn.
   *
   * A refresh that moved no parent edge reuses the stored verdict. One that moved some, over
   * a store already known to be acyclic, walks up from those nodes alone: a cycle that was
   * not there before has to pass through an edge that moved.
   *
   * A store already reported cyclic recomputes whole as soon as any row moves, edge or not.
   * An edit clears a cycle as easily as it closes one, and dropping the edge that closed it
   * moves no edge at all, so a rule that watched only for moved edges would report a cycle
   * that a hand edit had already removed.
   */
  #hierarchyCycle(): readonly string[] | null {
    const stored = this.#index.hierarchyVerdict()
    if (stored === undefined) return this.#recheckHierarchy()
    const known = JSON.parse(stored) as readonly string[] | null
    if (known !== null) return this.#rowsChanged ? this.#recheckHierarchy() : known
    if (this.#movedParents.size === 0) return known
    for (const id of this.#movedParents) {
      const cycle = cycleAbove(id, (at) => this.#index.parentOf(at))
      if (cycle !== undefined) {
        this.#index.setHierarchyVerdict(JSON.stringify(cycle))
        return cycle
      }
    }
    return null
  }

  // -- writing ---------------------------------------------------------------------------

  async #applyUnderLock(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    const shards = new Map<string, ParsedFile>()
    const applied: AppliedWrite[] = []
    const findings = this.#index.findings()

    for (const write of transaction.writes) {
      const file = `${ITEMS_DIR}/${monthOf(write.item.filed_at)}.md`
      const shard = shards.get(file) ?? await this.#readShard(file)
      if (!('chunks' in shard)) return shard
      shards.set(file, shard)

      const resolved = this.#resolve(write.item.id, file, shard, findings)
      if (!resolved.ok) return resolved
      const stored = resolved.value
      const conflict = await this.#compareAndSet(write.item.id, stored, write.ifVersion)
      if (conflict !== undefined) return conflict

      const version = (stored === undefined ? 0 : Number(stored.fields.get('version') ?? 0)) + 1
      const encoded = encodeItem({ ...write.item, version }, stored)
      if (!encoded.ok) return encoded

      shards.set(file, withRecord(shard, { ...encoded.value, source: renderRecord(encoded.value), line: 0 }))
      applied.push({ id: write.item.id, version })
    }

    const files = [...shards].map(([file, parsed]) => ({
      path: file,
      content: renderFile({ header: parsed.header || renderHeader(SCHEMA), chunks: parsed.chunks }),
    }))
    const eventFiles = groupEvents(transaction.events)

    const journal: Journal = { txn: transaction.txn, files, events: eventFiles }
    const journalPath = path.join(this.#root, JOURNAL_DIR, `${transaction.txn}.json`)
    await mkdir(path.dirname(journalPath), { recursive: true, mode: DIR_MODE })
    await writeFileAtomic(journalPath, JSON.stringify(journal))

    await this.#applyJournal(journal, false)
    await rm(journalPath, { force: true })

    return storeOk({ txn: transaction.txn, writes: applied, events: transaction.events.length })
  }

  async #readShard(file: string): Promise<ParsedFile | StoreResult<never>> {
    const full = path.join(this.#root, file)
    // The refresh that ran a moment ago, under this same lock, may already have parsed this
    // shard. A stat is what proves the bytes have not moved since, and it is what the
    // freshness rule uses everywhere else, so reusing that parse re-reads nothing the rule
    // does not already treat as unchanged.
    const kept = this.#parsedUnderLock.get(file)
    if (kept !== undefined) {
      const now = await stat(full).catch(() => undefined)
      if (now !== undefined && now.size === kept.size && now.mtimeMs === kept.mtime) {
        return this.#writableShard(kept.parsed, file)
      }
    }
    let text: string
    try {
      text = await readFile(full, 'utf8')
    } catch {
      return { schema: SCHEMA, header: renderHeader(SCHEMA), chunks: [], chunkById: new Map(), records: [], quarantined: [], crlf: false }
    }
    const parsed = parseFile(text, file)
    if (!parsed.ok) return parsed
    const newer = this.#schemaRefusal(parsed.value, file)
    if (newer !== undefined) return { ok: false, error: newer }
    return this.#writableShard(parsed.value, file)
  }

  /** DR3: a file this tool writes has to be at this tool's schema, in either direction. */
  #writableShard(parsed: ParsedFile, file: string): ParsedFile | StoreResult<never> {
    const newer = this.#schemaRefusal(parsed, file)
    if (newer !== undefined) return { ok: false, error: newer }
    if (parsed.schema < SCHEMA) {
      return storeFail(
        'SCHEMA_OLDER', 'S9',
        `${file} is schema ${parsed.schema} and this tool writes ${SCHEMA}; run migrate before writing to it`,
        [file], { file: parsed.schema, tool: SCHEMA },
      )
    }
    return parsed
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

  /**
   * The store's one answer to "which record does this id name", and the only place the write
   * path resolves an identity. It replaced three mechanisms that tie-broke differently: a
   * scan that took the first record chunk in document order, a separate consult of the
   * duplicate finding, and a separate cross-shard check.
   *
   * The two owners it reads are the two that already refuse a duplicate. In-file it is the
   * parser's `chunkById`, which quarantines every copy of a repeated id rather than naming a
   * winner; across shards it is the index's `id text primary key`, whose refusal is the S3
   * finding. A chunk the parser quarantined for any other reason is a record the read path
   * does not serve, so a write to it is refused too: without that, a create found no record
   * chunk and filed a second copy of the id into the same shard.
   */
  #resolve(
    id: string, home: string, shard: ParsedFile, findings: readonly Finding[],
  ): StoreResult<ParsedRecord | undefined> {
    const clash = duplicateRefusal(id, findings)
    if (clash !== undefined) return clash

    const at = shard.chunkById.get(id)
    const chunk = at === undefined ? undefined : shard.chunks[at]
    if (chunk !== undefined && chunk.kind === 'quarantine') {
      return storeFail(
        'CONFLICT', chunk.quarantine.rule,
        `${id} is a record ${home} does not serve, so a write cannot say what it is changing: line ${chunk.quarantine.line}: ${chunk.quarantine.reason}`,
        [id],
      )
    }

    const row = this.#index.itemRow(id)
    if (row !== undefined && row.file !== home) {
      return storeFail('CONFLICT', 'S3', `${id} is already a record in ${row.file}; a record never moves between shards`, [id])
    }
    return storeOk(chunk === undefined ? undefined : chunk.record)
  }

  async #applyJournal(journal: Journal, recovering: boolean): Promise<void> {
    for (const file of journal.files) {
      const full = path.join(this.#root, file.path)
      await mkdir(path.dirname(full), { recursive: true, mode: DIR_MODE })
      await writeFileAtomic(full, file.content)
    }
    for (const log of journal.events) {
      const full = path.join(this.#root, log.path)
      await mkdir(path.dirname(full), { recursive: true, mode: DIR_MODE })
      // Replay is idempotent by event id: on recovery only lines the file's tail does not
      // already carry are appended, so re-applying a journal after a crash duplicates
      // nothing. On the first pass every line is new, and reading the log back to prove it
      // would make every write cost the size of the log.
      const already = recovering
        ? await eventIdsInTail(full, log.lines.length * MAX_EVENT_LINE_BYTES + 4096)
        : new Set<string>()
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
        await this.#applyJournal(journal, true)
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
