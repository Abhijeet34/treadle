// SPDX-License-Identifier: Apache-2.0
// The map from threat-model finding to regression test, held as a test rather than as a
// paragraph. Twelve of the thirteen findings are closed; each closed one names the file that
// would catch its return. This asserts that file exists, then runs every named file in
// one child `node --test` process and asserts the runner's own summary reports a zero exit
// and a positive pass count. The one that is open names the layer it is waiting on
// instead.
//
// Three of the twelve closed by having their surface removed rather than guarded, so they
// name the decision record that removed it as well as the test that keeps it removed: a
// reader who trips one of those tests needs the argument, not just the assertion.
//
// Why a test and not a table in a document: a test file renamed or emptied in a refactor is
// exactly how a regression suite quietly stops covering the thing it was written for, and a
// document does not notice. Running the files, rather than grepping their text for the
// finding id and a count of "assert.", is what proves they still execute and still pass
// rather than merely still mention the finding somewhere.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const TEST_ROOT = fileURLToPath(new URL('../', import.meta.url))

type Finding = {
  readonly id: string
  readonly title: string
  /** The regression test, relative to `test/`, or the layer the fix waits on. */
  readonly test?: string
  readonly waitingOn?: string
  /** For a finding closed by removing its surface: the record that argues the removal. */
  readonly record?: string
}

/** The thirteen findings of `wmcli-threat-model-t5`, in the audit's own order. */
const FINDINGS: readonly Finding[] = [
  { id: 'F1', title: 'a committed workspace file names a hook executable, run with no consent gate', test: 'security/f1-f7-no-execution.test.ts', record: 'docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md' },
  { id: 'F2', title: 'a multi-line description forges lines in the agent output stream', test: 'security/f2-newline-forging.test.ts' },
  { id: 'F3', title: 'a column appended after a space-bearing one corrupts the row split', test: 'security/f3-column-split.test.ts' },
  { id: 'F4', title: 'CSV export is quoted but not formula-guarded', waitingOn: 'export, which is specified and not built' },
  { id: 'F5', title: 'bidi rejection lists five code points and lets the isolates and marks through', test: 'store/security-f5.test.ts' },
  { id: 'F6', title: 'prototype pollution through the field-key grammar and the event log', test: 'store/security-f6.test.ts' },
  { id: 'F7', title: 'the hook path has no anti-traversal and no argv-not-shell rule', test: 'security/f1-f7-no-execution.test.ts', record: 'docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md' },
  { id: 'F8', title: 'no ceiling on file size, event count or traversal depth', test: 'store/security-f8.test.ts' },
  { id: 'F9', title: 'a predictable temp-file name with no exclusive create', test: 'store/security-f9.test.ts' },
  { id: 'F10', title: 'record content reaches a verbose log', test: 'security/f10-verbose-content.test.ts' },
  { id: 'F11', title: 'agent-adapter generation has no diff, backup or reversibility contract', test: 'security/f11-adapter-write-safety.test.ts', record: 'docs/architecture/adr/0012-the-extension-surface-that-does-not-ship.md' },
  { id: 'F12', title: 'the data-versus-instruction boundary is legible to a parser and not to a model', test: 'security/f12-data-boundary.test.ts' },
  { id: 'F13', title: 'three supply-chain controls are unstated for this product', test: 'architecture/supply-chain.test.ts' },
]

const CLOSED = FINDINGS.filter((finding) => finding.test !== undefined)
const OPEN = FINDINGS.filter((finding) => finding.test === undefined)

describe('every closed threat-model finding names a regression test that exists and passes', () => {
  it(`names ${CLOSED.length} files that exist`, async (t) => {
    for (const finding of CLOSED) {
      const file = path.join(TEST_ROOT, finding.test as string)
      const info = await stat(file).catch(() => undefined)
      assert.ok(info !== undefined, `${finding.id} names ${finding.test}, which does not exist`)
    }
    t.diagnostic(`${CLOSED.length} closed findings, each naming a file that exists: ${CLOSED.map((f) => f.id).join(', ')}`)
  })

  it('runs all of them in one child process and requires a clean, non-empty pass', (t) => {
    // Two findings share one file, and `node --test` would run it twice.
    const files = [...new Set(CLOSED.map((finding) => finding.test as string))]
    const { NODE_TEST_CONTEXT: _unused, ...childEnv } = process.env
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-timeout=120000', ...files],
      { cwd: TEST_ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: childEnv },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.equal(result.status, 0, `node --test over ${files.join(', ')} exited ${result.status}\n${output}`)

    const passed = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? Number.NaN)
    assert.ok(Number.isInteger(passed), `no "# pass" line in the test runner's summary:\n${output}`)
    assert.ok(passed > 0, `the test runner reported ${passed} passing tests`)

    const failed = Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? Number.NaN)
    assert.equal(failed, 0, `the test runner reported ${failed} failing tests:\n${output}`)

    t.diagnostic(`node --test over ${files.length} named files: ${passed} passing, ${failed} failing, exit ${result.status}`)
  })
})

describe('a finding closed by removing its surface names the record that removed it', () => {
  const REMOVED = FINDINGS.filter((finding) => finding.record !== undefined)

  it(`names ${REMOVED.length} records, each of which exists and argues that finding`, async (t) => {
    assert.ok(REMOVED.length > 0, 'no finding names a record; this suite would pass over nothing')
    for (const finding of REMOVED) {
      const file = path.join(TEST_ROOT, '..', finding.record as string)
      const text = await readFile(file, 'utf8').catch(() => undefined)
      assert.ok(text !== undefined, `${finding.id} names ${finding.record}, which does not exist`)
      assert.ok(text.includes(finding.id), `${finding.record} does not name ${finding.id}`)
    }
    t.diagnostic(`${REMOVED.length} findings closed by removed surface: ${REMOVED.map((f) => f.id).join(', ')}`)
  })
})

describe('every one of the thirteen findings is accounted for, open or closed', () => {
  it('holds for all 13', (t) => {
    assert.equal(FINDINGS.length, 13)
    assert.equal(new Set(FINDINGS.map((f) => f.id)).size, 13, 'a finding id appears twice')
    for (const finding of OPEN) {
      assert.ok((finding.waitingOn ?? '').length > 0, `${finding.id} is neither closed nor waiting on anything`)
    }
    t.diagnostic(`open findings (${OPEN.length}), each naming the layer it waits on: ${OPEN.map((f) => f.id).join(', ')}`)
  })
})
