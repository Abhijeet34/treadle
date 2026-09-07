// SPDX-License-Identifier: Apache-2.0
// `--contract` hands a stranger the machine interface, so it carries the exit table.
//
// Measured on 2026-09-07: `treadle --contract` printed the line grammar and its eight line
// kinds and named no exit status at all, and neither did `help`, `help help` or `version`.
// The statuses are real and load-bearing, and they were documented only in
// docs/architecture/adr/0005-output-and-exit-code-contract.md, which an agent driving the
// binary never sees. A caller that has to read an ADR to branch on a status is reading
// around the one call whose whole job is to say what the interface is.
//
// The table is printed from the same constant `exitFor` reads, so the printed contract and
// the status the process returns cannot drift.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RESULT_CODES } from '../../src/application/result.ts'
import { EXIT_INTERRUPTED, EXIT_OF } from '../../src/cli/exit.ts'
import { contractLines } from '../../src/adapters/render/grammar.ts'
import { runCli } from '../helpers/cli-run.ts'

/** The rows of one `~<key> <shown> <total>` block of the contract, as written. */
function block(lines: readonly string[], key: string): readonly string[] {
  const opener = lines.findIndex((line) => line.startsWith(`~${key} `))
  assert.notEqual(opener, -1, `--contract prints no ~${key} block`)
  const rest = lines.slice(opener + 1)
  const next = rest.findIndex((line) => line.startsWith('~'))
  return (next === -1 ? rest : rest.slice(0, next)).filter((line) => !line.startsWith('#'))
}

describe('--contract carries the exit statuses a caller branches on', () => {
  it('names every code in the closed set with the status that code exits', () => {
    const rows = block(contractLines(), 'exits')
    for (const code of RESULT_CODES) {
      const row = rows.find((line) => line.split(' ')[1] === code)
      assert.ok(row !== undefined, `--contract names no exit row for ${code}`)
      assert.equal(
        row.split(' ')[0], String(EXIT_OF[code]),
        `--contract says ${row.split(' ')[0]} for ${code} and exit.ts says ${EXIT_OF[code]}`,
      )
      assert.ok(row.split(' ').length > 2, `${code} carries a status and no meaning`)
    }
  })

  it('names the one status that is not a function of a result object', () => {
    const rows = block(contractLines(), 'exits')
    assert.ok(
      rows.some((line) => line.startsWith(`${EXIT_INTERRUPTED} `)),
      `--contract names no ${EXIT_INTERRUPTED} row, and a caller reading it would treat an interrupt as an unknown failure`,
    )
  })

  it('counts its own rows, so the block header is not a guess', () => {
    const lines = contractLines()
    const opener = lines.find((line) => line.startsWith('~exits ')) as string
    assert.equal(`${opener.split(' ')[1]}`, `${block(lines, 'exits').length}`)
    assert.equal(opener.split(' ')[1], opener.split(' ')[2], 'the exits block claims to be partial')
  })

  it('reaches a caller through the real entry point', async () => {
    const run = await runCli(['--contract'])
    assert.equal(run.code, 0)
    for (const code of RESULT_CODES) {
      assert.ok(run.out.includes(` ${code} `), `--contract printed no row naming ${code}:\n${run.out}`)
    }
  })
})
