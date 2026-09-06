// SPDX-License-Identifier: Apache-2.0
// DR2's derived index, built with `node:sqlite`. It is a cache and never an authority
// (decision D1): every row in it was produced by parsing a committed file, deleting it at
// any moment is harmless, and no command answers from it without first establishing that
// no file changed since the row was written.
//
// Freshness is a stat per file, which DR2 measured at 0.27 ms across 24 shards and 296 ms
// across 50,000 per-item files; that number is what chose the layout. A file whose size or
// mtime moved is re-read and its rows are replaced in one transaction. An event file that
// only grew has the hash of its old prefix compared against the new file's first bytes, so
// an append re-indexes the append rather than the file.

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

import type { EventQuery, Finding, ItemQuery, StoreEvent } from '../../application/ports/store.ts'
import { DIR_MODE } from './atomic.ts'
import { eventFrom, eventRest } from './event-log.ts'

/**
 * What one file's re-index leaves the caller to act on: the cross-file duplicates it refused,
 * and whether another file's fingerprint was dropped because it clashed against this one.
 */
export type ReindexOutcome = {
  readonly clashes: readonly Finding[]
  readonly invalidated: boolean
}

export type Fingerprint = {
  readonly size: number
  readonly mtime: number
  readonly hash: string
  readonly lines: number
}

/** The columns a record is decoded from; `line` and `file` name it in a refusal. */
export type IndexedSource = Pick<IndexedItem, 'id' | 'file' | 'line' | 'source'>

export type IndexedItem = {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly type: string
  readonly state: string
  readonly parent: string | null
  readonly sprint: string | null
  readonly points: number | null
  readonly priority: number | null
  readonly version: number
  readonly assignee: string | null
  readonly filed_at: string
  readonly title: string
  readonly source: string
}

const SCHEMA = `
create table if not exists files (
  path text primary key, size integer not null, mtime real not null,
  hash text not null, lines integer not null default 0);
create table if not exists items (
  id text primary key, file text not null, line integer not null, type text not null,
  state text not null, parent text, sprint text, points integer, priority integer, version integer not null,
  assignee text, filed_at text not null, title text not null, source text not null);
create index if not exists items_file on items(file);
-- Both orders listItems can ask for. Every query it builds ends in an order by filed_at, id
-- with an optional limit, so an index that leads on the filter and continues in that order
-- lets SQLite stop at the limit instead of sorting every matching row, each of which carries
-- the record's whole source text. The index it replaces led on state and continued on
-- priority, which no query here ever asks for.
drop index if exists items_state;
create index if not exists items_state_filed on items(state, filed_at, id);
create index if not exists items_filed on items(filed_at, id);
create table if not exists events (
  id text primary key, at text not null, entity text not null, op text not null,
  actor text not null, txn text not null, file text not null, rest text not null);
create index if not exists events_file on events(file);
create index if not exists events_entity on events(entity, at);
-- \`against\` names the file whose copy won when this finding is a duplicate-id clash. A
-- clash is the one finding whose truth depends on another file, so when that file changes
-- or goes, the fingerprint of the file carrying the clash is dropped and it is re-read.
-- Without it a removed duplicate shard left the S3 on the surviving shard for good.
create table if not exists findings (
  file text not null, line integer not null, rule text not null, reason text not null, id text, against text);
create index if not exists findings_file on findings(file);
create index if not exists findings_against on findings(against);
`

/** Created before the version check, because the version is read out of it. */
const META_SCHEMA = 'create table if not exists meta (key text primary key, value text not null);'

/**
 * The index's own format. A change to a column re-derives every row rather than migrating
 * one: the index is a cache, so dropping it is the cheapest correct answer and the only one
 * that cannot leave a half-migrated table behind.
 */
const INDEX_FORMAT = '3'
const FORMAT_KEY = 'index_format'
const RESET = `
drop table if exists files;
drop table if exists items;
drop table if exists events;
drop table if exists findings;
`

