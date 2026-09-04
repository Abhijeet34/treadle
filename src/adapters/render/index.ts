// SPDX-License-Identifier: Apache-2.0
// The renderer seam (DR6). Three implementations ship for a product reason: the compact
// line format an agent reads, JSON for a consumer that wants a schema-validated document,
// and the human rendering. One conformance suite feeds every command's golden result object
// to every renderer, and a fourth test-only renderer that records the object is what proves
// the object is the only input a renderer gets.

import type { ResultObject } from '../../application/result.ts'

export const RENDERINGS = ['human', 'agent', 'json'] as const
export type Rendering = (typeof RENDERINGS)[number]

export type RenderOptions = {
  /** Display cells for the human rendering, already clamped by the caller. */
  readonly width?: number
  /** Cells a free-text field is cut at, or `null` for the whole field. */
  readonly fieldLimit?: number | null
  /** The command a truncation sentinel points at, built from bounded values only. */
  readonly page?: string
  readonly quiet?: boolean
  readonly ascii?: boolean
}

export interface Renderer {
  readonly name: string
  render(result: ResultObject, options?: RenderOptions): string
}

export function isRendering(name: string): name is Rendering {
  return (RENDERINGS as readonly string[]).includes(name)
}
