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
import { lstat, mkdir, readFile, readdir, readlink, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'

import {
  cycleAbove,
  findParentCycle,
  type BugSeverity,
  type Resolution,
  type StoredRelation,
  type Sprint,
  type WorkItem,
  type WorkItemState,
  type WorkItemSummary,
  type WorkItemType,
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
import { IndexBusy, IndexCache, IndexUnavailable, type Fingerprint, type IndexedItem, type IndexedSource, type IndexedSprint, type SummaryRow } from './index-cache.ts'
import { decodeItem, encodeItem } from './item-codec.ts'
import { decodeSprint, encodeSprint } from './sprint-codec.ts'
import { MAX_EVENT_FILE_BYTES, MAX_EVENT_LINE_BYTES, MAX_FILE_BYTES } from './limits.ts'
import { acquireLock, type AcquireOptions, type LockHandle } from './lock.ts'

/** The one compiled-in schema number. DR3: `migrate` is the only path that changes a file's. */
export const SCHEMA = 1

export const WORKSPACE_FILE = 'workspace.md'
/**
 * Every sprint, in one file beside the shards. A sprint spans months, so a month key would
 * be a lie about it, and there are few enough that one file is read whole (ADR-0016).
 */
export const SPRINTS_FILE = 'sprints.md'
/** A read keeps no parse: only `apply` names the shards whose parse it will reuse. */
const NO_FILES: ReadonlySet<string> = new Set()
const ITEMS_DIR = 'items'
const EVENTS_DIR = 'events'
const INDEX_DIR = '.index'
const JOURNAL_DIR = path.join(INDEX_DIR, 'txn')
const LOCK_FILE = '.lock'

/**
 * Every path the store creates or follows below its root, checked with `lstat` before any
 * of them is read or written. A workspace is a committed directory and git materialises a
 * symbolic link on checkout, so a clone can carry `items -> ../../somewhere`; following it
 * would put every write outside the directory `init` promised to stay inside. The root
 * itself is on the list because the walk that found it went through `stat`.
 */
const LAYOUT = ['.', WORKSPACE_FILE, ITEMS_DIR, EVENTS_DIR, INDEX_DIR, JOURNAL_DIR] as const

export type ShardedStoreOptions = {
  readonly lockTimeoutMs?: number
  readonly onWaiting?: AcquireOptions['onWaiting']
  /**
   * Forget every fingerprint before the first refresh, so every answer this store gives is
   * re-derived from the files rather than served from what the index held. `doctor` opens
   * with it: its answer is a verdict on the files, and a verdict served from a cache that
   * disagreed with them once locked a workspace with no printed way back (ADR-0020).
   */
  readonly rederive?: boolean
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
  /** Set from `rederive`, and spent by the first refresh. */
  #rederive: boolean
  #cycleFindings: readonly Finding[] = []
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
    this.#rederive = options.rederive === true
  }

  async identity(): Promise<StoreResult<StoreIdentity>> {
    const layout = await this.#checkLayout()
    if (layout !== undefined) return layout
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
    const items: WorkItem[] = []
    const scanned = await this.eachItem(query, (item) => items.push(item))
    return scanned.ok ? storeOk(items) : scanned
  }

  async eachItem(query: ItemQuery, visit: (item: WorkItem) => void): Promise<StoreResult<number>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    let visited = 0
    for (const row of this.#index.listItems(query)) {
      const item = this.#decodeRow(row)
      if (!item.ok) return item
      if (item.value === undefined) continue
      visit(item.value)
      visited += 1
    }
    return storeOk(visited)
  }

  async summaries(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItemSummary[]>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    const items: WorkItemSummary[] = []
    // SQLite hands back a fresh string per cell, so 50,000 rows carried 50,000 copies of
    // `task`. One copy of each value the bounded columns take is what the view then holds.
    const seen = new Map<string, string>()
    const intern = (value: string): string => {
      const held = seen.get(value)
      if (held !== undefined) return held
      seen.set(value, value)
      return value
    }
    for (const row of this.#index.listSummaries(query)) items.push(summaryOf(row, intern))
    return storeOk(items)
  }

  async sprints(): Promise<StoreResult<readonly Sprint[]>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    const sprints: Sprint[] = []
    for (const row of this.#index.listSprints()) {
      const parsed = parseRecordSource(row.source, row.line)
      if (!parsed.ok) return storeFail('INTEGRITY', parsed.rule, `${row.file} line ${row.line}: ${parsed.reason}`, [row.id])
      const sprint = decodeSprint(parsed.record)
      if (!sprint.ok) return sprint
      sprints.push(sprint.value)
    }
    return storeOk(sprints)
  }

  async events(query: EventQuery = {}): Promise<StoreResult<readonly StoreEvent[]>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    return storeOk([...this.#index.iterateEvents(query)])
  }

  async eachEvent(query: EventQuery, visit: (event: StoreEvent) => void): Promise<StoreResult<number>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    let visited = 0
    for (const event of this.#index.iterateEvents(query)) {
      visit(event)
      visited += 1
    }
    return storeOk(visited)
  }

  async findings(): Promise<StoreResult<readonly Finding[]>> {
    const fresh = await this.#refresh()
    if (!fresh.ok) return fresh
    return storeOk([...this.#index.findings(), ...this.#cycleFindings])
  }

  async apply(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    // Warm the index before the lock is taken. The refresh under the lock is then the delta
    // since this instant rather than a cold rebuild, which at 1.1 million events is two
    // minutes of synchronous work during which no heartbeat fires and the lock is forfeit.
    // The shards this transaction writes keep their parse from whichever refresh read them,
    // because a create after a create was parsing the largest shard twice, 25 MiB of the
    // 76 MiB one mutation allocated; `#readShard` proves the bytes have not moved before
    // reusing one.
    const writing = new Set(transaction.writes.map((write) => `${ITEMS_DIR}/${monthOf(write.item.filed_at)}.md`))
    if ((transaction.sprints ?? []).length > 0) writing.add(SPRINTS_FILE)
    const warm = await this.#refresh(writing)
    if (!warm.ok) return warm
    const lock = await acquireLock(path.join(this.#root, LOCK_FILE), {
      ...(this.#options.lockTimeoutMs === undefined ? {} : { timeoutMs: this.#options.lockTimeoutMs }),
      ...(this.#options.onWaiting === undefined ? {} : { onWaiting: this.#options.onWaiting }),
    })
    if (!lock.ok) return lock
    try {
      await this.#recoverJournals(lock.value)
      await sweepTempFiles(path.join(this.#root, ITEMS_DIR))
      // Freshness first, inside the lock: the conflict message and the cross-shard id check
      // both read the index, and a check that decides a refusal may not read a stale cache.
      const fresh = await this.#refresh(writing)
      if (!fresh.ok) return fresh
      return await this.#applyUnderLock(transaction, lock.value)
    } catch (error) {
      if (error instanceof LockLost) return error.refusal
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

  #decodeRow(row: IndexedSource): StoreResult<WorkItem | undefined> {
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
    // The sprint file is named whether or not it exists: the stat that follows skips an
    // absent one, and a file that was indexed and then removed by hand drops its rows.
    const out: string[] = [WORKSPACE_FILE, SPRINTS_FILE]
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
  async #refresh(keepParses: ReadonlySet<string> = NO_FILES): Promise<StoreResult<undefined>> {
    const layout = await this.#checkLayout()
    if (layout !== undefined) return layout
    try {
      return await this.#refreshIndex(keepParses)
    } catch (error) {
      // A busy index is a lock not acquired within its bound, and the refresh runs before
      // any file is written, so the caller can retry with nothing to undo.
      if (error instanceof IndexBusy) {
        return storeFail(
          'LOCK_TIMEOUT', 'S11',
          `the index at ${error.path} was busy for ${error.waitedMs} ms while another process wrote it; nothing was written, so retry`,
          [this.#root],
        )
      }
      if (!(error instanceof IndexUnavailable)) throw error
      return storeFail(
        'STORE_UNAVAILABLE', 'S13',
        `the index at ${error.path} could not be opened or rebuilt: ${error.message}; delete ${INDEX_DIR} and retry`,
        [this.#root],
      )
    }
  }

  /**
   * A pass re-reads every file whose fingerprint moved. A duplicate-id clash is the one
   * finding whose truth depends on a second file, so a pass that changed or dropped a file
   * other clashes name drops those files' fingerprints, and one more pass re-decides them.
   * Two files clashing both ways settle on the second pass; the bound is a guard, not a budget.
   */
  async #refreshIndex(keepParses: ReadonlySet<string>): Promise<StoreResult<undefined>> {
    // A re-derivation forgets the fingerprints and keeps the rows, so a command running
    // beside it still answers from whole files; the names are carried into the pass because
    // a file that has gone is otherwise only noticed by a fingerprint it no longer has.
    const forgotten = this.#rederive ? this.#index.forgetFingerprints() : NO_FILES
    this.#rederive = false
    for (let pass = 0; pass < 3; pass += 1) {
      const again = await this.#refreshPass(keepParses, forgotten)
      if (!again.ok) return again
      if (!again.value) break
    }
    this.#cycleFindings = this.#hierarchyFindings()
    return storeOk(undefined)
  }

  async #refreshPass(keepParses: ReadonlySet<string>, forgotten: ReadonlySet<string>): Promise<StoreResult<boolean>> {
    const known = this.#index.fingerprints()
    const seen = new Set<string>()
    let invalidated = false

    for (const file of await this.#storeFiles()) {
      const full = path.join(this.#root, file)
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) return this.#symlinkRefusal(file)
      seen.add(file)
      const previous = known.get(file)
      if (previous !== undefined && previous.size === info.size && previous.mtime === info.mtimeMs) continue

      const outcome = file.endsWith('.jsonl')
        ? await this.#indexEventFile(file, full, info.size, info.mtimeMs, previous)
        : await this.#indexRecordFile(file, full, info.size, info.mtimeMs, keepParses)
      if (!outcome.ok) return outcome
      invalidated ||= outcome.value
    }

    for (const file of [...known.keys(), ...forgotten]) if (!seen.has(file)) invalidated ||= this.#index.dropFile(file)
    return storeOk(invalidated)
  }

  /**
   * The symbolic-link rule (S15), applied to the layout before anything under the root is
   * opened. A link is refused rather than reported as a finding because a finding lives in
   * the index, and a linked `.index` is one of the paths this refuses.
   */
  async #checkLayout(): Promise<StoreResult<never> | undefined> {
    for (const relative of LAYOUT) {
      let info
      try {
        info = await lstat(path.join(this.#root, relative))
      } catch {
        continue
      }
      if (info.isSymbolicLink()) return this.#symlinkRefusal(relative)
    }
    return undefined
  }

  async #symlinkRefusal(relative: string): Promise<StoreResult<never>> {
    const full = path.join(this.#root, relative)
    const target = await readlink(full).catch(() => '?')
    const what = relative === '.' ? `the workspace directory ${this.#root}` : relative
    return storeFail(
      'INTEGRITY', 'S15',
      `${what} is a symbolic link to ${target}, which the store never follows; replace the link with the directory or file itself, or name the target with --workspace`,
      [relative],
    )
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
    file: string, full: string, size: number, mtime: number, keepParses: ReadonlySet<string> = NO_FILES,
  ): Promise<StoreResult<boolean>> {
    // The ceiling is checked against the size the stat already gave us, before the file is
    // read: a limit that only fires after the read has happened is not a limit (F8).
    if (size > MAX_FILE_BYTES) {
      return storeOk(this.#replaceRecordFile(file, { size, mtime, hash: '', lines: 0 }, [], [{
        file, line: 1, rule: 'S4',
        reason: `${file} is ${size} bytes, over the ${MAX_FILE_BYTES} byte ceiling for a record file; it is not served`,
      }]))
    }
    const text = await readFile(full, 'utf8')
    const parsed = parseFile(text, file)
    if (!parsed.ok) {
      return storeOk(this.#replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, [], [
        { file, line: 1, rule: parsed.error.rule, reason: parsed.error.message },
      ]))
    }
    const schema = this.#schemaRefusal(parsed.value, file)
    if (schema !== undefined) {
      return storeOk(this.#replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, [], [
        { file, line: 1, rule: schema.rule, reason: schema.message },
      ]))
    }

    const items: IndexedItem[] = []
    const findings: Finding[] = parsed.value.quarantined.map((q) => (q.id === undefined
      ? { file, line: q.line, rule: q.rule, reason: q.reason }
      : { file, line: q.line, rule: q.rule, reason: q.reason, id: q.id }))

    if (file === SPRINTS_FILE) {
      const sprints: IndexedSprint[] = []
      for (const record of parsed.value.records) {
        const sprint = decodeSprint(record)
        if (!sprint.ok) {
          findings.push({ file, line: record.line, rule: sprint.error.rule, reason: sprint.error.message, id: record.id })
          continue
        }
        sprints.push(sprintRowOf(sprint.value, file, record.line, record.source))
      }
      if (parsed.value.crlf) {
        findings.push({ file, line: 1, rule: 'H16', reason: `${file} carries CRLF line endings; the next write to it normalises them to LF` })
      }
      this.#index.replaceSprintFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, sprints, findings)
      this.#parsedUnderLock.set(file, { size, mtime, parsed: parsed.value })
      return storeOk(false)
    }
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
    const invalidated = this.#replaceRecordFile(file, { size, mtime, hash: hashOf(text), lines: 0 }, items, findings)
    // A shard the transaction writes keeps its parse; any other refresh keeps the last shard
    // it read, one file, because the shard a write touches is usually the shard the previous
    // write changed, and `get` before `apply` in one process was parsing it twice.
    if (!keepParses.has(file)) {
      for (const kept of this.#parsedUnderLock.keys()) if (!keepParses.has(kept)) this.#parsedUnderLock.delete(kept)
    }
    this.#parsedUnderLock.set(file, { size, mtime, parsed: parsed.value })
    return storeOk(invalidated)
  }

  #replaceRecordFile(
    file: string, fingerprint: Fingerprint, items: readonly IndexedItem[], findings: readonly Finding[],
  ): boolean {
    return this.#index.replaceRecordFile(file, fingerprint, items, findings).invalidated
  }

  async #indexEventFile(
    file: string, full: string, size: number, mtime: number, previous: Fingerprint | undefined,
  ): Promise<StoreResult<boolean>> {
    if (size > MAX_EVENT_FILE_BYTES) {
      return storeOk(this.#index.replaceEventFile(file, { size, mtime, hash: '', lines: 0 }, [], [], [{
        file, line: 1, rule: 'S6',
        reason: `${file} is ${size} bytes, over the ${MAX_EVENT_FILE_BYTES} byte ceiling for an event file; it is not served`,
      }], false).invalidated)
    }
    const grew = previous !== undefined && size > previous.size
    const appendOnly = grew && await this.#prefixUnchanged(full, previous)

    const from = appendOnly ? (previous as Fingerprint).size : 0
    const fromLine = appendOnly ? (previous as Fingerprint).lines : 0
    const read = await scanEventFile(full, file, from, fromLine)
    if (!read.ok) {
      return storeOk(this.#index.replaceEventFile(file, { size, mtime, hash: '', lines: 0 }, [], [], [
        { file, line: 1, rule: read.error.rule, reason: read.error.message },
      ], false).invalidated)
    }
    const whole = await readFile(full)
    const outcome = this.#index.replaceEventFile(
      file,
      { size, mtime, hash: hashOf(whole), lines: read.value.lines },
      read.value.events, read.value.at, read.value.findings, appendOnly, appendOnly ? from : undefined,
    )
    if (outcome.wholePass === true) return this.#indexEventFile(file, full, size, mtime, undefined)
    return storeOk(outcome.invalidated)
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
   * The verdict is then written back beside the rows it came from, in the same call that
   * clears the durable dirty marker it accounts for. Every transaction that moves an item row
   * merges into that marker, so this recomputes exactly when the row set moved: at 50,000
   * items the walk is 111 ms of a 218 ms read, and a command that changed nothing was paying
   * it to reach the same answer as the command before it.
   */
  #recheckHierarchy(): readonly string[] | null {
    const cycle = findParentCycle(this.#index.parentEdges()) ?? null
    this.#index.setHierarchyVerdict(JSON.stringify(cycle))
    return cycle
  }

  /**
   * The verdict this refresh is entitled to, read from the index rather than from anything
   * only this process's memory carries: a marker written and merged in the same transaction
   * as the rows it describes survives a crash between a commit and this recompute, which an
   * in-memory tally of what a refresh touched cannot.
   *
   * No dirty marker reuses the stored verdict outright. One that names moved parent edges,
   * over a store already known to be acyclic, walks up from those nodes alone: a cycle that
   * was not there before has to pass through an edge that moved. One marked `full`, from a
   * moved-edge count past the cap a meta row is worth carrying, recomputes whole.
   *
   * A store already reported cyclic recomputes whole as soon as any row moved, edge or not.
   * An edit clears a cycle as easily as it closes one, and dropping the edge that closed it
   * moves no edge at all, so a rule that watched only for moved edges would report a cycle
   * that a hand edit had already removed.
   */
  #hierarchyCycle(): readonly string[] | null {
    const stored = this.#index.hierarchyVerdict()
    if (stored === undefined) return this.#recheckHierarchy()
    const dirty = this.#index.hierarchyDirty()
    if (dirty === undefined) return JSON.parse(stored) as readonly string[] | null

    const known = JSON.parse(stored) as readonly string[] | null
    if (known !== null) {
      if (dirty.rows) return this.#recheckHierarchy()
      this.#index.setHierarchyVerdict(stored)
      return known
    }
    if (dirty.full) return this.#recheckHierarchy()
    for (const id of dirty.moved) {
      const cycle = cycleAbove(id, (at) => this.#index.parentOf(at))
      if (cycle !== undefined) {
        this.#index.setHierarchyVerdict(JSON.stringify(cycle))
        return cycle
      }
    }
    this.#index.setHierarchyVerdict(stored)
    return known
  }

  // -- writing ---------------------------------------------------------------------------

  async #applyUnderLock(transaction: StoreTransaction, lock: LockHandle): Promise<StoreResult<Applied>> {
    const shards = new Map<string, ParsedFile>()
    const applied: AppliedWrite[] = []
    const findings = this.#index.findings()

    // The read set is checked against the index, which the refresh under this lock has
    // just brought level with the files, so a record another process moved between the
    // caller's read and this lock is seen here at its new version.
    for (const read of transaction.reads ?? []) {
      const actual = this.#index.versionOf(read.id)
      if (actual === read.version) continue
      return storeFail(
        'CONFLICT', 'S10',
        actual === undefined
          ? `${read.id} left the store after the write was decided against it at version ${read.version}`
          : `${read.id} is at version ${actual} and the write was decided against version ${read.version}; retry so the decision reads what is there now`,
        [read.id], { expected: read.version, ...(actual === undefined ? {} : { actual }) },
      )
    }

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
      const source = renderRecord(encoded.value)
      // The record as it will be read, parsed once before it is written. The dictionary
      // refuses what it knows about, and this holds the property where the bytes are: the
      // store never writes a record it would not serve back. A criterion carrying a newline
      // once passed the dictionary, rendered as a body line no reader accepts, was reported
      // as a success and then refused every read after it.
      const unserved = (why: string): StoreResult<never> => storeFail(
        'VALIDATION', 'V4', `${write.item.id}: the record as written would not be served back: ${why}`, [write.item.id],
      )
      const back = parseRecordSource(source, 0)
      if (!back.ok) return unserved(back.reason)
      const served = decodeItem(back.record)
      if (!served.ok) return unserved(served.error.message)

      shards.set(file, withRecord(shard, { ...encoded.value, source, line: 0 }))
      applied.push({ id: write.item.id, version })
    }

    for (const write of transaction.sprints ?? []) {
      const shard = shards.get(SPRINTS_FILE) ?? await this.#readShard(SPRINTS_FILE)
      if (!('chunks' in shard)) return shard
      shards.set(SPRINTS_FILE, shard)

      const at = shard.chunkById.get(write.sprint.id)
      const chunk = at === undefined ? undefined : shard.chunks[at]
      if (chunk !== undefined && chunk.kind === 'quarantine') {
        return storeFail(
          'CONFLICT', chunk.quarantine.rule,
          `${write.sprint.id} is a record ${SPRINTS_FILE} does not serve, so a write cannot say what it is changing: line ${chunk.quarantine.line}: ${chunk.quarantine.reason}`,
          [write.sprint.id],
        )
      }
      const stored = chunk === undefined ? undefined : chunk.record
      const conflict = await this.#compareAndSet(write.sprint.id, stored, write.ifVersion)
      if (conflict !== undefined) return conflict

      const version = (stored === undefined ? 0 : Number(stored.fields.get('version') ?? 0)) + 1
      const encoded = encodeSprint({ ...write.sprint, version }, stored)
      if (!encoded.ok) return encoded
      const source = renderRecord(encoded.value)
      const back = parseRecordSource(source, 0)
      if (!back.ok) return storeFail('VALIDATION', 'V4', `${write.sprint.id}: the record as written would not be served back: ${back.reason}`, [write.sprint.id])
      const served = decodeSprint(back.record)
      if (!served.ok) return storeFail('VALIDATION', 'V4', `${write.sprint.id}: the record as written would not be served back: ${served.error.message}`, [write.sprint.id])

      shards.set(SPRINTS_FILE, withRecord(shard, { ...encoded.value, source, line: 0 }))
      applied.push({ id: write.sprint.id, version })
    }

    const files = [...shards].map(([file, parsed]) => ({
      path: file,
      content: renderFile({ header: parsed.header || renderHeader(SCHEMA), chunks: parsed.chunks }),
    }))
    const eventFiles = groupEvents(transaction.events)

    const journal: Journal = { txn: transaction.txn, files, events: eventFiles }
    const journalPath = path.join(this.#root, JOURNAL_DIR, `${transaction.txn}.json`)
    await mkdir(path.dirname(journalPath), { recursive: true, mode: DIR_MODE })
    await writeFileAtomic(journalPath, JSON.stringify(journal), () => this.#assertHeld(lock, transaction.txn, false))

    // From here the journal is the transaction: a lock lost past this point leaves it for
    // the next holder to apply, which is the same path a crash takes, so the write lands
    // exactly once either way.
    await this.#applyJournal(journal, false, lock, transaction.txn)
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
        `${file} is schema ${parsed.schema} and this tool writes ${SCHEMA}; a file at an older schema is read as it is and not written to, and no command here rewrites it yet`,
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

  /**
   * The lock is asked before every byte a transaction commits. A holder that stalled past
   * the stale window, or whose token another writer replaced, refuses here instead of
   * writing over the reclaimer's work; ADR-0004 carries the measurement.
   */
  async #assertHeld(lock: LockHandle, txn: string, journaled: boolean): Promise<void> {
    if (await lock.held()) return
    throw new LockLost(storeFail(
      'LOCK_LOST', 'S16',
      journaled
        ? `the lock was lost while transaction ${txn} was being applied: this process stalled past the heartbeat window and another writer reclaimed it; the journaled transaction is applied by the next writer, so check the record before retrying`
        : `the lock was lost before transaction ${txn} was written: this process stalled past the heartbeat window and another writer reclaimed it; nothing was written, so retry`,
      [txn],
    ))
  }

  async #applyJournal(journal: Journal, recovering: boolean, lock: LockHandle, txn: string): Promise<void> {
    for (const file of journal.files) {
      const full = path.join(this.#root, file.path)
      await mkdir(path.dirname(full), { recursive: true, mode: DIR_MODE })
      await writeFileAtomic(full, file.content, () => this.#assertHeld(lock, txn, !recovering))
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
      if (missing.length > 0) await appendAndSync(full, missing.join(''), () => this.#assertHeld(lock, txn, !recovering))
    }
  }

  /** A lock holder that finds a journal re-applies it before doing its own work (DR4). */
  async #recoverJournals(lock: LockHandle): Promise<void> {
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
      let journal: Journal
      try {
        journal = JSON.parse(await readFile(full, 'utf8')) as Journal
      } catch {
        // A journal we cannot read is a journal we cannot replay; the doctor reports it.
        continue
      }
      await this.#applyJournal(journal, true, lock, journal.txn)
      await rm(full, { force: true })
    }
  }
}

