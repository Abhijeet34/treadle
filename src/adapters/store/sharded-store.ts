// SPDX-License-Identifier: Apache-2.0
// DR2's store: a directory of month-sharded record files and an append-only monthly event
// log, read by parsing them.
//
// The committed files are the authority (decision D1), and nothing derived from them is
// kept between commands. A read parses the shards it answers from, one corrupt record is
// quarantined rather than costing the file, and a mutation re-reads under the lock, so the
// tool never writes from stale memory and never overwrites a hand edit it did not see.
//
// ADR-0030 records why the SQLite index that used to sit in front of this went: at 347
// records it bought 20 to 25 ms a read for a quarter of the store's lines, five rules and
// the only defect that has ever bricked a workspace.

import { access, constants, lstat, mkdir, readFile, readdir, readlink, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  defaultConfig,
  findParentCycle,
  summaryOf,
  type WorkItem,
  type WorkItemSummary,
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
  withoutRecord,
  type ParsedFile,
  type ParsedRecord,
} from './grammar.ts'
import { decodeItem, encodeItem } from './item-codec.ts'
import { decodeWorkspace, encodeWorkspace, type WorkspaceRecord } from './workspace-codec.ts'
import { parentMissing, stillNamed, type Referrer } from './referential.ts'
import { MAX_EVENT_FILE_BYTES, MAX_EVENT_LINE_BYTES, MAX_FILE_BYTES } from './limits.ts'
import { acquireLock, type AcquireOptions, type LockHandle } from './lock.ts'
import { setImmediate as yieldToLoop } from 'node:timers/promises'

/** The one compiled-in schema number. DR3: `migrate` is the only path that changes a file's. */
export const SCHEMA = 1

export const WORKSPACE_FILE = 'workspace.md'
const ITEMS_DIR = 'items'
const EVENTS_DIR = 'events'
/**
 * Where a transaction's journal waits between the moment it is durable and the moment it
 * has been applied. It used to live under the derived index directory, which is gone; it is
 * ignored by git for the reason the lock is, because both are transient and neither is a
 * record.
 */
const JOURNAL_DIR = '.txn'
const LOCK_FILE = '.lock'

/**
 * Every path the store creates or follows below its root, checked with `lstat` before any
 * of them is read or written. A workspace is a committed directory and git materialises a
 * symbolic link on checkout, so a clone can carry `items -> ../../somewhere`; following it
 * would put every write outside the directory `init` promised to stay inside. The root
 * itself is on the list because the walk that found it went through `stat`.
 */
const LAYOUT = ['.', WORKSPACE_FILE, ITEMS_DIR, EVENTS_DIR, JOURNAL_DIR] as const

export type ShardedStoreOptions = {
  readonly lockTimeoutMs?: number
  /** Overrides `HOLDER_TIMEOUT_MS`; the tests that prove the bound are what needs it small. */
  readonly holderTimeoutMs?: number
  readonly onWaiting?: AcquireOptions['onWaiting']
}

/**
 * How long a waiter lets one holder keep the lock before refusing. It is the store's number
 * rather than the lock's, because the lock is a primitive with no view of what a critical
 * section costs and this is measured against one: an `apply` is a read, a parse and two
 * writes, milliseconds at the corpus DR2 measures against, and six times the 5 second stale
 * window is far past anything honest work takes. A lock that keeps changing hands resets it,
 * so contention is still waited out without a bound; only a holder that never lets go hits it.
 */
const HOLDER_TIMEOUT_MS = 30_000

/** One file under the root, and what a stat says about it. */
type Stamped = {
  readonly file: string
  readonly size: number
  readonly mtime: number
}

/** What is under the root right now: the files to read, and the proof of what they were. */
type Listing = {
  readonly records: readonly Stamped[]
  readonly logs: readonly string[]
  /** Every file with its size and mtime, which is what says the parse below is still it. */
  readonly stamp: string
}

/** One served record, with the file and the line a refusal about it names. */
type Held = {
  readonly item: WorkItem
  readonly file: string
  readonly line: number
}

/**
 * Every record the shards hold, as one command sees them. Nothing here is written back:
 * it is the parse of the committed files that this command answers from, discarded when
 * the process ends and taken again under the lock before any write decides anything.
 */
type Records = {
  /** In `filed_at, id` order, which is the order every list answers in. */
  readonly items: readonly Held[]
  readonly byId: ReadonlyMap<string, Held>
  /** In file and line order, with the one hierarchy verdict appended. */
  readonly findings: readonly Finding[]
  /**
   * The log's month files, oldest first. Named on every read even though only a command
   * that answers from the log opens one: the containment rule (S15) is over the layout and
   * not over what a command happens to want, and a linked `events/2026-09.jsonl` was
   * refused on a read of the records before this was.
   */
  readonly logFiles: readonly string[]
}

type Journal = {
  readonly txn: string
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly events: readonly { readonly path: string; readonly lines: readonly string[]; readonly ids: readonly string[] }[]
}

/**
 * A journal decides what the next writer writes, before anything else looks at it, and
 * `.txn/` is a directory anything that can write the workspace can put a file in - a commit
 * carrying an ignored path included, because `.gitignore` does not remove a tracked file on
 * checkout. So it is parsed rather than cast. `JSON.parse(...) as Journal` turned a stray
 * `{"garbage":true}` into `journal.files is not iterable`, uncaught, on every write forever,
 * and a `path` of `../../elsewhere` was joined onto the root and written at exit 0.
 */
