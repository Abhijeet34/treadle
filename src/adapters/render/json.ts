// SPDX-License-Identifier: Apache-2.0
// The `json` rendering: the result object itself, two-space indented, carrying the
// `<command>/<version>` schema string a consumer validates it against. It is never the
// default. Measured on identical content the line format is 834 B and 245 Claude tokens
// against 2,022 B and 657 for pretty JSON, which is what requirement R1 priced.

import type { ResultObject } from '../../application/result.ts'
import type { Renderer } from './index.ts'

export const jsonRenderer: Renderer = {
  name: 'json',
  render(result: ResultObject): string {
    return `${JSON.stringify(result, null, 2)}\n`
  },
}
