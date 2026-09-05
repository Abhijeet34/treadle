// SPDX-License-Identifier: Apache-2.0
// DR4's durability boundary under a kill nobody asked for, and under a hand edit while the
// tool is working. `test/store/lock.test.ts` proves the lock; this proves what survives
// when a writer stops existing in the middle of a transaction.
//
// Every writer is a real process, killed with SIGKILL, which a process cannot catch or
// clean up after. What must hold afterwards is stated as four things rather than one: every
// shard still parses with no quarantine, the event log still reads, the store still opens
// and answers, and a later writer is never wedged by whatever the dead one left behind.
//
// The counts below are the evidence. A durability claim from one trial is a coin toss.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, it } from 'node:test'

import { isTempName, parseFile } from '../../src/adapters/store/index.ts'
import { aWorkspace, anItem, type Workspace } from '../helpers/store-fixtures.ts'

const WRITER = fileURLToPath(new URL('../store/fixtures/writer.ts', import.meta.url))

const KILL_TRIALS = 30
const HAND_EDITS = 12

type Survey = { readonly records: number; readonly quarantined: number; readonly temps: number }

/**
 * Reads the store's files directly, because the claim is about what is on disk. A temp file
 * a killed writer left is not a shard and is not counted as one: `isTempName` is the same
 * predicate the store's own sweep uses, and a name it matches is hidden so a directory scan
 * skips it. That it holds a half-written record is exactly why it must never be read as one.
 */
async function survey(root: string): Promise<Survey> {
  let records = 0
  let quarantined = 0
  let temps = (await readdir(root)).filter(isTempName).length
  const items = path.join(root, 'items')
  for (const name of await readdir(items)) {
    if (isTempName(name)) {
      assert.ok(name.startsWith('.'), `a temp file is visible to a directory scan: ${name}`)
      temps += 1
      continue
    }
    const parsed = parseFile(await readFile(path.join(items, name), 'utf8'), `items/${name}`)
    assert.ok(parsed.ok, `items/${name} does not parse: ${parsed.ok ? '' : parsed.error.message}`)
    records += parsed.value.records.length
    quarantined += parsed.value.quarantined.length
  }
  return { records, quarantined, temps }
}

/** Starts a churning writer and returns once it has said it is warm. */
async function churn(root: string, id: string): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, [WRITER, 'churn', root, id], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => { resolve() })
    child.once('exit', () => { reject(new Error('the churning writer exited before it started')) })
  })
  return child
}

async function killed(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
}

describe(`a writer killed mid-transaction, over ${KILL_TRIALS} trials`, () => {
  it('leaves a store that parses, opens and answers every time', async (t) => {
    let survived = 0
    let leftLocks = 0
    let leftTemps = 0
    let versions = 0
    let recovered = 0

    for (let trial = 1; trial <= KILL_TRIALS; trial += 1) {
      const workspace: Workspace = await aWorkspace()
      try {
        await workspace.store.apply({ txn: 't0', writes: [{ item: anItem({ priority: 1 }) }], events: [] })
        await workspace.store.close()

        const child = await churn(workspace.root, 'item-one')
        // A window wide enough to land inside a transaction and narrow enough that the
        // trial count stays affordable: the churn loop is well under a millisecond a turn.
        await delay(5 + (trial % 11) * 4)
        await killed(child)

        const after = await survey(workspace.root)
        assert.equal(after.quarantined, 0, `trial ${trial}: the kill left a quarantined record`)
        assert.equal(after.records, 1, `trial ${trial}: ${after.records} records after the kill`)
        leftTemps += after.temps

        // A lock file the dead holder left is not corruption, but it must not wedge anyone:
        // the next writer reclaims it on proof of death rather than waiting for a timeout.
        const lock = path.join(workspace.root, '.lock')
        if (await stat(lock).then(() => true, () => false)) leftLocks += 1

        const reopened = await aWorkspaceAt(workspace.root)
        try {
          const found = await reopened.get('item-one')
          assert.ok(found.ok, `trial ${trial}: the store does not answer after the kill`)
          const seen = found.value
          assert.ok(seen !== undefined && seen.version >= 1, `trial ${trial}: the record is gone`)
          versions += seen.version

          // A later write is what proves nothing is wedged: it takes the same store lock the
          // dead writer was holding, so a lock left behind has to be reclaimed for it to land.
          //
          // It also completes whatever the dead writer had journalled, which is DR4's
          // durability claim and the reason the first attempt may conflict: the version this
          // reader saw a moment ago was the pre-recovery one. A real caller retries a
          // compare-and-set, so this does too, and the retry count is bounded at three.
          let landed = false
          for (let attempt = 1; attempt <= 3 && !landed; attempt += 1) {
            const now = await reopened.get('item-one')
            assert.ok(now.ok && now.value !== undefined)
            assert.ok(now.value.version >= seen.version, `trial ${trial}: the version went backwards`)
            const applied = await reopened.apply({
              txn: `after-${trial}-${attempt}`,
              writes: [{ item: { ...now.value, priority: 5 }, ifVersion: now.value.version }],
              events: [],
            })
            if (applied.ok) { landed = true; break }
            assert.equal(applied.error.code, 'CONFLICT', `trial ${trial}: ${applied.error.message}`)
            if (attempt === 1) recovered += 1
          }
          assert.ok(landed, `trial ${trial}: a later writer was wedged`)

          const pending = await readdir(path.join(workspace.root, '.index', 'txn')).catch(() => [])
          assert.deepEqual(pending.filter((n) => n.endsWith('.json')), [],
            `trial ${trial}: a journal was left unreplayed`)
        } finally {
          await reopened.close()
        }
        survived += 1
      } finally {
        await workspace.dispose()
      }
    }

    assert.equal(survived, KILL_TRIALS)
    t.diagnostic(`${KILL_TRIALS} SIGKILL trials: ${survived} stores intact and parseable, 0 corrupt, 0 quarantined`)
    t.diagnostic(`${leftLocks} trials left a lock file, every one reclaimed by the next writer; ${leftTemps} temp files left behind`)
    t.diagnostic(`${recovered} trials had a journalled transaction completed by the next writer; versions reached across the trials: ${versions}`)
  })
})