function parseJournal(text: string): Journal | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const { txn, files, events } = raw as Record<string, unknown>
  if (typeof txn !== 'string' || !Array.isArray(files) || !Array.isArray(events)) return undefined
  for (const file of files) {
    if (typeof file !== 'object' || file === null) return undefined
    const entry = file as Record<string, unknown>
    if (typeof entry['content'] !== 'string') return undefined
    if (!contained(entry['path'], ITEMS_DIR, WORKSPACE_FILE)) return undefined
  }
  for (const log of events) {
    if (typeof log !== 'object' || log === null) return undefined
    const entry = log as Record<string, unknown>
    const { lines, ids } = entry
    if (!Array.isArray(lines) || !Array.isArray(ids) || lines.length !== ids.length) return undefined
    if (!lines.every((line) => typeof line === 'string')) return undefined
    if (!ids.every((id) => typeof id === 'string')) return undefined
    if (!contained(entry['path'], EVENTS_DIR)) return undefined
  }
  return raw as Journal
}

/** What a caller is told about a file in `.txn/` the store cannot replay, in one place. */
function unreplayable(file: string): string {
  return `${file} is not a transaction journal this store wrote, so it cannot be replayed and no write can go past it; ${JOURNAL_DIR} holds journals and nothing else, and deleting the file clears this`
}

/**
 * A name off the filesystem as text a refusal or a finding may carry. A directory entry may
 * hold any byte but `/` and NUL, and the agent/1 line grammar ends a value at a newline: a
 * shard named `a<LF>b.md` took `doctor` down with `INTERNAL` at exit 1, which is the one
 * surface that would have named the file. Escaped rather than dropped, because the point of
 * the finding is to say which file to go and look at.
 */
function printable(text: string): string {
  return text.includes('\n') || text.includes('\r')
    ? text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    : text
}

/** The same, over a whole finding: both of its text fields come off the filesystem. */
function printableFinding(finding: Finding): Finding {
  return { ...finding, file: printable(finding.file), reason: printable(finding.reason) }
}

/**
 * The containment rule (S15) on the replay path: a journal may name the workspace record or
 * one file directly inside a directory the layout draws, and nothing else. One segment, not
 * a prefix match, because `items/../../x` starts with `items/` and leaves the root.
 */
function contained(at: unknown, dir: string, alsoExactly?: string): boolean {
  if (typeof at !== 'string') return false
  if (at === alsoExactly) return true
  const parts = at.split('/')
  return parts.length === 2 && parts[0] === dir && parts[1] !== '' && parts[1] !== '.' && parts[1] !== '..'
}

function monthOf(instant: string): string {
  return instant.slice(0, 7)
}