/**
 * The load-time hierarchy verdict, cached beside the rows it was derived from.
 *
 * A stored verdict is trusted only while `HIERARCHY_DIRTY_KEY` names nothing outstanding.
 * `replaceRecordFile` merges what it moved into that marker inside the same transaction as
 * the row changes it describes, so a crash between the two leaves work to redo, discovered
 * from the durable marker on the next open, rather than a stale verdict silently reused.
 */
const HIERARCHY_KEY = 'hierarchy_cycle'

/**
 * What has moved since `HIERARCHY_KEY` was last written, merged in the same transaction as
 * the rows it describes. Absent means nothing has moved since; present but `moved` empty
 * with `full` false means rows changed but no parent edge did.
 */
const HIERARCHY_DIRTY_KEY = 'hierarchy_dirty'

/**
 * Past this many accumulated moved ids, the list is dropped for a `full` marker instead. A
 * bulk re-index is already paying a full parse of every file, so the whole walk it triggers
 * is cheaper than carrying tens of thousands of ids through a meta row.
 */
const HIERARCHY_MOVED_CAP = 64

export type HierarchyDirty = {
  readonly rows: boolean
  readonly moved: readonly string[]
  readonly full: boolean
}

/**
 * The index could not be opened, and deleting it did not help. The store turns this into a
 * refusal naming the path; a stack trace here read as "file is not a database" with the
 * remedy `treadle version`.
 */
export class IndexUnavailable extends Error {
  readonly path: string

  constructor(path: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.path = path
  }
}

/** The database and the two files WAL mode keeps beside it. */
function indexFiles(file: string): readonly string[] {
  return [file, `${file}-wal`, `${file}-shm`]
}

/** Bounded wait for the journal-mode switch. The window it covers is milliseconds wide. */
const WAL_DEADLINE_MS = 2_000

/** Synchronous, because `#open` is, and the alternative is a busy loop burning a core. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Switches the database to WAL, retrying while another process is doing the same thing.
 *
 * The busy timeout is not enough on its own here. Promoting to the exclusive lock this
 * pragma needs, while already holding a shared one and another connection holds a reserved
 * one, is the case SQLite refuses to wait on, because waiting could deadlock: the busy
 * handler is bypassed and `SQLITE_BUSY` is immediate. Only the run that creates the index is
 * exposed, since the pragma is a no-op once the file is in WAL, so a bounded retry closes
 * what the timeout cannot. Past the deadline the error is raised and the command boundary
 * turns it into an error object rather than a stack trace.
 */
function enterWal(db: DatabaseSync): void {
  const until = Date.now() + WAL_DEADLINE_MS
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec('pragma journal_mode = wal')
      return
    } catch (error) {
      if (Date.now() >= until) throw error
      pause(Math.min(25, attempt * 2))
    }
  }
}

export class IndexCache {
  readonly #file: string
  #db: DatabaseSync | undefined

  constructor(directory: string) {
    this.#file = path.join(directory, 'index.sqlite')
  }

