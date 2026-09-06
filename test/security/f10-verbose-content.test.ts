// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F10.
//
// `-vvv` logs the raw store operations, and a record's fields are free text that somebody
// may have pasted a credential into. A CI job and an agent transcript both capture stderr,
// so a value logged there outlives the run. The fix in src/cli/diagnostics.ts reports every
// field by name and size, and `--log-values` is the explicit opt-in that says the caller
// accepts the disclosure.

import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { fileItem } from '../../src/application/services/items.ts'
import { fixedClock } from '../../src/adapters/clock.ts'
import { sequentialIds } from '../../src/adapters/ids.ts'
import { targetFor } from '../../src/adapters/target.ts'
import { redact } from '../../src/cli/diagnostics.ts'
import { aDemoWorkspace, ACTOR, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

/** Shaped like a credential and deliberately not one: no service issues this prefix. */
const PASTED = 'EXAMPLENOTAKEY-0000-deadbeefcafef00d-treadle-f10-probe'

describe('F10: a value pasted into a description does not reach a verbose log', () => {
  let demo: Demo
  let cwd: string

  before(async () => {
    demo = await aDemoWorkspace()
    cwd = path.dirname(demo.root)
    const filed = await fileItem(targetFor(demo.store, 'apply'), fixedClock('2026-09-04T09:30:00Z'), sequentialIds(800), {
      type: 'task', title: 'A task somebody pasted a secret into', id: 'secret-probe',
      fields: { description: `the token is ${PASTED} and it should not be logged` }, actor: ACTOR,
    })
    assert.equal(filed.ok, true)
    await demo.store.close()
  })

  after(async () => {
    await demo.dispose()
  })

  it('logs the raw store operations at -vvv, so the level is not a no-op', async () => {
    const run = await runCli(['backlog', '-vvv'], { cwd })
    assert.match(run.err, /vvv store read /, 'nothing was logged at -vvv')
    assert.match(run.err, /vvv store summaries n=/)
  })

  // A scan reads no prose at all since ADR-0013, so `backlog` cannot leak a description and
  // the log says so: its `read` lines carry no description field. `show` is the command
  // that reads the whole record, so it is the one that has to name the field and its size.
  it('names the field and its size, and never its content', async () => {
    const scan = await runCli(['backlog', '-vvv'], { cwd })
    assert.equal(scan.err.includes(PASTED), false, `the pasted value reached stderr:\n${scan.err}`)
    assert.doesNotMatch(scan.err, /description=/, 'a scan read a description it has no use for')
    assert.equal(scan.out.includes(PASTED), false, 'a list row must not carry a description either')

    const run = await runCli(['show', 'secret-probe', '-vvv'], { cwd })
    assert.equal(run.err.includes(PASTED), false, `the pasted value reached stderr:\n${run.err}`)
    assert.match(run.err, /description=<redacted \d+B>/, 'the field is not reported by name and size')
  })

  it('includes the value only when the caller asks for it', async () => {
    const run = await runCli(['show', 'secret-probe', '-vvv', '--log-values'], { cwd })
    assert.ok(run.err.includes(PASTED), 'the explicit opt-in must still be able to show a value')
  })

  it('redacts every string shape a field can hold, and keeps numbers and booleans', () => {
    assert.equal(redact('a secret', false), '<redacted 8B>')
    assert.equal(redact(['a', 'b'], false), '<redacted 9B>')
    assert.equal(redact({ text: 'a', ticked: false }, false), '<redacted 27B>')
    assert.equal(redact(5, false), '5')
    assert.equal(redact(true, false), 'true')
    assert.equal(redact(undefined, false), '-')
  })
})
