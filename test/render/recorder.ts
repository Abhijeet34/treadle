// SPDX-License-Identifier: Apache-2.0
// The fourth renderer, and the only one that ships nowhere. It records the object it was
// handed and emits nothing, which is how the conformance suite proves that a renderer's
// only input is the result object: what the recorder saw is the whole of what the three
// real renderers had to work with.

import type { ResultObject } from '../../src/application/result.ts'
import type { Renderer, RenderOptions } from '../../src/adapters/render/index.ts'

export type Recording = {
  readonly result: ResultObject
  readonly options: RenderOptions
}

export class RecordingRenderer implements Renderer {
  readonly name = 'record'
  readonly seen: Recording[] = []

  render(result: ResultObject, options: RenderOptions = {}): string {
    this.seen.push({ result, options })
    return ''
  }
}
