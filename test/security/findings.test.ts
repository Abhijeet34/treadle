// SPDX-License-Identifier: Apache-2.0
// The map from threat-model finding to regression test, held as a test rather than as a
// paragraph. Eight of the thirteen findings are closed; each closed one names the file that
// would catch its return, and this asserts that file exists, names the finding, and carries
// assertions. The five that are open name the layer they are waiting on instead.
//
// Why a test and not a table in a document: a test file renamed or emptied in a refactor is
// exactly how a regression suite quietly stops covering the thing it was written for, and a
// document does not notice. This does.

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const TEST_ROOT = fileURLToPath(new URL('../', import.meta.url))

type Finding = {
  readonly id: string
  readonly title: string
  /** The regression test, relative to `test/`, or the layer the fix waits on. */
  readonly test?: string
  readonly waitingOn?: string
}

/** The thirteen findings of `wmcli-threat-model-t5`, in the audit's own order. */
const FINDINGS: readonly Finding[] = [
  { id: 'F1', title: 'a committed workspace file names a hook executable, run with no consent gate', waitingOn: 'the hook contract, which is specified and not built' },
  { id: 'F2', title: 'a multi-line description forges lines in the agent output stream', test: 'security/f2-newline-forging.test.ts' },
  { id: 'F3', title: 'a column appended after a space-bearing one corrupts the row split', test: 'security/f3-column-split.test.ts' },
  { id: 'F4', title: 'CSV export is quoted but not formula-guarded', waitingOn: 'export, which is specified and not built' },
  { id: 'F5', title: 'bidi rejection lists five code points and lets the isolates and marks through', test: 'store/security-f5.test.ts' },
  { id: 'F6', title: 'prototype pollution through the field-key grammar and the event log', test: 'store/security-f6.test.ts' },
  { id: 'F7', title: 'the hook path has no anti-traversal and no argv-not-shell rule', waitingOn: 'the hook contract, which is specified and not built' },
  { id: 'F8', title: 'no ceiling on file size, event count or traversal depth', test: 'store/security-f8.test.ts' },
  { id: 'F9', title: 'a predictable temp-file name with no exclusive create', test: 'store/security-f9.test.ts' },
  { id: 'F10', title: 'record content reaches a verbose log', test: 'security/f10-verbose-content.test.ts' },
  { id: 'F11', title: 'agent-adapter generation has no diff, backup or reversibility contract', waitingOn: 'the agent adapter, which is specified and not built' },
  { id: 'F12', title: 'the data-versus-instruction boundary is legible to a parser and not to a model', test: 'security/f12-data-boundary.test.ts' },
  { id: 'F13', title: 'three supply-chain controls are unstated for this product', waitingOn: 'the release path, which is blocked on a name clearance' },
]

const CLOSED = FINDINGS.filter((finding) => finding.test !== undefined)
const OPEN = FINDINGS.filter((finding) => finding.test === undefined)

describe('every closed threat-model finding has a regression test that names it', () => {
  it(`holds for all ${CLOSED.length} closed findings`, async (t) => {
    for (const finding of CLOSED) {
      const file = path.join(TEST_ROOT, finding.test as string)
      const info = await stat(file).catch(() => undefined)
      assert.ok(info !== undefined, `${finding.id} names ${finding.test}, which does not exist`)

      const text = await readFile(file, 'utf8')
      assert.match(text, new RegExp(`\\b${finding.id}\\b`), `${finding.test} never names ${finding.id}`)
      const assertions = text.match(/assert\./g)?.length ?? 0
      assert.ok(assertions >= 3, `${finding.test} carries ${assertions} assertions`)
    }
    t.diagnostic(`${CLOSED.length} closed findings, each mapped to a named regression test: ${CLOSED.map((f) => f.id).join(', ')}`)
  })

  it('accounts for every one of the thirteen, open or closed', (t) => {
    assert.equal(FINDINGS.length, 13)
    assert.equal(new Set(FINDINGS.map((f) => f.id)).size, 13, 'a finding id appears twice')
    for (const finding of OPEN) {
      assert.ok((finding.waitingOn ?? '').length > 0, `${finding.id} is neither closed nor waiting on anything`)
    }
    t.diagnostic(`${OPEN.length} findings open, each naming the layer it waits on: ${OPEN.map((f) => f.id).join(', ')}`)
  })
})
