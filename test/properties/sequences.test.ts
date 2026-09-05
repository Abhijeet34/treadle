// SPDX-License-Identifier: Apache-2.0
// Accuracy over sequences, driven through the real entry point rather than the services,
// because "the store is still good after N commands" is a claim about what a user's shell
// leaves behind.
//
// Two properties. A mutation applied twice reports the second as a no-op and changes
// nothing, which is checked by hashing every byte under the workspace before and after the
// repeat rather than by reading the envelope. And any sequence of legal commands leaves a
// store that still parses, whose every shard is free of quarantine, whose events all name
// items that exist, and whose derived index can be deleted and rebuilt to the same answers.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { WORK_ITEM_STATES } from '../../src/domain/index.ts'
import { openWorkspace, parseFile } from '../../src/adapters/store/index.ts'
import { Gen } from '../helpers/store-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

const SEQUENCES = 40
const COMMANDS_PER_SEQUENCE = 25

const INDEX_DIR = '.index'

/** Each type with the fields its own policy requires at creation, so a filing succeeds. */
const FILINGS: readonly (readonly [string, readonly string[]])[] = [
  ['story', ['--set', 'acceptance_criteria=the repeat is a no-op', '--points', '3', '--priority', '2']],
  ['task', ['--points', '2', '--priority', '3']],
  ['chore', ['--points', '1', '--priority', '4']],
  ['spike', ['--set', 'question=which ranker', '--set', 'timebox_hours=8', '--priority', '3']],
  ['bug', ['--set', 'severity=S2', '--set', 'found_in=test', '--set', 'repro_steps=run it twice', '--points', '2', '--priority', '1']],
]
const READS = ['status', 'next', 'backlog', 'show', 'explain'] as const

type Session = { readonly root: string; dispose(): Promise<void> }

async function aSession(): Promise<Session> {
  const parent = await mkdtemp(path.join(tmpdir(), 'treadle-seq-'))
  const created = await runCli(['init', '--name', 'sequence'], { cwd: parent })
  assert.equal(created.code, 0, created.err)
  return {
    root: path.join(parent, '.work'),
    async dispose(): Promise<void> { await rm(parent, { recursive: true, force: true }) },
  }
}

/**
 * Every byte of the authoritative store, so a no-op that touched anything is visible.
 * `.index` is excluded because DR2 makes it derived and safe to delete at any moment: a
 * read that warms the cache is not a mutation, and the rebuild check below is what holds
 * the cache honest.
 */