  /**
   * Reopens after a deletion, which is what makes "deleting the index is always harmless"
   * true rather than hoped: a database that is not on disk has no fingerprints, so every
   * file reads as stale and the next refresh rebuilds it before any query runs.
   */
  #open(): DatabaseSync {
    if (this.#db !== undefined && existsSync(this.#file)) return this.#db
    if (this.#db !== undefined) {
      try { this.#db.close() } catch { /* already gone with its file */ }
      this.#db = undefined
    }
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: DIR_MODE })
    // A cache that will not open is deleted and rebuilt, which is the same answer as a
    // cache that is absent: nothing in it is authoritative. Only a second failure, such as
    // a directory sitting at the path or a parent that refuses writes, is a refusal.
    try {
      this.#db = this.#openFresh()
    } catch (first) {
      for (const stale of indexFiles(this.#file)) {
        try { rmSync(stale, { force: true }) } catch { /* a directory at the path; the retry says so */ }
      }
      try {
        this.#db = this.#openFresh()
      } catch (second) {
        throw new IndexUnavailable(this.#file, second ?? first)
      }
    }
    return this.#db
  }

  #openFresh(): DatabaseSync {
    const db = new DatabaseSync(this.#file)
    // The busy timeout is armed before anything that can meet another process's lock, and
    // the journal-mode switch is the first such statement: it takes an exclusive lock on a
    // database that is not yet in WAL, which is every database on the run that creates it.
    // Armed second, that switch had nothing to wait with and raised SQLITE_BUSY the moment
    // two commands opened a fresh index together.
    db.exec('pragma busy_timeout = 5000')
    enterWal(db)
    db.exec('pragma synchronous = normal')
    db.exec(META_SCHEMA)
    const format = db.prepare('select value from meta where key = ?').get(FORMAT_KEY) as unknown as { value: string } | undefined
    if (format?.value !== INDEX_FORMAT) {
      db.exec(RESET)
      db.exec('delete from meta')
      db.exec(SCHEMA)
      db.prepare('insert into meta (key, value) values (?, ?)').run(FORMAT_KEY, INDEX_FORMAT)
    } else {
      db.exec(SCHEMA)
    }
    return db
  }

  fingerprints(): ReadonlyMap<string, Fingerprint> {
    const rows = this.#open().prepare('select path, size, mtime, hash, lines from files').all()
    return new Map(rows.map((row) => {
      const r = row as unknown as { path: string } & Fingerprint
      return [r.path, { size: r.size, mtime: r.mtime, hash: r.hash, lines: r.lines }]
    }))
  }

  /**
   * Replaces one file's rows as a unit, so a half-indexed file is never queryable.
   *
   * The unit is applied as a difference rather than as a drop and a reload. Every other
   * column is derived from `source`, so a row whose id, line and source are unchanged is the
   * row the reload would have written, and re-writing it costs three index updates to reach
   * the same state. Appending one record to a 2,176-record shard rewrites the whole file and
   * so re-indexes it whole, and that is what a create pays for on the command after it.
   */
  replaceRecordFile(
    file: string,
    fingerprint: Fingerprint,
    items: readonly IndexedItem[],
    findings: readonly Finding[],
  ): ReindexOutcome {
    const db = this.#open()
    const clashes: { finding: Finding; against: string }[] = []
    const moved: string[] = []
    let changed = false
    db.exec('begin immediate')
    try {
      const previous = new Map<string, { line: number; source: string; parent: string | null }>()
      for (const row of db.prepare('select id, line, source, parent from items where file = ?').all(file) as unknown as readonly { id: string; line: number; source: string; parent: string | null }[]) {
        previous.set(row.id, { line: row.line, source: row.source, parent: row.parent })
      }
      db.prepare('delete from events where file = ?').run(file)
      db.prepare('delete from findings where file = ?').run(file)

      const drop = db.prepare('delete from items where id = ? and file = ?')
      const wanted = new Set(items.map((item) => item.id))
      for (const id of previous.keys()) {
        // A parent edge that disappeared cannot close a cycle, so a deletion is not a moved
        // edge however many rows it takes out. It can clear one, which `changed` carries.
        if (wanted.has(id)) continue
        drop.run(id, file)
        changed = true
      }

      const insert = db.prepare(`insert into items
        (id, file, line, type, state, parent, sprint, points, priority, version, assignee, filed_at, title, source)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      const holder = db.prepare('select file from items where id = ?')
      for (const item of items) {
        const was = previous.get(item.id)
        if (was !== undefined && was.line === item.line && was.source === item.source) continue
        if (item.parent !== null && (was === undefined || was.parent !== item.parent)) moved.push(item.id)
        if (was !== undefined) drop.run(item.id, file)
        changed = true
        try {
          insert.run(item.id, item.file, item.line, item.type, item.state, item.parent,
            item.sprint, item.points, item.priority, item.version, item.assignee,
            item.filed_at, item.title, item.source)
        } catch {
          // The id is already in the store, and because the parser refuses a repeat inside
          // one file, "already" now means another shard. That is the half of D1 obligation 4
          // no single file can see, and this primary key is its one owner: the finding it
          // raises is what `duplicateRefusal` reads, and what stops a write resolving a
          // cross-shard duplicate by taking whichever copy this insert happened to keep.
          clashes.push({
            against: (holder.get(item.id) as unknown as { file: string } | undefined)?.file ?? file,
            finding: {
              file, line: item.line, rule: 'S3', id: item.id,
              reason: `${item.id} is already a record in this store; the copy in ${file} line ${item.line} is quarantined`,
            },
          })
        }
      }
      this.#insertFindings(findings)
      this.#insertClashes(clashes)
      this.#setFingerprint(file, fingerprint)
      if (changed) this.#mergeHierarchyDirty(db, moved)
      const invalidated = changed && this.#invalidateAgainst(file)
      db.exec('commit')
      return { clashes: clashes.map((clash) => clash.finding), invalidated }
    } catch (error) {
      db.exec('rollback')
      throw error
    }
  }

  /**
   * Drops the fingerprint of every other file carrying a clash against `file`, so the next
   * refresh pass re-reads it and re-decides the clash against what `file` now holds.
   */
  #invalidateAgainst(file: string): boolean {
    const dropped = this.#open()
      .prepare('delete from files where path in (select file from findings where against = ? and file != ?)')
      .run(file, file)
    return Number(dropped.changes) > 0
  }

  #insertClashes(clashes: readonly { finding: Finding; against: string }[]): void {
    if (clashes.length === 0) return
    const insert = this.#open().prepare(
      'insert into findings (file, line, rule, reason, id, against) values (?, ?, ?, ?, ?, ?)',
    )
    for (const { finding, against } of clashes) {
      insert.run(finding.file, finding.line, finding.rule, finding.reason, finding.id ?? null, against)
    }
  }

  /** Folds this file's row change into the durable dirty marker, inside the caller's transaction. */
  #mergeHierarchyDirty(db: DatabaseSync, moved: readonly string[]): void {
    const existing = db.prepare('select value from meta where key = ?').get(HIERARCHY_DIRTY_KEY) as unknown as { value: string } | undefined
    const parsed = existing === undefined
      ? undefined
      : JSON.parse(existing.value) as { moved?: readonly string[]; full?: boolean }
    let dirty: string
    if (parsed?.full === true) {
      dirty = JSON.stringify({ rows: true, full: true })
    } else {
      const combined = new Set(parsed?.moved ?? [])
      for (const id of moved) combined.add(id)
      dirty = combined.size > HIERARCHY_MOVED_CAP
        ? JSON.stringify({ rows: true, full: true })
        : JSON.stringify({ rows: true, moved: [...combined] })
    }
    db.prepare('insert or replace into meta (key, value) values (?, ?)').run(HIERARCHY_DIRTY_KEY, dirty)
  }

  /**
   * `lines` is parallel to `events`: the line each was read from, which is what a finding
   * on one of them names.
   */
  replaceEventFile(
    file: string,
    fingerprint: Fingerprint,
    events: readonly StoreEvent[],
    lines: readonly number[],
    findings: readonly Finding[],
    append: boolean,
  ): ReindexOutcome {
    const db = this.#open()
    const clashes: { finding: Finding; against: string }[] = []
    db.exec('begin immediate')
    try {
      if (!append) this.#dropRows(file)
      const insert = db.prepare(`insert into events
        (id, at, entity, op, actor, txn, file, rest) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      const holder = db.prepare('select file from events where id = ?')
      events.forEach((event, i) => {
        try {
          insert.run(event.id, event.at, event.entity, event.op, event.actor, event.txn, file,
            eventRest(event))
        } catch {
          // The id is this table's primary key and its one owner across files. An `insert
          // or ignore` here kept whichever copy was indexed first and dropped the other
          // without a word: a second file carrying an existing id replaced the real event
          // in every read while `doctor` reported the store clean.
          const first = (holder.get(event.id) as unknown as { file: string } | undefined)?.file ?? file
          clashes.push({
            against: first,
            finding: {
              file, line: lines[i] as number, rule: 'S14', id: event.id,
              reason: `event ${event.id} at ${file} line ${lines[i]} repeats an id ${first} already carries; this copy is not served`,
            },
          })
        }
      })
      this.#insertFindings(findings)
      this.#insertClashes(clashes)
      this.#setFingerprint(file, fingerprint)
      const invalidated = !append && this.#invalidateAgainst(file)
      db.exec('commit')
      return { clashes: clashes.map((clash) => clash.finding), invalidated }
    } catch (error) {
      db.exec('rollback')
      throw error
    }
  }

  dropFile(file: string): boolean {
    const db = this.#open()
    db.exec('begin immediate')
    try {
      this.#dropRows(file)
      db.prepare('delete from files where path = ?').run(file)
      this.#forgetHierarchyVerdict()
      const invalidated = this.#invalidateAgainst(file)
      db.exec('commit')
      return invalidated
    } catch (error) {
      db.exec('rollback')
      throw error
    }
  }

  #dropRows(file: string): void {
    const db = this.#open()
    db.prepare('delete from items where file = ?').run(file)
    db.prepare('delete from events where file = ?').run(file)
    db.prepare('delete from findings where file = ?').run(file)
  }

  #setFingerprint(file: string, fingerprint: Fingerprint): void {
    this.#open().prepare(
      'insert or replace into files (path, size, mtime, hash, lines) values (?, ?, ?, ?, ?)',
    ).run(file, fingerprint.size, fingerprint.mtime, fingerprint.hash, fingerprint.lines)
  }

  #insertFindings(findings: readonly Finding[]): void {
    if (findings.length === 0) return
    const insert = this.#open().prepare(
      'insert into findings (file, line, rule, reason, id) values (?, ?, ?, ?, ?)',
    )
    for (const finding of findings) {
      insert.run(finding.file, finding.line, finding.rule, finding.reason, finding.id ?? null)
    }
  }

  itemRow(id: string): IndexedItem | undefined {
    const row = this.#open().prepare('select * from items where id = ?').get(id)
    return row === undefined ? undefined : (row as unknown as IndexedItem)
  }

  /**
   * The parent edges, for the load-time hierarchy cycle check. Only rows that carry a parent
   * are edges, and a node without one cannot sit on a cycle, so the `parent is not null`
   * clause is the whole edge set rather than a sample of it.
   */
  parentEdges(): ReadonlyMap<string, string> {
    const rows = this.#open()
      .prepare('select id, parent from items where parent is not null')
      .all() as unknown as readonly { id: string; parent: string }[]
    const edges = new Map<string, string>()
    for (const row of rows) edges.set(row.id, row.parent)
    return edges
  }

  /** One parent edge, for a walk that follows the ancestry of a node whose edge moved. */
  parentOf(id: string): string | undefined {
    const row = this.#open()
      .prepare('select parent from items where id = ?')
      .get(id) as unknown as { parent: string | null } | undefined
    return row?.parent ?? undefined
  }

  /**
   * A meta row as JSON, or undefined when it is absent or not JSON. A row that does not
   * parse is treated as never written, so a damaged cache costs a recompute and not a
   * stack trace; the same rule the whole index lives by.
   */
  #metaJson(key: string): unknown {
    const row = this.#open()
      .prepare('select value from meta where key = ?')
      .get(key) as unknown as { value: string } | undefined
    if (row === undefined) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  /** The stored verdict as written, or undefined when no verdict has ever been computed. */
  hierarchyVerdict(): string | undefined {
    const parsed = this.#metaJson(HIERARCHY_KEY)
    return parsed === undefined ? undefined : JSON.stringify(parsed)
  }

  /** What has moved since that verdict was written, or undefined when nothing has. */
  hierarchyDirty(): HierarchyDirty | undefined {
    const parsed = this.#metaJson(HIERARCHY_DIRTY_KEY) as { rows?: boolean; moved?: readonly string[]; full?: boolean } | undefined
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined
    return { rows: parsed.rows ?? false, moved: parsed.moved ?? [], full: parsed.full ?? false }
  }

  /** Writes the verdict and clears the dirty marker it accounts for, as one transaction. */
  setHierarchyVerdict(value: string): void {
    const db = this.#open()
    db.exec('begin immediate')
    try {
      db.prepare('insert or replace into meta (key, value) values (?, ?)').run(HIERARCHY_KEY, value)
      db.prepare('delete from meta where key = ?').run(HIERARCHY_DIRTY_KEY)
      db.exec('commit')
    } catch (error) {
      db.exec('rollback')
      throw error
    }
  }

  #forgetHierarchyVerdict(): void {
    this.#open().prepare('delete from meta where key = ?').run(HIERARCHY_KEY)
  }

  /**
   * Streamed, and projected to what decoding a record needs. Every other column is derived
   * from `source` and the decoder derives it again; an array of 50,000 whole rows was held
   * beside the items decoded from it, and the read every command performs paid for both.
   */
  listItems(query: ItemQuery): Iterable<IndexedSource> {
    const where: string[] = []
    const values: (string | number)[] = []
    if (query.state !== undefined) { where.push('state = ?'); values.push(query.state) }
    if (query.type !== undefined) { where.push('type = ?'); values.push(query.type) }
    if (query.sprint !== undefined) { where.push('sprint = ?'); values.push(query.sprint) }
    const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
    const limit = query.limit === undefined ? '' : ' limit ?'
    if (query.limit !== undefined) values.push(query.limit)
    return this.#open()
      .prepare(`select id, file, line, source from items${clause} order by filed_at, id${limit}`)
      .iterate(...values) as unknown as Iterable<IndexedSource>
  }

  listEvents(query: EventQuery): readonly StoreEvent[] {
    const where: string[] = []
    const values: (string | number)[] = []
    if (query.entity !== undefined) { where.push('entity = ?'); values.push(query.entity) }
    if (query.from !== undefined) { where.push('at >= ?'); values.push(query.from) }
    if (query.to !== undefined) { where.push('at < ?'); values.push(query.to) }
    const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
    const limit = query.limit === undefined ? '' : ' limit ?'
    if (query.limit !== undefined) values.push(query.limit)
    const rows = this.#open()
      .prepare(`select id, at, entity, op, actor, txn, rest from events${clause} order by at, rowid${limit}`)
      .all(...values) as unknown as readonly (Record<string, string> & { rest: string })[]
    return rows.map((row) => eventFrom(row, row.rest))
  }

  /**
   * The write that last moved a record, which a conflict names (interface A.6 rule 5).
   *
   * `rowid` and not `id` breaks the tie. Instants are second-resolution, so two writes in
   * one second are routine under an agent, and the ids are random: ordering by id then
   * picks a lexicographic winner rather than the later write. Rows enter this table in the
   * order the append-only log holds them, and an `at` never spans two files because the file
   * is chosen by the month of that same instant, so `rowid` is that append order.
   */
  lastEventFor(entity: string): StoreEvent | undefined {
    const row = this.#open()
      .prepare('select id, at, entity, op, actor, txn, rest from events where entity = ? order by at desc, rowid desc limit 1')
      .get(entity) as unknown as (Record<string, string> & { rest: string }) | undefined
    return row === undefined ? undefined : eventFrom(row, row.rest)
  }

  findings(): readonly Finding[] {
    const rows = this.#open()
      .prepare('select file, line, rule, reason, id from findings order by file, line')
      .all() as unknown as readonly (Finding & { id: string | null })[]
    return rows.map((row) => (row.id === null
      ? { file: row.file, line: row.line, rule: row.rule, reason: row.reason }
      : { file: row.file, line: row.line, rule: row.rule, reason: row.reason, id: row.id }))
  }

  close(): void {
    if (this.#db === undefined) return
    try { this.#db.close() } catch { /* the file may already be gone */ }
    this.#db = undefined
  }
}
