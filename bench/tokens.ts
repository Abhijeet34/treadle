// SPDX-License-Identifier: Apache-2.0
// Byte and token accounting for an output artefact.
//
// Three tokenizers, reported side by side and never averaged, because they disagree and the
// disagreement is the information: the interface specification measured `metric
// cumulative_flow` at 1.55 bytes per token and `status` at 3.32, so a byte budget alone
// mis-prices dense numeric output by roughly twofold. The ratio is reported per artefact so
// that divergence is visible rather than inferred.
//
// The Claude column encodes a legacy vocabulary (Anthropic publishes no tokenizer for the
// current models), so it is a real measurement of a real tokenizer and not a measurement of
// any current model. It is never used alone for a decision.

import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

export type TokenizerName = 'claude' | 'o200k' | 'cl100k'

export const TOKENIZERS: readonly TokenizerName[] = ['claude', 'o200k', 'cl100k']

export type TokenizerLoad =
  | { readonly ok: true; readonly name: TokenizerName; readonly package: string; readonly version: string; readonly count: (text: string) => number }
  | { readonly ok: false; readonly name: TokenizerName; readonly package: string; readonly reason: string }

function load(name: TokenizerName, pkg: string, build: () => (text: string) => number): TokenizerLoad {
  try {
    const count = build()
    const version = (require_(`${pkg}/package.json`) as { version: string }).version
    return { ok: true, name, package: pkg, version, count }
  } catch (error) {
    return { ok: false, name, package: pkg, reason: (error as Error).message }
  }
}

export function loadTokenizers(): readonly TokenizerLoad[] {
  return [
    load('claude', '@anthropic-ai/tokenizer', () => {
      const mod = require_('@anthropic-ai/tokenizer') as { countTokens: (t: string) => number }
      return (text) => mod.countTokens(text)
    }),
    load('o200k', 'gpt-tokenizer', () => {
      const mod = require_('gpt-tokenizer/encoding/o200k_base') as { encode: (t: string) => readonly number[] }
      return (text) => mod.encode(text).length
    }),
    load('cl100k', 'gpt-tokenizer', () => {
      const mod = require_('gpt-tokenizer/encoding/cl100k_base') as { encode: (t: string) => readonly number[] }
      return (text) => mod.encode(text).length
    }),
  ]
}

export type Accounting = {
  readonly label: string
  readonly bytes: number
  readonly lines: number
  /** A count per tokenizer, or the loader's own words about why there is none. */
  readonly tokens: Readonly<Record<TokenizerName, number | string>>
  /** Bytes per token, per tokenizer. Divergence across the three is the point. */
  readonly bytesPerToken: Readonly<Record<TokenizerName, number | string>>
}

export function account(label: string, text: string, loaded: readonly TokenizerLoad[]): Accounting {
  const bytes = Buffer.byteLength(text, 'utf8')
  const tokens: Record<string, number | string> = {}
  const ratio: Record<string, number | string> = {}
  for (const tokenizer of loaded) {
    if (!tokenizer.ok) {
      tokens[tokenizer.name] = `NOT MEASURED: ${tokenizer.package} did not load: ${tokenizer.reason}`
      ratio[tokenizer.name] = `NOT MEASURED: ${tokenizer.package} did not load`
      continue
    }
    const n = tokenizer.count(text)
    tokens[tokenizer.name] = n
    ratio[tokenizer.name] = n === 0 ? 'NOT MEASURED: zero tokens, so the ratio is undefined' : Number((bytes / n).toFixed(2))
  }
  return {
    label,
    bytes,
    lines: text.length === 0 ? 0 : text.split('\n').length,
    tokens: tokens as Accounting['tokens'],
    bytesPerToken: ratio as Accounting['bytesPerToken'],
  }
}