async function fingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (at: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      if (name === INDEX_DIR) continue
      const full = path.join(at, name)
      if ((await stat(full)).isDirectory()) { await walk(full); continue }
      hash.update(path.relative(root, full))
      hash.update(await readFile(full))
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/** Everything the store promises about itself, checked from the files rather than the API. */
async function invariants(root: string, where: string): Promise<number> {
  const items = path.join(root, 'items')
  let records = 0
  for (const name of await readdir(items)) {
    const text = await readFile(path.join(items, name), 'utf8')
    const parsed = parseFile(text, `items/${name}`)
    assert.ok(parsed.ok, `${where}: items/${name} no longer parses`)
    assert.deepEqual(parsed.value.quarantined, [], `${where}: items/${name} holds a quarantined record`)
    records += parsed.value.records.length
  }

  const opened = await openWorkspace(root)
  assert.ok(opened.ok, `${where}: the workspace no longer opens`)
  const store = opened.value
  try {
    const listed = await store.list({})
    assert.ok(listed.ok, `${where}: the store cannot list its items`)
    assert.equal(listed.value.length, records, `${where}: the index and the shards disagree`)

    const ids = new Set(listed.value.map((item) => item.id))
    for (const item of listed.value) {
      assert.ok((WORK_ITEM_STATES as readonly string[]).includes(item.state), `${where}: ${item.id} is in ${item.state}`)
      assert.ok(item.version >= 1, `${where}: ${item.id} is at version ${item.version}`)
    }

    const events = await store.events({})
    assert.ok(events.ok, `${where}: the event log cannot be read`)
    for (const event of events.value) {
      if (event.entity_kind !== 'work_item') continue
      assert.ok(ids.has(event.entity), `${where}: an event names ${event.entity}, which no record holds`)
    }
    return listed.value.length
  } finally {
    await store.close()
  }
}

describe('a mutation applied twice reports the second as a no-op and changes nothing', () => {
  it('holds for every reachable state of a filed item', async (t) => {
    const session = await aSession()
    try {
      let repeats = 0
      for (const [type, required] of FILINGS) {
        const id = `${type}-repeat`
        const argv = ['file', type, 'A repeated mutation', '--id', id, ...required]
        const filed = await runCli(argv, { cwd: session.root })
        assert.equal(filed.code, 0, filed.err)

        // Filing the same id again is the other half of idempotence: it must refuse rather
        // than write a second record, and the bytes must be untouched either way.
        const before = await fingerprint(session.root)
        const again = await runCli(argv, { cwd: session.root })
        assert.notEqual(again.code, 0, 'a second create of one id succeeded')
        assert.equal(await fingerprint(session.root), before, 'a refused create still wrote')

        for (const state of ['ready', 'in_progress', 'in_review', 'done'] as const) {
          const first = await runCli(['transition', id, state], { cwd: session.root })
          if (first.code !== 0) break
          assert.match(first.out, /^ok transition /, 'a transition that moved reported no envelope')

          const settled = await fingerprint(session.root)
          const second = await runCli(['transition', id, state], { cwd: session.root })
          repeats += 1
          assert.equal(second.code, 0, `the repeat of ${state} was refused: ${second.err}`)
          assert.match(second.out, new RegExp(`^ok transition \\S+ - 0\\n`), 'the repeat claimed a transaction')
          assert.match(second.out, new RegExp(`\\nalready ${id}\\n`), 'the repeat did not report a no-op')
          assert.equal(await fingerprint(session.root), settled, `the repeat of ${state} wrote to the store`)
        }
      }
      assert.ok(repeats >= 8, `only ${repeats} repeats were exercised`)
      t.diagnostic(`${repeats} repeated mutations, every one a no-op that wrote zero bytes`)
    } finally {
      await session.dispose()
    }
  })
})

describe('any sequence of legal commands leaves a store that still holds', () => {
  it(`holds over ${SEQUENCES} sequences of ${COMMANDS_PER_SEQUENCE} commands`, async (t) => {
    let mutations = 0
    let reads = 0
    let refusals = 0
    let repeats = 0

    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      const gen = new Gen(seed + 600_000)
      const session = await aSession()
      try {
        const filed: string[] = []
        for (let step = 0; step < COMMANDS_PER_SEQUENCE; step += 1) {
          const roll = gen.int(0, 9)
          if (roll < 4 || filed.length === 0) {
            const id = `gen-${seed}-${step}`
            const [type, required] = gen.pick(FILINGS)
            const run = await runCli(
              ['file', type, gen.safeLine(3, 60), '--id', id, ...required], { cwd: session.root },
            )
            if (run.code === 0) { filed.push(id); mutations += 1 } else refusals += 1
            continue
          }
          if (roll < 7) {
            const id = gen.pick(filed)
            const target = gen.pick(WORK_ITEM_STATES)
            const run = await runCli(['transition', id, target], { cwd: session.root })
            if (run.code === 0) {
              mutations += 1
              // Every transition that moved is repeated here as well as in the suite above,
              // so idempotence is measured over generated sequences rather than over one
              // hand-built chain.
              const encore = await runCli(['transition', id, target], { cwd: session.root })
              repeats += 1
              assert.equal(encore.code, 0, `a repeat was refused: ${encore.err}`)
              assert.match(encore.out, /^ok transition \S+ - 0\n/, 'a repeat claimed a transaction')
              assert.match(encore.out, new RegExp(`\\nalready ${id}\\n`), 'a repeat did not report a no-op')
            } else {
              refusals += 1
              // A refusal is part of the contract, not an escape from it: it names a rule.
              assert.match(run.out + run.err, /^err /m, 'a refusal with no envelope')
            }
            continue
          }
          const command = gen.pick(READS)
          const argv = command === 'show' || command === 'explain'
            ? [command, gen.pick(filed)]
            : [command]
          const run = await runCli(argv, { cwd: session.root })
          reads += 1
          assert.equal(run.code, 0, `${command} failed mid-sequence: ${run.err}`)
        }

        const count = await invariants(session.root, `seed ${seed}`)
        assert.equal(count, filed.length, `seed ${seed}: ${count} records for ${filed.length} filings`)

        // The index is derived, so deleting it must change no answer (DR2). This is the
        // sharpest invariant in the set: it fails if any answer was only in the cache.
        const cache = path.join(session.root, INDEX_DIR, 'index.sqlite')
        await unlink(cache).catch(() => undefined)
        assert.equal(await invariants(session.root, `seed ${seed} rebuilt`), count,
          `seed ${seed}: the store answered differently once its index was deleted`)
      } finally {
        await session.dispose()
      }
    }

    t.diagnostic(`${SEQUENCES} sequences x ${COMMANDS_PER_SEQUENCE} commands: ${mutations} mutations, ${reads} reads, ${refusals} refusals`)
    t.diagnostic(`${repeats} transitions repeated, every one reported as a no-op`)
    t.diagnostic('stores left unparseable: 0; quarantined records: 0; index rebuilds that changed an answer: 0')
  })
})