/** Carries a lock-loss refusal out of the write path as a result rather than a stack trace. */
class LockLost extends Error {
  readonly refusal: StoreResult<never>

  constructor(refusal: StoreResult<never>) {
    super(refusal.ok ? 'lock lost' : refusal.error.message)
    this.refusal = refusal
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

export function rowOf(item: WorkItem, file: string, line: number, source: string): IndexedItem {
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
    resolution: item.resolution ?? null,
    due: item.due ?? null,
    severity: item.severity ?? null,
    relations: item.relations === undefined ? null : JSON.stringify(item.relations),
    source,
  }
}

export function sprintRowOf(sprint: Sprint, file: string, line: number, source: string): IndexedSprint {
  return { id: sprint.id, file, line, state: sprint.state, filed_at: sprint.filed_at, source }
}

/**
 * The inverse of `rowOf` over the columns a summary carries. An absent field is absent, not
 * null, so a summary reads exactly as the item `list` decodes from the same record.
 */
export function summaryOf(row: SummaryRow, intern: (value: string) => string = (value) => value): WorkItemSummary {
  return {
    id: row.id,
    type: intern(row.type) as WorkItemType,
    state: intern(row.state) as WorkItemState,
    title: row.title,
    filed_at: row.filed_at,
    version: row.version,
    ...(row.priority === null ? {} : { priority: row.priority }),
    ...(row.points === null ? {} : { points: row.points }),
    ...(row.parent === null ? {} : { parent_id: row.parent }),
    ...(row.assignee === null ? {} : { assignee: intern(row.assignee) }),
    ...(row.sprint === null ? {} : { sprint_id: intern(row.sprint) }),
    ...(row.resolution === null ? {} : { resolution: intern(row.resolution) as Resolution }),
    ...(row.due === null ? {} : { due: row.due }),
    ...(row.severity === null ? {} : { severity: intern(row.severity) as BugSeverity }),
    ...(row.relations === null ? {} : { relations: JSON.parse(row.relations) as readonly StoredRelation[] }),
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
