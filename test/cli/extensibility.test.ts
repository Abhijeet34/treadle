// SPDX-License-Identifier: Apache-2.0
// docs/STABILITY.md makes one promise about forward compatibility: "Unknown fields and
// unknown sections are preserved verbatim and travel with the record through every mutation,
// so an older tool writing a newer file loses nothing it did not understand." The store seam
// tests carry-through at the port (docs/architecture/adr/0006-the-store-seam.md), and nothing
// held the promise end to end at the surface a caller uses. It holds, and it is asserted here
// against a record a newer version wrote, edited by this build's own `set`.
//
// The one place the promise read false was the refusal beside it: `show <id> --field <key>`
// answered "carries no field named <key>" for a key the file did carry.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

/** The shard holding the seeded September items, which is where a hand edit lands. */
const SHARD = ['items', '2026-09.md']

describe('a record a newer version wrote survives this build editing it', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })
  const shard = (): string => path.join(demo.root, ...SHARD)

  it('carries an unknown field key and an unknown section through a mutation', async () => {
    const before = await readFile(shard(), 'utf8')
    const at = before.indexOf('\n# webhook-retry:')
    assert.ok(at > 0, 'the fixture no longer files webhook-retry in this shard')
    const end = before.indexOf('\n# ', at + 1)
    const record = end < 0 ? before.slice(at) : before.slice(at, end)
    const grown = record
      .replace(/^state: (.*)$/m, 'state: $1\nrisk_tier: gold')
      .concat('\n## Newer section\n\nprose only a later version understands\n')
    await writeFile(shard(), before.replace(record, grown), 'utf8')

    const written = await cli(['set', 'webhook-retry', 'assignee=dana'])
    assert.equal(written.code, 0, written.err)

    const after = await readFile(shard(), 'utf8')
    assert.match(after, /^risk_tier: gold$/m, 'the unknown field was dropped by a mutation')
    assert.match(after, /^## Newer section$/m, 'the unknown section was dropped by a mutation')
    assert.match(after, /^prose only a later version understands$/m)
    // The known fields are re-rendered in dictionary order and the unknown key follows them,
    // which is ADR-0003 rule: it is carried, not merely left where it was.
    assert.match(after, /^assignee: dana\nrisk_tier: gold$/m)
  })

  it('counts the key on show and says which of the two answers a --field ask gets', async () => {
    const shown = await cli(['show', 'webhook-retry'])
    assert.equal(shown.code, 0, shown.err)
    assert.match(shown.out, /^extra 1$/m)

    const carried = await cli(['show', 'webhook-retry', '--field', 'risk_tier'])
    assert.equal(carried.code, 2)
    assert.match(carried.err, /webhook-retry carries risk_tier and this build has no field of that name/)
    assert.doesNotMatch(carried.err, /carries no field named risk_tier/)

    const absent = await cli(['show', 'webhook-retry', '--field', 'nonesuch'])
    assert.equal(absent.code, 2)
    assert.match(absent.err, /webhook-retry carries no field named nonesuch/)
  })
})