/**
 * Writes the layout DR2 draws, including the two git attributes it depends on: the journal
 * and the lock are ignored because they are transient and neither is a record, and the
 * event log merges union because two branches appending in one month must not conflict.
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
    await writeFileAtomic(path.join(root, '.gitignore'), `${JOURNAL_DIR}/\n${LOCK_FILE}\n`)
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
  readonly #options: ShardedStoreOptions
  /**
   * The shards as this command read them. One parse serves every question a command asks,
   * because `status` alone asks four; it is taken again from the files under the lock
   * before a write, and never survives the process.
   */
  #records: Records | undefined
  /** The `#listFiles` stamp `#records` was parsed from, and the whole of what makes it reusable. */
  #stamp: string | undefined
  /**
   * What reading the log said about the log, and what `.txn/` holds that is not a journal,
   * kept because `doctor` asks for the findings after it has read it. A command that never
   * reads the log never pays for the scan that would fill this, which is the whole reason it
   * is not part of `#records`.
   */
  #logFindings: readonly Finding[] = []

  constructor(root: string, options: ShardedStoreOptions = {}) {
    this.#root = root
    this.#options = options
  }

  async identity(): Promise<StoreResult<StoreIdentity>> {
    const layout = await this.#checkLayout()
    if (layout !== undefined) return layout
    const file = path.join(this.#root, WORKSPACE_FILE)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(file)
    } catch (error) {
      return this.#absentOrUnreadable(file, error)
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
    } catch (error) {
      return this.#absentOrUnreadable(file, error)
    }
    const parsed = parseFile(text, WORKSPACE_FILE)
    if (!parsed.ok) return parsed
    const schema = this.#schemaRefusal(parsed.value, WORKSPACE_FILE)
    if (schema !== undefined) return { ok: false, error: schema }
    const record = parsed.value.records[0]
    if (record === undefined) {
      // A file with no record at all and a file whose one record the grammar quarantined are
      // two different edits, and saying "carries no workspace record" for both sent a caller
      // to `treadle init`, which answers `already` and fixes nothing. The quarantine knows
      // the line and the reason, so the refusal carries them and names the edit as the way
      // back; `doctor` cannot be the way back here, because it opens with this same read.
      const held = parsed.value.quarantined[0]
      if (held !== undefined) {
        return storeFail(
          'INTEGRITY', held.rule,
          `${WORKSPACE_FILE} holds one record, at line ${held.line}, and does not serve it: ${held.reason}; it is the record every command reads first, so no command can answer over this store until the file is edited`,
          [WORKSPACE_FILE],
        )
      }
      return storeFail('INTEGRITY', 'S1', `${WORKSPACE_FILE} carries no workspace record`, [WORKSPACE_FILE])
    }
    // A configuration this build cannot read is not a refusal here. `doctor` opens with this
    // call and is the one command that has to answer over the file that says it, so the
    // refusal is the finding `#indexRecordFile` raises off the same decode, which
    // `readWorkspace` turns into the `INTEGRITY` every other command gives. What identity
    // reports meanwhile is the compiled-in default, which is what the workspace behaves as
    // for exactly as long as no command can run.
    const decoded = decodeWorkspace(record)
    const config = decoded.ok ? decoded.value.config : defaultConfig()
    const version = decoded.ok ? decoded.value.version : 0
    const extra = decoded.ok ? decoded.value.extra.size : 0
    return storeOk({ id: record.id, name: record.title, path: this.#root, version, config, extra })
  }

  async get(id: string): Promise<StoreResult<WorkItem | undefined>> {
    const read = await this.#read()
    if (!read.ok) return read
    return storeOk(read.value.byId.get(id)?.item)
  }

  async eachItem(query: ItemQuery, visit: (item: WorkItem) => void): Promise<StoreResult<number>> {
    const read = await this.#read()
    if (!read.ok) return read
    let visited = 0
    for (const held of selected(read.value.items, query)) {
      visit(held.item)
      visited += 1
    }
    return storeOk(visited)
  }

  async summaries(query: ItemQuery = {}): Promise<StoreResult<readonly WorkItemSummary[]>> {
    const read = await this.#read()
    if (!read.ok) return read
    return storeOk(selected(read.value.items, query).map((held) => summaryOf(held.item)))
  }

  async events(query: EventQuery = {}): Promise<StoreResult<readonly StoreEvent[]>> {
    const out: StoreEvent[] = []
    const scanned = await this.#eachLogEvent(query, (event) => out.push(event))
    return scanned.ok ? storeOk(out) : scanned
  }

  async eachEvent(query: EventQuery, visit: (event: StoreEvent) => void): Promise<StoreResult<number>> {
    return this.#eachLogEvent(query, visit)
  }

  /**
   * What the store read and would not serve. The records are always read, because every
   * command answers over the record set; the log's own findings join them once something
   * has read the log, which is `doctor` and the two commands that answer from it.
   */
  async findings(): Promise<StoreResult<readonly Finding[]>> {
    const read = await this.#read()
    if (!read.ok) return read
    if (this.#logFindings.length === 0) return storeOk(read.value.findings)
    return storeOk([...read.value.findings, ...this.#logFindings])
  }

  async apply(transaction: StoreTransaction): Promise<StoreResult<Applied>> {
    const lock = await acquireLock(path.join(this.#root, LOCK_FILE), {
      holderTimeoutMs: this.#options.holderTimeoutMs ?? HOLDER_TIMEOUT_MS,
      ...(this.#options.lockTimeoutMs === undefined ? {} : { timeoutMs: this.#options.lockTimeoutMs }),
      ...(this.#options.onWaiting === undefined ? {} : { onWaiting: this.#options.onWaiting }),
    })
    if (!lock.ok) return lock
    try {
      const recovered = await this.#recoverJournals(lock.value)
      if (!recovered.ok) return recovered
      await sweepTempFiles(path.join(this.#root, ITEMS_DIR))
      // A writer killed between the journal's exclusive create and its rename leaves a temp
      // file the sweep over `items/` never reached, and nothing else here ever removes one.
      await sweepTempFiles(path.join(this.#root, JOURNAL_DIR))
      // The read is taken here and nowhere earlier. Every check below decides a refusal -
      // the read set, the cross-shard id, the referential rule - and a check that decides a
      // refusal may not read anything but the files as they are under this lock.
      // A write inside one mtime tick that leaves the file the same size is invisible to
      // the listing's stat, so the read this transaction decides against is taken from the
      // files rather than proved fresh against them.
      this.#records = undefined
      const fresh = await this.#read()
      if (!fresh.ok) return fresh
      return await this.#applyUnderLock(transaction, fresh.value, lock.value)
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
      // The write moved the files this read came from, so the next question over this store
      // reads them again rather than answering from what they said before the write.
      this.#records = undefined
      await lock.value.release()
    }
  }

  async close(): Promise<void> {
    this.#records = undefined
    this.#logFindings = []
  }

  // -- reading ---------------------------------------------------------------------------

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

  /**
   * The symbolic-link rule (S15), applied to the layout before anything under the root is
   * opened. A link is refused rather than reported as a finding because a finding is a
   * verdict on a file this store read, and the point of this check is that it did not.
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

  /**
   * An errno on a path this store must read. Before this, every one of them was swallowed:
   * a `.work/items` directory the process may not open answered `items 0` at exit 0 over a
   * workspace holding 347 records, and an unreadable shard escaped as an `INTERNAL` stack
   * trace naming no rule. Both are the store being unavailable, which is what the write
   * path has always called an errno it cannot act on.
   */
  #unreadable(full: string, error: unknown): StoreResult<never> {
    const errno = error as NodeJS.ErrnoException
    return storeFail(
      'STORE_UNAVAILABLE', 'S13',
      `${full} could not be read: ${errno.syscall ?? 'a read'} failed with ${errno.code ?? 'an error'}`,
      [this.#root],
    )
  }

  /** The same, where the path being absent is the ordinary answer rather than a failure. */
  #absentOrUnreadable(full: string, error: unknown): StoreResult<never> {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return storeFail('STORE_UNAVAILABLE', 'S1', `${full} is not there, so this directory is not a treadle workspace`, [this.#root])
    }
    return this.#unreadable(full, error)
  }

  /**
   * The shards, parsed.
   *
   * A stat per file decides whether the parse this store already took is still the answer,
   * which is DR2's freshness rule and all that is left of it: `status` asks the store four
   * questions and a parse per question was four passes over the same bytes, while two
   * stores open on one root have to see each other's writes. What a moved file costs is the
   * whole read again rather than that file's rows, because there is no longer a row to
   * replace - and inside one command nothing moves that this store did not write.
   */
  async #read(): Promise<StoreResult<Records>> {
    const layout = await this.#checkLayout()
    if (layout !== undefined) return layout
    const listing = await this.#listFiles()
    if (!listing.ok) return listing
    const held = this.#records
    if (held !== undefined && this.#stamp === listing.value.stamp) return storeOk(held)

    const items: Held[] = []
    const byId = new Map<string, Held>()
    const findings: Finding[] = []
    for (const stamped of listing.value.records) {
      const read = await this.#readRecordFile(stamped, items, byId, findings)
      if (!read.ok) return read
    }
    // Every list answers in this order, and it is the order the index's own queries ended
    // in; a shard walk alone would order by month and then by position in the file.
    items.sort((a, b) => (a.item.filed_at === b.item.filed_at
      ? (a.item.id < b.item.id ? -1 : 1)
      : (a.item.filed_at < b.item.filed_at ? -1 : 1)))
    findings.sort((a, b) => (a.file === b.file ? a.line - b.line : (a.file < b.file ? -1 : 1)))

    // Load-time hierarchy validation (finding F8). A write-time cycle check cannot see an
    // edge a hand edit or a git merge put in a file, and every parent walk reads exactly
    // this data. It is recomputed on every read because there is nowhere left to remember
    // it: 10.3 ms at 10,000 records, against the 39 MB of index that used to carry the
    // verdict, the dirty marker that decided when to trust it and the walk that repaired it.
    const edges = new Map<string, string>()
    for (const one of items) if (one.item.parent_id !== undefined) edges.set(one.item.id, one.item.parent_id)
    const cycle = findParentCycle(edges)
    if (cycle !== undefined) {
      findings.push({
        file: WORKSPACE_FILE, line: 1, rule: 'S12',
        reason: `the stored hierarchy closes a cycle: ${cycle.join(' -> ')}`,
        id: cycle[0] as string,
      })
    }

    const records: Records = { items, byId, findings: findings.map(printableFinding), logFiles: listing.value.logs }
    this.#records = records
    this.#stamp = listing.value.stamp
    return storeOk(records)
  }

  /**
   * Every file under the root the store reads, with the stat that both bounds it and says
   * whether it has moved. The symbolic-link rule (S15) is applied here, before anything
   * below the root is opened, and over the log as well as the records: a linked
   * `events/2026-09.jsonl` is a path outside the workspace whether or not the command in
   * hand happens to want the log.
   */
  async #listFiles(): Promise<StoreResult<Listing>> {
    const names: string[] = [WORKSPACE_FILE]
    for (const [dir, ext] of [[ITEMS_DIR, '.md'], [EVENTS_DIR, '.jsonl']] as const) {
      const full = path.join(this.#root, dir)
      let listed: readonly string[]
      try {
        listed = await readdir(full)
      } catch (error) {
        // A directory that has been removed holds no records, which is what it says. One
        // this process may not open holds whatever it holds, and says that instead.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        return this.#unreadable(full, error)
      }
      for (const name of [...listed].sort()) {
        if (isTempName(name) || !name.endsWith(ext)) continue
        names.push(`${dir}/${name}`)
      }
    }

    const found: Stamped[] = []
    for (const file of names) {
      const full = path.join(this.#root, file)
      let info
      try {
        info = await lstat(full)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        return this.#unreadable(full, error)
      }
      if (info.isSymbolicLink()) return this.#symlinkRefusal(file)
      found.push({ file, size: info.size, mtime: info.mtimeMs })
    }
    const isLog = (one: Stamped): boolean => one.file.startsWith(`${EVENTS_DIR}/`)
    return storeOk({
      records: found.filter((one) => !isLog(one)),
      logs: found.filter(isLog).map((one) => one.file),
      stamp: found.map((one) => `${one.file} ${one.size} ${one.mtime}`).join('\n'),
    })
  }

  /**
   * One file's records, decoded into the read. A record the dictionary refuses is a finding
   * and not a hole the caller cannot see, and an id a second shard repeats is `S3`: the
   * parser refuses a repeat inside one file, so `already` here can only mean another shard.
   */
  async #readRecordFile(
    stamped: Stamped, items: Held[], byId: Map<string, Held>, findings: Finding[],
  ): Promise<StoreResult<undefined>> {
    const { file } = stamped
    const full = path.join(this.#root, file)
    // The ceiling is checked against the size the listing already gave us, before the file
    // is read: a limit that only fires after the read has happened is not a limit (F8).
    if (stamped.size > MAX_FILE_BYTES) {
      findings.push({
        file, line: 1, rule: 'S4',
        reason: `${file} is ${stamped.size} bytes, over the ${MAX_FILE_BYTES} byte ceiling for a record file; it is not served`,
      })
      return storeOk(undefined)
    }

    let text: string
    try {
      text = await readFile(full, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return storeOk(undefined)
      return this.#unreadable(full, error)
    }
    const parsed = parseFile(text, file)
    if (!parsed.ok) {
      findings.push({ file, line: 1, rule: parsed.error.rule, reason: parsed.error.message })
      return storeOk(undefined)
    }
    const schema = this.#schemaRefusal(parsed.value, file)
    if (schema !== undefined) {
      findings.push({ file, line: 1, rule: schema.rule, reason: schema.message })
      return storeOk(undefined)
    }

    for (const quarantined of parsed.value.quarantined) {
      findings.push(quarantined.id === undefined
        ? { file, line: quarantined.line, rule: quarantined.rule, reason: quarantined.reason }
        : { file, line: quarantined.line, rule: quarantined.rule, reason: quarantined.reason, id: quarantined.id })
    }

    if (file === WORKSPACE_FILE) {
      // The one decode `identity` performs, run again here so a configuration this build
      // cannot read is reported rather than silently defaulted. `H14` is the finding the
      // domain model names for a gate rule reading a field the type lacks, and a value of
      // any other key that will not parse is `S1`, which is what a damaged record is
      // everywhere else in this store. Both hide content, so `readWorkspace` refuses over
      // either and names `doctor`, which is the surface that prints the row.
      for (const record of parsed.value.records) {
        const decoded = decodeWorkspace(record)
        if (decoded.ok) continue
        const rule = decoded.error.rule === 'V6' || decoded.error.rule === 'V7' ? 'H14' : 'S1'
        findings.push({ file, line: record.line, rule, reason: decoded.error.message, id: record.id })
      }
    } else {
      for (const record of parsed.value.records) {
        const decoded = decodeItem(record)
        if (!decoded.ok) {
          findings.push({ file, line: record.line, rule: decoded.error.rule, reason: decoded.error.message, id: record.id })
          continue
        }
        if (byId.has(record.id)) {
          findings.push({
            file, line: record.line, rule: 'S3', id: record.id,
            reason: `${record.id} is already a record in this store; the copy in ${file} line ${record.line} is quarantined`,
          })
          continue
        }
        const one: Held = { item: decoded.value, file, line: record.line }
        items.push(one)
        byId.set(record.id, one)
      }
    }
    if (parsed.value.crlf) {
      findings.push({ file, line: 1, rule: 'H16', reason: `${file} carries CRLF line endings; the next write to it normalises them to LF` })
    }
    return storeOk(undefined)
  }

  /**
   * The log, one month file at a time, holding one file's events and never the log. At
   * 10,000 records that is 100,000 lines, and `doctor` looks at each once.
   *
   * The order is the file name, then `at` within the file. A write puts an event in the file
   * its own month names, so the file name is the coarse order and a stable sort inside one
   * file is the fine one; a hand-written line filed under another month is ordered where the
   * file puts it, which is where a reader looking for it will be.
   */
  async #eachLogEvent(query: EventQuery, visit: (event: StoreEvent) => void): Promise<StoreResult<number>> {
    const records = await this.#read()
    if (!records.ok) return records

    const findings: Finding[] = [...await this.#journalFindings()]
    let visited = 0
    for (const file of records.value.logFiles) {
      const full = path.join(this.#root, file)
      let info
      try {
        info = await lstat(full)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        return this.#unreadable(full, error)
      }
      if (info.size > MAX_EVENT_FILE_BYTES) {
        findings.push({
          file, line: 1, rule: 'S6',
          reason: `${file} is ${info.size} bytes, over the ${MAX_EVENT_FILE_BYTES} byte ceiling for an event file; it is not served`,
        })
        continue
      }

      const read = await scanEventFile(full, file)
      if (!read.ok) {
        // A file the store may not open is the store being unavailable, not a verdict on
        // what the file holds; answering with the lines it did read is the empty answer this
        // store no longer gives. A ceiling the file is over is a verdict, and stays a finding.
        if (read.error.rule === 'S13') return read
        findings.push({ file, line: 1, rule: read.error.rule, reason: read.error.message })
        continue
      }

      const events = [...read.value.events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      for (const event of events) {
        if (query.entity !== undefined && event.entity !== query.entity) continue
        if (query.txn !== undefined && event.txn !== query.txn) continue
        if (query.from !== undefined && event.at < query.from) continue
        if (query.to !== undefined && event.at >= query.to) continue
        visit(event)
        visited += 1
        if (query.limit !== undefined && visited >= query.limit) {
          this.#logFindings = [...findings, ...read.value.findings].map(printableFinding)
          return storeOk(visited)
        }
      }
      findings.push(...read.value.findings)
    }
    this.#logFindings = findings.map(printableFinding)
    return storeOk(visited)
  }

  /**
   * The write that last moved a record, which a conflict names (interface A.6 rule 5). The
   * newest month file that carries an event for the record holds it, so the walk is newest
   * first and stops at that file rather than reading the log.
   */
  async #lastEventFor(entity: string, records: Records): Promise<StoreEvent | undefined> {
    for (const file of [...records.logFiles].reverse()) {
      const read = await scanEventFile(path.join(this.#root, file), file)
      if (!read.ok) continue
      // `at` is second-resolution, so two writes in one second are routine under an agent;
      // the later line in the file is the later write, which is why this takes the last
      // match in file order rather than the greatest `at`.
      let last: StoreEvent | undefined
      for (const event of read.value.events) if (event.entity === entity) last = event
      if (last !== undefined) return last
    }
    return undefined
  }

  // -- writing ---------------------------------------------------------------------------

  /**
   * The referential rule: no transaction may leave a record naming an id the store does not
   * hold. It runs inside the lock every write already holds, after the read set and before
   * any shard is rewritten, so a refusal leaves nothing half-applied and there is no window
   * between the check and the write.
   *
   * A read set cannot carry this. `remove`'s guards are all about a neighbour that does not
   * exist yet - an edge or a child's parent written after the guard read the store - and no
   * `reads` entry can name a record that was not there to be read.
   * `set parent_id=` and `file --parent` are the same defect in the other order: neither
   * carries a read set at all, so the parent can leave between the decision and the write.
   * `removeItem` keeps its own `R6` refusal, which fires first with the friendlier cause and
   * the fix lines in the ordinary case where the neighbour was already there.
   *
   * The transaction's own effects are applied to the question first: a record it also removes
   * leaves nothing behind, and one it rewrites answers as this transaction leaves it rather
   * than as the index still holds it.
   */
  #referentialRefusal(transaction: StoreTransaction, records: Records): StoreResult<never> | undefined {
    const removed = new Set((transaction.removes ?? []).map((removal) => removal.id))
    const written = new Map(transaction.writes.map((write) => [write.item.id, write.item]))

    // The store-side form of what `reads` does for a relation's target, and the half that
    // closes the order where the parent write lands after the removal. Relation targets are
    // deliberately not checked on a write: an edge naming a record the store does not hold is
    // `H24`, a state a hand edit may legitimately produce, and refusing it here would refuse
    // to write back any file that already carries one.
    //
    // The same reasoning bounds this check to the write that INTRODUCES the reference. A
    // record whose parent has already gone is `H30`, and refusing every write to it made
    // `set <child> assignee=kim` answer `CONFLICT` with a fix line naming a record that is
    // not there, while the remedy the finding prints is itself a write to that record.
    for (const write of transaction.writes) {
      const parent = write.item.parent_id
      if (parent === undefined || written.has(parent)) continue
      if (!removed.has(parent) && records.byId.has(parent)) continue
      if (!removed.has(parent) && records.byId.get(write.item.id)?.item.parent_id === parent) continue
      return parentMissing(parent, write.item.id)
    }

    if (removed.size === 0) return undefined
    // Every id this transaction touches is answered from the transaction rather than from the
    // index, so they are the rows the two lookups skip: a record being removed leaves nothing
    // and a record being rewritten is judged above, and neither is what the index still says.
    const touched = [...removed, ...written.keys()]
    for (const id of removed) {
      const referrer = referrerOf(records, id, touched)
      if (referrer !== undefined) return stillNamed(id, referrer)
    }
    return undefined
  }

  async #applyUnderLock(
    transaction: StoreTransaction, records: Records, lock: LockHandle,
  ): Promise<StoreResult<Applied>> {
    const shards = new Map<string, ParsedFile>()
    const applied: AppliedWrite[] = []
    const findings = records.findings

    // The read set is checked against the read taken under this lock, so a record another
    // process moved between the caller's read and this lock is seen here at its new version.
    for (const read of transaction.reads ?? []) {
      const actual = records.byId.get(read.id)?.item.version
      if (actual === read.version) continue
      return storeFail(
        'CONFLICT', 'S10',
        actual === undefined
          ? `${read.id} left the store after the write was decided against it at version ${read.version}`
          : `${read.id} is at version ${actual} and the write was decided against version ${read.version}; retry so the decision reads what is there now`,
        [read.id], { expected: read.version, ...(actual === undefined ? {} : { actual }) },
      )
    }

    const dangling = this.#referentialRefusal(transaction, records)
    if (dangling !== undefined) return dangling

    for (const write of transaction.writes) {
      // The heartbeat is a timer on this event loop, so it fires only between records. A
      // transaction of 2,144 records encoded in one synchronous stretch went 10.3 s without
      // a beat at a 1-minute load of 134 and was reclaimed while still writing; one turn
      // per record keeps the beat honest whatever the transaction's size or the machine's load.
      await yieldToLoop()
      const file = `${ITEMS_DIR}/${monthOf(write.item.filed_at)}.md`
      const shard = shards.get(file) ?? await this.#readShard(file)
      if (!('chunks' in shard)) return shard
      shards.set(file, shard)

      const resolved = this.#resolve(write.item.id, file, shard, findings, records)
      if (!resolved.ok) return resolved
      const stored = resolved.value
      const conflict = await this.#compareAndSet(write.item.id, stored, write.ifVersion, records)
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

    for (const removal of transaction.removes ?? []) {
      await yieldToLoop()
      // The record's own shard, found through the read rather than from its `filed_at`: the
      // caller hands in an id and a version, not a record, and a record never moves between
      // shards, so the file the read found it in is what says which shard holds it.
      const row = records.byId.get(removal.id)
      if (row === undefined) {
        return storeFail('CONFLICT', 'S10', `${removal.id} is not in the store, so version ${removal.ifVersion} cannot be matched`, [removal.id], { expected: removal.ifVersion })
      }
      const shard = shards.get(row.file) ?? await this.#readShard(row.file)
      if (!('chunks' in shard)) return shard
      shards.set(row.file, shard)

      const resolved = this.#resolve(removal.id, row.file, shard, findings, records)
      if (!resolved.ok) return resolved
      const conflict = await this.#compareAndSet(removal.id, resolved.value, removal.ifVersion, records)
      if (conflict !== undefined) return conflict
      shards.set(row.file, withoutRecord(shard, removal.id))
    }

    const workspace = transaction.workspace
    if (workspace !== undefined) {
      const shard = shards.get(WORKSPACE_FILE) ?? await this.#readShard(WORKSPACE_FILE)
      if (!('chunks' in shard)) return shard
      shards.set(WORKSPACE_FILE, shard)

      const at = shard.chunks.findIndex((chunk) => chunk.kind === 'record')
      const chunk = at === -1 ? undefined : shard.chunks[at]
      if (chunk === undefined || chunk.kind !== 'record') {
        return storeFail('INTEGRITY', 'S1', `${WORKSPACE_FILE} carries no workspace record`, [WORKSPACE_FILE])
      }
      const stored = decodeWorkspace(chunk.record)
      if (!stored.ok) return stored
      // The same compare-and-set an item is under, read off the record's own
      // `version` line. A workspace written before this build carries none, reads as zero,
      // and takes version 1 on its first configured write; two `config set` calls racing
      // therefore refuse the second with `S10` naming who moved it, rather than one of them
      // rewriting the whole record over the other.
      const conflict = await this.#compareAndSet(chunk.record.id, chunk.record, workspace.ifVersion, records)
      if (conflict !== undefined) return conflict

      const next: WorkspaceRecord = { ...stored.value, version: workspace.ifVersion + 1, config: workspace.config }
      const encoded = encodeWorkspace(next, chunk.record)
      const source = renderRecord(encoded)
      const back = parseRecordSource(source, 0)
      if (!back.ok) return storeFail('VALIDATION', 'V4', `${next.id}: the record as written would not be served back: ${back.reason}`, [next.id])
      const served = decodeWorkspace(back.record)
      if (!served.ok) return storeFail('VALIDATION', 'V4', `${next.id}: the record as written would not be served back: ${served.error.message}`, [next.id])

      shards.set(WORKSPACE_FILE, withRecord(shard, { ...encoded, source, line: 0 }))
      applied.push({ id: next.id, version: next.version })
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

  /**
   * The one shard a write is about to rewrite, read again under the lock. A transaction
   * touches one or two of them, so this is a twenty-fourth of the read at the corpus DR2
   * measures against, and holding every shard's parse from the read above to save it would
   * cost the whole store's text in resident memory for the life of the command.
   */
  async #readShard(file: string): Promise<ParsedFile | StoreResult<never>> {
    const full = path.join(this.#root, file)
    let text: string
    try {
      text = await readFile(full, 'utf8')
    } catch (error) {
      // A month with no shard yet is the ordinary case on the first write into it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return this.#unreadable(full, error)
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
    id: string, stored: ParsedRecord | undefined, ifVersion: number | undefined, records: Records,
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

    const last = await this.#lastEventFor(id, records)
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
   * winner; across shards it is the read, which serves the first shard to carry an id and
   * raises `S3` on every later copy. A chunk the parser quarantined for any other reason is
   * a record the read path does not serve, so a write to it is refused too: without that, a
   * create found no record chunk and filed a second copy of the id into the same shard.
   */
  #resolve(
    id: string, home: string, shard: ParsedFile, findings: readonly Finding[], records: Records,
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

    const row = records.byId.get(id)
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

  /**
   * A lock holder that finds a journal re-applies it before doing its own work (DR4).
   *
   * A file here that is not a journal stops the write rather than being skipped or removed:
   * skipping it would let a transaction the store cannot read go missing in silence, and
   * removing it would throw away a landed transaction on the guess that it holds none. The
   * refusal names the file, which is the whole remedy, because the directory holds nothing
   * else and `init` already says it is safe to delete.
   */
  async #recoverJournals(lock: LockHandle): Promise<StoreResult<undefined>> {
    const dir = path.join(this.#root, JOURNAL_DIR)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return storeOk(undefined)
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const file = printable(`${JOURNAL_DIR}/${name}`)
      let text: string
      try {
        text = await readFile(path.join(dir, name), 'utf8')
      } catch (error) {
        // Named here rather than by `apply`'s errno backstop, which has no path to print for
        // an `EISDIR` and would say only that a read failed.
        const errno = error as NodeJS.ErrnoException
        return storeFail('STORE_UNAVAILABLE', 'S13', `${file} could not be read: ${errno.syscall ?? 'read'} failed with ${errno.code ?? 'an error'}`, [file])
      }
      const journal = parseJournal(text)
      if (journal === undefined) {
        // `journal` is what tells the refusal apart from every other `S13`, which is an errno
        // with a filesystem remedy. This one is cleared by deleting the file, and the fix
        // line in `src/application/services/refusal.ts` reads this key to say so.
        return storeFail('STORE_UNAVAILABLE', 'S13', unreplayable(file), [file], { journal: file })
      }
      await this.#applyJournal(journal, true, lock, journal.txn)
      await rm(path.join(dir, name), { force: true })
    }
    return storeOk(undefined)
  }

  /**
   * The same journals, judged for a reader rather than a writer. It is scanned here, beside
   * the log, because both are files only a command answering over the whole store opens -
   * `doctor`, `history` and `explain` - and because a read of records that are all present
   * is still a whole answer while a write past an unreplayable journal is not. Without this
   * `doctor` called a workspace clean that refused every write.
   */
  async #journalFindings(): Promise<readonly Finding[]> {
    const dir = path.join(this.#root, JOURNAL_DIR)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const findings: Finding[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const file = printable(`${JOURNAL_DIR}/${name}`)
      const text = await readFile(path.join(dir, name), 'utf8').catch(() => undefined)
      if (text !== undefined && parseJournal(text) !== undefined) continue
      findings.push({ file, line: 1, rule: 'S13', reason: unreplayable(file) })
    }
    return findings
  }

  /**
   * The two things standing under this root that refuse every write, judged without the lock
   * and without a record parse: a `.txn/` file the next holder cannot replay, and a directory
   * a transaction has to write that this user may not.
   *
   * The refusals are the ones `#recoverJournals` and `apply`'s errno backstop give, built
   * here rather than restated, so `status` prints the sentence and the fix line the write
   * itself would print. What it deliberately does not judge is the lock: a held lock is a
   * writer working, and a lock that stopped heartbeating is reclaimed by the next waiter, so
   * naming one here would report honest contention as a broken store.
   */
  async writable(): Promise<StoreResult<undefined>> {
    const layout = await this.#checkLayout()
    if (layout !== undefined) return layout
    const dir = path.join(this.#root, JOURNAL_DIR)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const file = printable(`${JOURNAL_DIR}/${name}`)
      let text: string
      try {
        text = await readFile(path.join(dir, name), 'utf8')
      } catch (error) {
        const errno = error as NodeJS.ErrnoException
        return storeFail('STORE_UNAVAILABLE', 'S13', `${file} could not be read: ${errno.syscall ?? 'read'} failed with ${errno.code ?? 'an error'}`, [file])
      }
      if (parseJournal(text) === undefined) {
        return storeFail('STORE_UNAVAILABLE', 'S13', unreplayable(file), [file], { journal: file })
      }
    }
    // Every transaction writes in all three: the lock and the journal at the root, the shard
    // under `items/`, the log line under `events/`. A missing one is not judged here, because
    // the layout check above already answered for it.
    for (const relative of ['.', ITEMS_DIR, EVENTS_DIR]) {
      try {
        await access(path.join(this.#root, relative), constants.W_OK | constants.X_OK)
      } catch (error) {
        const errno = error as NodeJS.ErrnoException
        return storeFail(
          'STORE_UNAVAILABLE', 'S13',
          `${relative === '.' ? 'the workspace directory' : relative} cannot be written by this user: access failed with ${errno.code ?? 'an error'}`,
          [relative],
        )
      }
    }
    return storeOk(undefined)
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
/** The items a query selects, in the order the read holds them. */
function selected(items: readonly Held[], query: ItemQuery): readonly Held[] {
  const matched = items.filter((held) => (query.state === undefined || held.item.state === query.state)
    && (query.type === undefined || held.item.type === query.type))
  return query.limit === undefined ? matched : matched.slice(0, query.limit)
}

/**
 * The first record this transaction would leave naming `id`, or `undefined`. The two kinds
 * are the two ways one record holds another's id: a child's parent and a stored relation edge.
 * `skip` names every id the transaction touches, which are the ones judged from it instead.
 */
function referrerOf(records: Records, id: string, skip: readonly string[]): Referrer | undefined {
  for (const held of records.items) {
    if (skip.includes(held.item.id)) continue
    if (held.item.parent_id === id) return { kind: 'parent', id: held.item.id }
  }
  for (const held of records.items) {
    if (skip.includes(held.item.id)) continue
    const edge = held.item.relations?.find((relation) => relation.target === id)
    if (edge !== undefined) return { kind: 'relation', id: held.item.id, relation: edge.kind }
  }
  return undefined
}

export async function openWorkspace(
  root: string, options: ShardedStoreOptions = {},
): Promise<StoreResult<ShardedStore>> {
  const store = new ShardedStore(root, options)
  const identity = await store.identity()
  if (!identity.ok) return identity
  return storeOk(store)
}