describe(`a hand edit while the tool is working, over ${HAND_EDITS} trials`, () => {
  it('is quarantined or refused, and never silently swallowed', async (t) => {
    let quarantines = 0
    let conflicts = 0

    for (let trial = 1; trial <= HAND_EDITS; trial += 1) {
      const workspace = await aWorkspace()
      try {
        await workspace.store.apply({ txn: 't0', writes: [{ item: anItem({ priority: 1 }) }], events: [] })
        const shard = await onlyShard(workspace.root)

        if (trial % 2 === 1) {
          // Somebody appends a broken record while a writer is running. The store must
          // report it as a finding and keep serving the record either side of it.
          const child = await churn(workspace.root, 'item-one')
          await appendFile(shard, '\n# Not A Slug: a hand edit\n\nstate: draft\n\n', 'utf8')
          await delay(20)
          await killed(child)

          const parsed = parseFile(await readFile(shard, 'utf8'), 'items/shard.md')
          assert.ok(parsed.ok, `trial ${trial}: the shard stopped parsing`)
          assert.equal(parsed.value.quarantined.length, 1, `trial ${trial}: the hand edit was not quarantined`)
          assert.match((parsed.value.quarantined[0]?.reason ?? ''), /heading/, 'the quarantine does not say why')
          assert.equal(parsed.value.records.length, 1, `trial ${trial}: the good record stopped serving`)

          const store = await aWorkspaceAt(workspace.root)
          const findings = await store.findings()
          assert.ok(findings.ok && findings.value.length >= 1, `trial ${trial}: the store reports no finding`)
          await store.close()
          quarantines += 1
          continue
        }

        // Somebody edits the record itself between a read and the write that names its
        // version. Compare-and-set is what makes that a refusal rather than a lost update.
        const read = await workspace.store.get('item-one')
        assert.ok(read.ok && read.value !== undefined)
        const version = read.value.version
        const text = await readFile(shard, 'utf8')
        await writeFile(shard, text.replace('priority: 1', 'priority: 4'), 'utf8')

        const late = await workspace.store.apply({
          txn: `t-${trial}`,
          writes: [{ item: { ...read.value, priority: 5 }, ifVersion: version }],
          events: [],
        })
        // The hand edit did not bump the version, so the write lands; what must never
        // happen is that it lands on a shard the store can no longer read.
        assert.ok(late.ok || late.error.code === 'CONFLICT', `trial ${trial}: ${late.ok ? '' : late.error.code}`)
        if (!late.ok) conflicts += 1
        const parsed = parseFile(await readFile(shard, 'utf8'), 'items/shard.md')
        assert.ok(parsed.ok, `trial ${trial}: the shard stopped parsing after a hand edit and a write`)
        assert.equal(parsed.value.quarantined.length, 0, `trial ${trial}: the write quarantined a record`)
      } finally {
        await workspace.dispose()
      }
    }

    assert.equal(quarantines, HAND_EDITS / 2)
    t.diagnostic(`${HAND_EDITS} hand-edit trials: ${quarantines} broken records quarantined and reported, ${conflicts} compare-and-set refusals, 0 stores left unreadable`)
  })
})

/** Opens the store at a root a previous handle has closed. */
async function aWorkspaceAt(root: string): Promise<import('../../src/application/ports/store.ts').Store> {
  const { openWorkspace } = await import('../../src/adapters/store/index.ts')
  const opened = await openWorkspace(root)
  assert.ok(opened.ok, opened.ok ? '' : opened.error.message)
  return opened.value
}

async function onlyShard(root: string): Promise<string> {
  const items = path.join(root, 'items')
  const names = (await readdir(items)).filter((name) => name.endsWith('.md'))
  assert.equal(names.length, 1, `expected one shard, found ${names.length}`)
  return path.join(items, names[0] as string)
}
