// SPDX-License-Identifier: Apache-2.0
// Generates schemas/<command>.v<n>.json from the shapes the services declare, so the shipped
// schema and the projection a renderer performs have one source (R8). `npm run schemas`
// writes them; test/cli/schemas.test.ts fails when what is shipped is not what this writes.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RESULT_CODES, type PropertySpec, type ResultShape } from '../src/application/result.ts'
import { SHAPES } from '../src/application/shapes.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type Json = Record<string, unknown>

function propertySchema(property: PropertySpec): Json {
  if (property.kind === 'list') {
    return { type: 'array', items: { type: 'string' } }
  }
  if (property.kind === 'text') {
    return {
      type: 'string',
      // F12: this value is content a person or an agent wrote. The agent rendering marks it
      // with a leading quote on its name; a JSON consumer reads the marking here.
      'x-trust': 'data',
    }
  }
  if (property.kind === 'block') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['columns', 'shown', 'total', 'rows'],
      properties: {
        columns: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: { name: { type: 'string' }, text: { const: true } },
          },
        },
        shown: { type: 'integer' },
        total: { type: 'integer' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: { type: ['string', 'number', 'null'] },
          },
        },
      },
      'x-columns': property.columns.map((column) =>
        column.text === true ? { name: column.name, trust: 'data' } : { name: column.name }),
    }
  }
  const type = property.type === 'integer' ? 'integer' : property.type
  return { type: [type, 'null'] }
}

export function schemaFor(shape: ResultShape): Json {
  const id = `${shape.command}/${shape.version}`
  const data: Json = {}
  for (const property of shape.properties) data[property.key] = propertySchema(property)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${shape.command}.v${shape.version}.json`,
    title: id,
    description: shape.summary,
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'ok', 'code', 'command', 'workspace', 'effect', 'txn', 'changed', 'data'],
    properties: {
      schema: { const: id },
      ok: { type: 'boolean' },
      code: { enum: [...RESULT_CODES] },
      command: { const: shape.command },
      workspace: { type: 'string' },
      effect: { const: shape.effect },
      txn: { type: ['string', 'null'] },
      changed: { type: ['integer', 'null'] },
      data: { type: 'object', additionalProperties: false, properties: data },
    },
  }
}

export function fileNameFor(shape: ResultShape): string {
  return `${shape.command}.v${shape.version}.json`
}

export function generated(): ReadonlyMap<string, string> {
  return new Map(SHAPES.map((shape) => [fileNameFor(shape), `${JSON.stringify(schemaFor(shape), null, 2)}\n`]))
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  for (const [name, body] of generated()) {
    await writeFile(path.join(ROOT, 'schemas', name), body)
    process.stdout.write(`${name}\n`)
  }
}
