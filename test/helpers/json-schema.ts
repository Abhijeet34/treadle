// SPDX-License-Identifier: Apache-2.0
// A validator for the constructs the generated schemas actually use, and no others.
//
// A JSON Schema library would be a fifth development dependency to check documents this
// repository writes itself against schemas this repository also writes. The subset below is
// what scripts/generate-schemas.ts emits: type (including a union and `integer`), const,
// enum, required, properties, additionalProperties and items. Anything else is a schema
// construct that has appeared without this file being updated, and it fails loudly.

export type Failure = { readonly path: string; readonly reason: string }

type Schema = Record<string, unknown>

const KNOWN = new Set([
  '$schema', '$id', 'title', 'description',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items',
])

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'object') return actual === 'object'
  return actual === type
}

export function validate(schema: Schema, value: unknown, path = '$'): readonly Failure[] {
  const failures: Failure[] = []
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword) && !keyword.startsWith('x-')) {
      failures.push({ path, reason: `the validator does not implement schema keyword ${keyword}` })
    }
  }

  if ('const' in schema && value !== schema['const']) {
    failures.push({ path, reason: `expected ${JSON.stringify(schema['const'])}, found ${JSON.stringify(value)}` })
  }
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).includes(value)) {
    failures.push({ path, reason: `${JSON.stringify(value)} is not one of ${JSON.stringify(schema['enum'])}` })
  }
  const type = schema['type']
  if (typeof type === 'string' && !matchesType(value, type)) {
    failures.push({ path, reason: `expected ${type}, found ${typeOf(value)}` })
  }
  if (Array.isArray(type) && !(type as string[]).some((one) => matchesType(value, one))) {
    failures.push({ path, reason: `expected one of ${type.join(', ')}, found ${typeOf(value)}` })
  }

  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>
    const properties = (schema['properties'] as Record<string, Schema> | undefined) ?? {}
    for (const name of (schema['required'] as string[] | undefined) ?? []) {
      if (!(name in object)) failures.push({ path, reason: `required property ${name} is missing` })
    }
    for (const [name, child] of Object.entries(object)) {
      const property = properties[name]
      if (property !== undefined) {
        failures.push(...validate(property, child, `${path}.${name}`))
        continue
      }
      const extra = schema['additionalProperties']
      if (extra === false) failures.push({ path: `${path}.${name}`, reason: 'property is not in the schema' })
      else if (typeOf(extra) === 'object') failures.push(...validate(extra as Schema, child, `${path}.${name}`))
    }
  }

  if (Array.isArray(value) && typeOf(schema['items']) === 'object') {
    value.forEach((entry, index) => {
      failures.push(...validate(schema['items'] as Schema, entry, `${path}[${index}]`))
    })
  }
  return failures
}
