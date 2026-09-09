// SPDX-License-Identifier: Apache-2.0
// `backlog --type chore` answered `matched 0` at exit 0, which a caller reads as "no items
// like that" where it means "no such value": the type is gone under the fold and the fold's
// own regression would otherwise read as an empty list for ever. Every closed-set filter now
// refuses a value outside its set at C1, naming the value and the set, while a legitimate
// value and the open filters - label, assignee, title - still answer their rows or their
// honest empty match.

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

describe('a closed-set backlog filter outside its set refuses rather than answering matched 0', () => {
  let demo: Demo
  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('refuses --type chore, the type the fold removed, naming the value and the set', async () => {
    const run = await cli(['backlog', '--type', 'chore'])
    assert.equal(run.code, 2)
    assert.match(run.err, /^rule C1$/m)
    assert.match(run.err,
      /^"cause chore is not a type; the set is epic, story, task, bug, spike, impediment$/m)
  })

  it('refuses --state, --resolution and --priority outside their sets the same way', async () => {
    const state = await cli(['backlog', '--state', 'banana'])
    assert.equal(state.code, 2)
    assert.match(state.err, /^rule C1$/m)
    assert.match(state.err,
      /^"cause banana is not a state; the set is draft, ready, in_progress, in_review, done, on_hold, cancelled, open, all$/m)

    const priority = await cli(['backlog', '--priority', '9'])
    assert.equal(priority.code, 2)
    assert.match(priority.err, /^"cause 9 is not a priority; the set is 1, 2, 3, 4, 5$/m)

    const resolution = await cli(['backlog', '--resolution', 'nope'])
    assert.equal(resolution.code, 2)
    assert.match(resolution.err,
      /^"cause nope is not a resolution; the set is wont_do, duplicate, superseded, cannot_reproduce, rejected$/m)
  })

  it('still answers a legitimate value from each closed set at exit 0', async () => {
    const type = await cli(['backlog', '--type', 'bug'])
    assert.equal(type.code, 0)
    assert.match(type.out, /^sess-timeout /m)

    const state = await cli(['backlog', '--state', 'cancelled'])
    assert.equal(state.code, 0)
    assert.match(state.out, /^legacy-oauth /m)

    const resolution = await cli(['backlog', '--resolution', 'wont_do'])
    assert.equal(resolution.code, 0)
    assert.match(resolution.out, /^legacy-oauth /m)

    const priority = await cli(['backlog', '--priority', '1'])
    assert.equal(priority.code, 0)
    assert.match(priority.out, /^sso-saml /m)
  })

  it('leaves the open filters alone: an unmatched label, assignee or title still answers matched 0 at exit 0', async () => {
    const label = await cli(['backlog', '--label', 'no-such-label'])
    assert.equal(label.code, 0)
    assert.match(label.out, /^none searched \d+ matched 0$/m)

    const assignee = await cli(['backlog', '--assignee', 'no-such-person'])
    assert.equal(assignee.code, 0)
    assert.match(assignee.out, /^none searched \d+ matched 0$/m)

    const title = await cli(['backlog', '--title', 'no-such-words-anywhere'])
    assert.equal(title.code, 0)
    assert.match(title.out, /^none searched \d+ matched 0$/m)
  })
})
