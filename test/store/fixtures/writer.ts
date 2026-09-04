// SPDX-License-Identifier: Apache-2.0
// A separate process for the concurrency suite. Node's test runner runs its files in one
// process, and DR4's guarantee is about separate processes, so the writers have to be real
// ones: an in-process promise race would prove nothing about a lock file.
//
// Usage: writer.ts write <root> <id> | writer.ts hold <root> <ms> | writer.ts grab <root>

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

const modes: Record<string, () => Promise<void>> = { write, hold, grab }
await (modes[mode as string] ?? (async () => { process.exitCode = 2 }))()
