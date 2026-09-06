// SPDX-License-Identifier: Apache-2.0
// Paging is the only way an agent reads a workspace it cannot hold in one answer. That a
// cursor naming nothing is a refusal and not the first page again is held by "a cursor that
// names nothing is a refusal, not the first page again" in found-by-use.test.ts; what is
// here is the case that refusal exists for, and the walk it protects.
//
// The shape a concurrent writer produces is not a cursor that names nothing. It is a cursor
// naming an item the workspace still holds and the filter no longer matches, because another
// writer transitioned it while the walk was running. Before the refusal landed that returned
// the first page byte for byte: measured on the 10,000-item bench corpus,
// `backlog --state ready --limit 3 --cursor wi-003956`, where that item is done, printed
// exactly what `backlog --state ready --limit 3` printed, so a walk became a loop over the
// first pages with nothing in the output to read it from.
//
// The pages themselves are exact and are proved by counting rather than asserted here, under
// "Deep pagination, proved by counting" in docs/BENCHMARKS.md: 50,021 items over 101 pages
// returned 50,021 rows and 50,021 distinct ids, and 402 events over 134 pages returned 402
// rows and 402 distinct rows, with zero duplicates in either.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

describe('a cursor the filter no longer matches is refused, and a live one still resumes', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('refuses a cursor naming an item the workspace holds and the filter excludes', async () => {
    // `login-cta` is done, so it is in the workspace and not in the ready list: exactly what
    // a concurrent transition leaves behind mid-walk, and what used to restart it in silence.
    const shown = await cli(['show', 'login-cta', '--field', 'state'])
    assert.match(shown.out, /^state done$/m, 'the fixture no longer files login-cta as done')

    const first = await cli(['backlog', '--state', 'ready', '--limit', '3'])
    assert.equal(first.code, 0, first.err)

    const stale = await cli(['backlog', '--state', 'ready', '--limit', '3', '--cursor', 'login-cta'])
    assert.equal(stale.code, 2)
    assert.match(stale.err, /^rule C1$/m)
    assert.match(stale.err, /^"cause --cursor login-cta names nothing in this list/m)
    assert.equal(stale.out, '', 'a refusal writes nothing to stdout, so a piped reader sees no page at all')
  })

  it('still resumes a backlog walk from a cursor the list does hold', async () => {
    const first = await cli(['backlog', '--limit', '3'])
    assert.equal(first.code, 0, first.err)
    const page = /^page treadle backlog --limit 3 --cursor (\S+)$/m.exec(first.out)
    assert.ok(page !== null, 'the first page named no cursor to resume from, or dropped the limit it was asked with')
    const second = await cli(['backlog', '--limit', '3', '--cursor', page[1] as string])
    assert.equal(second.code, 0, second.err)
    assert.match(second.out, new RegExp(`^${page[1] as string} `, 'm'))
  })

  it('still resumes a history walk from a cursor the log does hold', async () => {
    const first = await cli(['history', 'auth-refresh', '--limit', '2'])
    assert.equal(first.code, 0, first.err)
    const page = /^page treadle history auth-refresh --limit 2 --cursor (\S+)$/m.exec(first.out)
    assert.ok(page !== null, 'the first page of history named no cursor to resume from, or dropped the limit it was asked with')
    const second = await cli(['history', 'auth-refresh', '--limit', '2', '--cursor', page[1] as string])
    assert.equal(second.code, 0, second.err)
    assert.match(second.out, /^~events \d+ 3$/m)
  })
})
