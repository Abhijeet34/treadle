// SPDX-License-Identifier: Apache-2.0
// R8's check: the shipped artefacts are what the inventory generates, and every result
// object a command produces validates against the schema shipped for it. A schema that
// drifts from the shape it describes is exactly the failure the requirement exists to stop.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before } from 'node:test'

import { SHAPES } from '../../src/application/shapes.ts'
import type { ResultObject } from '../../src/application/result.ts'
import { fileNameFor, generated } from '../../scripts/generate-schemas.ts'
import { goldenResults } from '../helpers/cli-fixtures.ts'
import { validate } from '../helpers/json-schema.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCHEMAS = path.join(ROOT, 'schemas')

describe('the shipped schemas are the generated ones', () => {
  const written = generated()

  it('generates one schema per shape, and there is more than one shape', () => {
    assert.ok(SHAPES.length >= 9, `only ${SHAPES.length} shapes are registered`)
    assert.equal(written.size, SHAPES.length)
  })

  for (const shape of SHAPES) {
    it(`schemas/${fileNameFor(shape)} matches what the shape generates`, () => {
      const shipped = readFileSync(path.join(SCHEMAS, fileNameFor(shape)), 'utf8')
      assert.equal(shipped, written.get(fileNameFor(shape)), 'run `npm run schemas`')
    })
  }

  it('ships no schema that no shape generates', () => {
    const files = readdirSync(SCHEMAS).filter((name) => name.endsWith('.json')).sort()
    assert.deepEqual(files, [...written.keys()].sort())
  })
})

describe('every golden result object validates against its shipped schema', () => {
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
      const schema = JSON.parse(readFileSync(path.join(SCHEMAS, `${command}.v${version}.json`), 'utf8')) as Record<string, unknown>
      const failures = validate(schema, result)
      assert.deepEqual(failures, [], `${name}: ${failures.map((f) => `${f.path} ${f.reason}`).join('; ')}`)
    }
  })

  it('catches a result object that does not match its schema, so the validator is not a no-op', () => {
    const schema = JSON.parse(readFileSync(path.join(SCHEMAS, 'show.v1.json'), 'utf8')) as Record<string, unknown>
    const broken = { ...(golden.get('show') as ResultObject), code: 'NOT_A_CODE' }
    assert.ok(validate(schema, broken).length > 0, 'an invalid code must be reported')
  })
})
