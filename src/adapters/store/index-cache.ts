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
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import type { EventQuery, Finding, ItemQuery, StoreEvent } from '../../application/ports/store.ts'
import { DIR_MODE } from './atomic.ts'
import { eventFrom, eventRest } from './event-log.ts'

/**
 * What one record file's re-index leaves the caller to act on: the cross-shard duplicates it
 * refused, and the ids whose parent edge moved, which are the only nodes a cycle the store
 * did not already know about can pass through.
 */
export type RecordFileOutcome = {
  readonly clashes: readonly Finding[]
  /** Any row inserted or deleted, which is what can clear a cycle as well as close one. */
  readonly changed: boolean
  readonly movedParents: readonly string[]
}

export type Fingerprint = {
  readonly size: number
  readonly mtime: number
  readonly hash: string
  readonly lines: number
}

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
create table if not exists findings (
  file text not null, line integer not null, rule text not null, reason text not null, id text);
create index if not exists findings_file on findings(file);
`

/** Created before the version check, because the version is read out of it. */
const META_SCHEMA = 'create table if not exists meta (key text primary key, value text not null);'

/**
 * The index's own format. A change to a column re-derives every row rather than migrating
 * one: the index is a cache, so dropping it is the cheapest correct answer and the only one
 * that cannot leave a half-migrated table behind.
 */
const INDEX_FORMAT = '2'
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
 * It is dropped inside the same transaction that changes any item row, so a verdict that
 * survives a refresh was computed over exactly the row set that refresh left behind, and a
 * crash between the two leaves no verdict rather than a stale one.
 */
const HIERARCHY_KEY = 'hierarchy_cycle'

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
    this.#db = db
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
  ): RecordFileOutcome {
    const db = this.#open()
    const clashes: Finding[] = []
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
            file, line: item.line, rule: 'S3', id: item.id,
            reason: `${item.id} is already a record in this store; the copy in ${file} line ${item.line} is quarantined`,
          })
        }
      }
      this.#insertFindings([...findings, ...clashes])
      this.#setFingerprint(file, fingerprint)
      db.exec('commit')
    } catch (error) {
      db.exec('rollback')
      throw error
    }
    return { clashes, changed, movedParents: moved }
  }

  replaceEventFile(
    file: string,
    fingerprint: Fingerprint,
    events: readonly StoreEvent[],
    findings: readonly Finding[],
    append: boolean,
  ): void {
    const db = this.#open()
    db.exec('begin immediate')
    try {
      if (!append) this.#dropRows(file)
      const insert = db.prepare(`insert or ignore into events
        (id, at, entity, op, actor, txn, file, rest) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const event of events) {
        insert.run(event.id, event.at, event.entity, event.op, event.actor, event.txn, file,
          eventRest(event))
      }
      this.#insertFindings(findings)
      this.#setFingerprint(file, fingerprint)
      db.exec('commit')
    } catch (error) {
      db.exec('rollback')
      throw error
    }
  }

  dropFile(file: string): void {
    const db = this.#open()
    db.exec('begin immediate')
    try {
      this.#dropRows(file)
      db.prepare('delete from files where path = ?').run(file)
      this.#forgetHierarchyVerdict()
      db.exec('commit')
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

  /** The stored verdict as written, or undefined when an item row has moved since. */
  hierarchyVerdict(): string | undefined {
    const row = this.#open()
      .prepare('select value from meta where key = ?')
      .get(HIERARCHY_KEY) as unknown as { value: string } | undefined
    return row?.value
  }

  setHierarchyVerdict(value: string): void {
    this.#open()
      .prepare('insert or replace into meta (key, value) values (?, ?)')
      .run(HIERARCHY_KEY, value)
  }

  #forgetHierarchyVerdict(): void {
    this.#open().prepare('delete from meta where key = ?').run(HIERARCHY_KEY)
  }

  listItems(query: ItemQuery): readonly IndexedItem[] {
    const where: string[] = []
    const values: (string | number)[] = []
    if (query.state !== undefined) { where.push('state = ?'); values.push(query.state) }
    if (query.type !== undefined) { where.push('type = ?'); values.push(query.type) }
    if (query.sprint !== undefined) { where.push('sprint = ?'); values.push(query.sprint) }
    const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
    const limit = query.limit === undefined ? '' : ' limit ?'
    if (query.limit !== undefined) values.push(query.limit)
    return this.#open()
      .prepare(`select * from items${clause} order by filed_at, id${limit}`)
      .all(...values) as unknown as readonly IndexedItem[]
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
