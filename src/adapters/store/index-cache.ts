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
create index if not exists items_state on items(state, priority);
create table if not exists events (
  id text primary key, at text not null, entity text not null, op text not null,
  actor text not null, txn text not null, file text not null, source text not null);
create index if not exists events_file on events(file);
create index if not exists events_entity on events(entity, at);
create table if not exists findings (
  file text not null, line integer not null, rule text not null, reason text not null, id text);
create index if not exists findings_file on findings(file);
`

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
    db.exec('pragma journal_mode = wal')
    db.exec('pragma synchronous = normal')
    db.exec('pragma busy_timeout = 5000')
    db.exec(SCHEMA)
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

  /** Replaces one file's rows as a unit, so a half-indexed file is never queryable. */
  replaceRecordFile(
    file: string,
    fingerprint: Fingerprint,
    items: readonly IndexedItem[],
    findings: readonly Finding[],
  ): readonly Finding[] {
    const db = this.#open()
    const clashes: Finding[] = []
    db.exec('begin immediate')
    try {
      this.#dropRows(file)
      const insert = db.prepare(`insert into items
        (id, file, line, type, state, parent, sprint, points, priority, version, assignee, filed_at, title, source)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const item of items) {
        try {
          insert.run(item.id, item.file, item.line, item.type, item.state, item.parent,
            item.sprint, item.points, item.priority, item.version, item.assignee,
            item.filed_at, item.title, item.source)
        } catch {
          // The id is already in the store from another file. D1 obligation 4: a named
          // refusal for this record, never a silent first-match, and the rest keeps serving.
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
    return clashes
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
        (id, at, entity, op, actor, txn, file, source) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const event of events) {
        insert.run(event.id, event.at, event.entity, event.op, event.actor, event.txn, file,
          JSON.stringify(event))
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

  /** id and parent for every indexed record, for the load-time hierarchy cycle check. */
  parentEdges(): readonly (readonly [string, string | null, string, string, number | null])[] {
    const rows = this.#open().prepare('select id, parent, type, state, points from items').all()
    return rows.map((row) => {
      const r = row as unknown as { id: string; parent: string | null; type: string; state: string; points: number | null }
      return [r.id, r.parent, r.type, r.state, r.points] as const
    })
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
      .prepare(`select source from events${clause} order by at, id${limit}`)
      .all(...values) as unknown as readonly { source: string }[]
    return rows.map((row) => JSON.parse(row.source) as StoreEvent)
  }

  /** The write that last moved a record, which a conflict names (interface A.6 rule 5). */
  lastEventFor(entity: string): StoreEvent | undefined {
    const row = this.#open()
      .prepare('select source from events where entity = ? order by at desc, id desc limit 1')
      .get(entity) as unknown as { source: string } | undefined
    return row === undefined ? undefined : (JSON.parse(row.source) as StoreEvent)
  }

  findings(): readonly Finding[] {
    const rows = this.#open()
      .prepare('select file, line, rule, reason, id from findings order by file, line')
      .all() as unknown as readonly (Finding & { id: string | null })[]
    return rows.map((row) => (row.id === null
      ? { file: row.file, line: row.line, rule: row.rule, reason: row.reason }
      : { file: row.file, line: row.line, rule: row.rule, reason: row.reason, id: row.id }))
  }

  /** Deletes the database. The next call reopens an empty one and the store rebuilds it. */
  reset(): void {
    this.close()
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${this.#file}${suffix}`, { force: true })
    }
  }

  close(): void {
    if (this.#db === undefined) return
    try { this.#db.close() } catch { /* the file may already be gone */ }
    this.#db = undefined
  }
}
