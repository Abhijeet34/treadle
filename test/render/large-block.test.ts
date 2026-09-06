// SPDX-License-Identifier: Apache-2.0
// A block's row count is bounded by the store, never by the renderer. `doctor` at 50,000
// items returned `INTERNAL: Maximum call stack size exceeded` from both renderers, because
// each spread its rows into a call's argument list, which V8 caps near 120,000 values.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { humanRenderer } from '../../src/adapters/render/human.ts'
import { jsonRenderer } from '../../src/adapters/render/json.ts'
import { columnsOf, okResult } from '../../src/application/result.ts'
import { DOCTOR_SHAPE } from '../../src/application/services/doctor.ts'

const ROWS = 200_000

describe('a block of more rows than a call can take as arguments', () => {
  const rows = Array.from({ length: ROWS }, (_, n) => ({
    rule: 'H20', id: `wi-${String(n).padStart(6, '0')}`, where: `items/2026-09.md:${n + 2}`, detail: `state ready held against event ev-${n}`,
  }))
  const result = okResult(DOCTOR_SHAPE, {
    workspace: 'ws',
    data: { store: '/ws', checked: ROWS, findings: { columns: columnsOf(DOCTOR_SHAPE, 'findings'), shown: ROWS, total: ROWS, rows } },
  })

  for (const renderer of [agentRenderer, humanRenderer, jsonRenderer]) {
    it(`renders every row through ${renderer.name}`, () => {
      const out = renderer.render(result)
      assert.ok(out.includes('wi-199999'), `${renderer.name} dropped the last row`)
      assert.ok(out.includes('wi-000000'), `${renderer.name} dropped the first row`)
    })
  }
})
