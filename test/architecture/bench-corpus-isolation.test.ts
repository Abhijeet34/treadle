// SPDX-License-Identifier: Apache-2.0
// The benchmark rig hands each run a private corpus. That is a property of the rig rather
// than of the product, and it is tested here for the reason the rig exists at all: every
// axis mutates the corpus it measures, so two runs sharing one root produce figures that
// look ordinary and describe a corpus neither of them was ever in. A crash would be safe;
// silent agreement on wrong numbers is not, and docs/architecture/history/BENCHMARKS-2026-09.md publishes them as fact.

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { acquireCorpus, type CorpusSpec } from '../../bench/corpus.ts'

const SPEC: CorpusSpec = {
  items: 40,
  eventsPerItem: 1,
  months: 24,
  seed: 20260907,
  lastMonth: '2026-09',
  relationsPerHundredItems: 10,
  impedimentsPerHundredItems: 0,
}

const roots: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'treadling-bench-isolation-'))
  roots.push(dir)
  return dir
}

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true })
})

describe('the benchmark rig isolates each run from every other run', () => {
  it('two runs sharing one cache measure separate roots, and neither sees the other\'s writes', async () => {
    const base = await scratch()
    const cache = path.join(base, 'cache')

    // Started together, which is the case that broke the shared path: both want the same
    // entry, one publishes it and the other adopts what it finds.
    const [a, b] = await Promise.all([
      acquireCorpus(cache, path.join(base, 'run-a'), SPEC, false),
      acquireCorpus(cache, path.join(base, 'run-b'), SPEC, false),
    ])

    assert.notEqual(a.root, b.root, 'two runs were handed the same corpus root')
    assert.equal(a.itemsInStore, SPEC.items)
    assert.equal(b.itemsInStore, SPEC.items)
    assert.deepEqual(a.months, b.months, 'the two runs disagree about the corpus they measured')

    const entries = (await readdir(cache)).filter((name) => !name.startsWith('.'))
    assert.deepEqual(entries.length, 1, `expected one published cache entry, found ${entries.join(', ')}`)

    // What A1's writers and A5's edits do to a corpus, done here directly: one run damaging
    // its own copy must leave the other run's copy and the shared entry untouched.
    const shard = path.join('items', `${a.largestMonth}.md`)
    const before = await readFile(path.join(b.root, shard), 'utf8')
    await writeFile(path.join(a.root, shard), 'damaged by run a\n')
    assert.equal(await readFile(path.join(b.root, shard), 'utf8'), before)
    assert.equal(await readFile(path.join(cache, entries[0] as string, shard), 'utf8'), before)
  })

  it('a cache entry short of its spec stops the run instead of being measured', async () => {
    const base = await scratch()
    const cache = path.join(base, 'cache')
    const first = await acquireCorpus(cache, path.join(base, 'run-a'), SPEC, false)

    const entry = path.join(cache, (await readdir(cache)).find((name) => !name.startsWith('.')) as string)
    await rm(path.join(entry, 'items', `${first.largestMonth}.md`))

    await assert.rejects(
      () => acquireCorpus(cache, path.join(base, 'run-b'), SPEC, false),
      /store holds \d+ items, spec says 40/,
    )
  })

  // `eventsWritten` was the spec's arithmetic rather than a readback, so an entry short of an
  // events file was cloned, reported whole and measured, while a missing shard was refused.
  it('a cache entry short of its events stops the run the way one short of its items does', async () => {
    const base = await scratch()
    const cache = path.join(base, 'cache')
    const first = await acquireCorpus(cache, path.join(base, 'run-a'), SPEC, false)
    assert.equal(first.eventsWritten, SPEC.items * SPEC.eventsPerItem)

    const entry = path.join(cache, (await readdir(cache)).find((name) => !name.startsWith('.')) as string)
    await rm(path.join(entry, 'events', `${first.largestMonth}.jsonl`))

    await assert.rejects(
      () => acquireCorpus(cache, path.join(base, 'run-b'), SPEC, false),
      /the log holds \d+ events, spec says 40/,
    )
  })

  it('--rebuild-corpus generates privately and leaves the shared cache alone', async () => {
    const base = await scratch()
    const cache = path.join(base, 'cache')
    const built = await acquireCorpus(cache, path.join(base, 'run-a'), SPEC, true)

    assert.equal(built.itemsInStore, SPEC.items)
    assert.equal(built.reused, false)
    assert.equal(built.cloneMs, undefined)
    assert.deepEqual(await readdir(cache).catch(() => []), [], 'a rebuild wrote to the shared cache')
  })
})
