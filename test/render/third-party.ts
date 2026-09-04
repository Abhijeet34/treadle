// SPDX-License-Identifier: Apache-2.0
// A fourth renderer, written the way a third party would have to write one, and existing
// only to prove the renderer seam takes an implementation that is not ours.
//
// It is deliberately trivial and deliberately ignorant. It imports two types and nothing
// else: no shape registry, no grammar module, no width table, no knowledge of which
// property is free text or which column is a block. Everything it needs it reads off the
// result object it was handed. If a renderer had to reach into the application layer to
// produce output, this file could not exist, and that is the whole of its argument.
//
// The recording renderer beside it proves the object is the only *input* a renderer gets.
// This one proves the object is enough to produce *output* from.

import type { ResultObject, Value } from '../../src/application/result.ts'
import type { Renderer, RenderOptions } from '../../src/adapters/render/index.ts'

function flatten(value: Value): string {
  if (value === null) return ''
  if (Array.isArray(value)) return value.join('; ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** `<key>=<value>` per line, keys sorted, one header line naming the schema and the code. */
export const keyValueRenderer: Renderer = {
  name: 'kv',
  render(result: ResultObject, _options: RenderOptions = {}): string {
    const lines = [`${result.schema}=${result.code}`, `workspace=${result.workspace}`]
    for (const key of Object.keys(result.data).sort()) {
      lines.push(`${key}=${flatten(result.data[key] as Value).replaceAll('\n', '\\n')}`)
    }
    return `${lines.join('\n')}\n`
  },
}
