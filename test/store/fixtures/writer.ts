// SPDX-License-Identifier: Apache-2.0
// A separate process for the concurrency suite. Node's test runner runs its files in one
// process, and DR4's guarantee is about separate processes, so the writers have to be real
// ones: an in-process promise race would prove nothing about a lock file.
//
// Usage: writer.ts write <root> <id> | writer.ts hold <root> <ms> | writer.ts grab <root>
//        | writer.ts churn <root> <id>

import { setTimeout as delay } from 'node:timers/promises'

import { ShardedStore } from '../../../src/adapters/store/index.ts'
import { acquireLock } from '../../../src/adapters/store/index.ts'
import path from 'node:path'

const [mode, root, argument] = process.argv.slice(2)

async function write(): Promise<void> {
  const store = new ShardedStore(root as string)
  const started = Date.now()
  for (let attempt = 1; ; attempt += 1) {
    const found = await store.get(argument as string)
    if (!found.ok || found.value === undefined) {
      process.stdout.write(JSON.stringify({ ok: false, reason: 'not found' }))
      process.exitCode = 1
      return
    }
    const applied = await store.apply({
      txn: `txn-${process.pid}-${attempt}`,
      writes: [{ item: { ...found.value, priority: ((found.value.priority ?? 1) % 5) + 1 }, ifVersion: found.value.version }],
      events: [{
        id: `ev-${process.pid}-${attempt}`,
        at: '2026-09-01T10:00:00Z',
        actor: 'writer', actor_kind: 'process', entity_kind: 'work_item',
        entity: argument as string, op: 'update', txn: `txn-${process.pid}-${attempt}`,
      }],
    })
    if (applied.ok) {
      process.stdout.write(JSON.stringify({ ok: true, version: applied.value.writes[0]?.version, attempts: attempt, ms: Date.now() - started }))
      await store.close()
      return
    }
    if (applied.error.code !== 'CONFLICT') {
      process.stdout.write(JSON.stringify({ ok: false, code: applied.error.code, message: applied.error.message }))
      process.exitCode = 1
      await store.close()
      return
    }
  }
}

async function hold(): Promise<void> {
  const started = Date.now()
  const lock = await acquireLock(path.join(root as string, '.lock'))
  if (!lock.ok) {
    process.stdout.write(JSON.stringify({ ok: false, code: lock.error.code, message: lock.error.message }))
    process.exitCode = 1
    return
  }
  const waited = Date.now() - started
  await delay(Number(argument))
  await lock.value.release()
  process.stdout.write(JSON.stringify({ ok: true, waited }))
}

/** Takes the lock and never releases it, so the parent can kill it mid-hold. */
async function grab(): Promise<void> {
  const lock = await acquireLock(path.join(root as string, '.lock'))
  if (!lock.ok) { process.exitCode = 1; return }
  process.stdout.write('held\n')
  await delay(60_000)
}

/**
 * Writes in a loop and never stops, so the parent can SIGKILL it at an unpredictable point
 * inside a transaction, or SIGSTOP it there and let another writer reclaim the lock. It
 * prints one line before the first write so the parent knows the store is warm and the
 * signal lands mid-run, and one line per outcome so the parent can tell a refused write
 * from a landed one.
 */
async function churn(): Promise<void> {
  const store = new ShardedStore(root as string)
  process.stdout.write('churning\n')
  for (let attempt = 1; ; attempt += 1) {
    const found = await store.get(argument as string)
    if (!found.ok || found.value === undefined) return
    const applied = await store.apply({
      txn: `txn-${process.pid}-${attempt}`,
      writes: [{ item: { ...found.value, priority: ((found.value.priority ?? 1) % 5) + 1 }, ifVersion: found.value.version }],
      events: [{
        id: `ev-${process.pid}-${attempt}`,
        at: '2026-09-01T10:00:00Z',
        actor: 'churn', actor_kind: 'process', entity_kind: 'work_item',
        entity: argument as string, op: 'update', txn: `txn-${process.pid}-${attempt}`,
      }],
    })
    process.stdout.write(`${JSON.stringify(applied.ok ? { ok: true, version: applied.value.writes[0]?.version } : { ok: false, code: applied.error.code, rule: applied.error.rule })}\n`)
  }
}

const modes: Record<string, () => Promise<void>> = { write, hold, grab, churn }
await (modes[mode as string] ?? (async () => { process.exitCode = 2 }))()
