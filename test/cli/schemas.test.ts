// SPDX-License-Identifier: Apache-2.0
// R8's check: every result object a command produces validates against the schema its shape
// generates. A schema that drifts from the shape it describes is exactly the failure the
// requirement exists to stop.
//
// The schemas are not committed. `npm run build` writes them beside dist/ from the same
// shapes this file reads, so there is no second copy for a shape change to leave behind and
// nothing here compares bytes with the generator that produced them.

import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'

import { SHAPES } from '../../src/application/shapes.ts'
import type { ResultObject } from '../../src/application/result.ts'
import { fileNameFor, generated } from '../../scripts/generate-schemas.ts'
import { goldenResults } from '../helpers/cli-fixtures.ts'
import { validate } from '../helpers/json-schema.ts'

/** What `npm run build` writes into schemas/, held in memory rather than read back off disk. */
const written = generated()

function schemaNamed(name: string): Record<string, unknown> {
  const body = written.get(name)
  assert.ok(body !== undefined, `no shape generates ${name}; schemas are ${[...written.keys()].join(', ')}`)
  return JSON.parse(body) as Record<string, unknown>
}

describe('every shape generates a schema', () => {
  it('generates one schema per shape, and there is more than one shape', () => {
    assert.ok(SHAPES.length >= 9, `only ${SHAPES.length} shapes are registered`)
    assert.equal(written.size, SHAPES.length)
  })

  it('names each one after the command and version its shape declares', () => {
    for (const shape of SHAPES) {
      assert.ok(written.has(fileNameFor(shape)), `no schema for ${shape.command} v${shape.version}`)
    }
  })
})

describe('every golden result object validates against the schema its shape generates', () => {
  let golden: ReadonlyMap<string, ResultObject>

  before(async () => {
    golden = await goldenResults()
  })

  it('has golden objects to check, so a pass is not vacuous', () => {
    assert.ok(golden.size >= 12, `only ${golden.size} golden objects`)
  })

  it('validates each one', () => {
    for (const [name, result] of golden) {
      // An error result carries `error/1` whatever command produced it: one error shape
      // serves every command, which is why the file is chosen by schema and not by command.
      const [command, version] = result.schema.split('/')
      const failures = validate(schemaNamed(`${command}.v${version}.json`), result)
      assert.deepEqual(failures, [], `${name}: ${failures.map((f) => `${f.path} ${f.reason}`).join('; ')}`)
    }
  })

  it('catches a result object that does not match its schema, so the validator is not a no-op', () => {
    const schema = schemaNamed('show.v2.json')
    const broken = { ...(golden.get('show') as ResultObject), code: 'NOT_A_CODE' }
    assert.ok(validate(schema, broken).length > 0, 'an invalid code must be reported')
  })
})
