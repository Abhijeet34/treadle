// SPDX-License-Identifier: Apache-2.0
// The dependency direction is a rule, so it gets a test rather than a paragraph.
// Layers are ordered; a file may import from its own layer and from every layer before it,
// and never from one after it. src/domain is additionally pure: no runtime, no I/O, no clock.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'src')

/** Inward first. A layer may reach anything at or before its own index. */
const LAYERS = ['domain', 'application', 'adapters', 'cli'] as const

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function sources(dir: string): readonly string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

function specifiersOf(file: string): readonly string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const re of [IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) if (match[1] !== undefined) found.push(match[1])
  }
  return found
}

function layerOf(file: string): (typeof LAYERS)[number] | undefined {
  const rel = path.relative(SRC, file)
  const head = rel.split(path.sep)[0]
  return LAYERS.find((l) => l === head)
}

describe('the layer directories exist and are the ones the architecture names', () => {
  for (const layer of LAYERS) {
    it(`src/${layer} is present`, () => {
      assert.ok(readdirSync(path.join(SRC, layer)).length > 0, `src/${layer} must not be empty`)
    })
  }
})

describe('dependency direction', () => {
  it('has at least one source file to judge, so a pass is not vacuous', () => {
    assert.ok(sources(SRC).length >= 5, `found ${sources(SRC).length} sources under src/`)
  })

  for (const file of sources(SRC)) {
    const from = layerOf(file)
    if (from === undefined) continue
    const rel = path.relative(ROOT, file)

    it(`${rel} imports only inward`, () => {
      for (const spec of specifiersOf(file)) {
        if (!spec.startsWith('.')) continue
        const target = path.resolve(path.dirname(file), spec)
        const to = layerOf(target)
        assert.ok(
          to !== undefined,
          `${rel} imports ${spec}, which is outside every layer under src/`,
        )
        assert.ok(
          LAYERS.indexOf(to) <= LAYERS.indexOf(from),
          `${rel} is in ${from} and imports from ${to}; the direction is ${LAYERS.join(' <- ')}`,
        )
      }
    })
  }
})

describe('src/domain is pure and I/O-free', () => {
  // Each pattern is a capability the domain must not have. The store, the clock and the
  // id generator arrive as arguments from the layers above; that is what the seams are for.
  const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
    [/\bnew Date\b/, 'reads the wall clock; take the instant as an argument'],
    [/\bDate\.now\b/, 'reads the wall clock; take the instant as an argument'],
    [/\bMath\.random\b/, 'reads a random source; take the id as an argument'],
    [/\bprocess\./, 'reads the process; the domain has no process'],
    [/\bglobalThis\b/, 'reaches the global scope'],
    [/\bperformance\./, 'reads a clock'],
    [/\bconsole\./, 'writes to a stream; the domain returns values instead'],
  ]

  // Comments describe the rule, so scanning them would flag the sentence that states it.
  // `[^:]` before `//` keeps a URL in a comment from swallowing the rest of the line.
  const codeOnly = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  for (const file of sources(path.join(SRC, 'domain'))) {
    const rel = path.relative(ROOT, file)
    const text = codeOnly(readFileSync(file, 'utf8'))

    it(`${rel} imports no runtime module and no package`, () => {
      for (const spec of specifiersOf(file)) {
        assert.ok(!spec.startsWith('node:'), `${rel} imports ${spec}`)
        assert.ok(spec.startsWith('.'), `${rel} imports the bare specifier ${spec}`)
      }
    })

    it(`${rel} touches nothing ambient`, () => {
      for (const [pattern, why] of FORBIDDEN) {
        assert.ok(!pattern.test(text), `${rel} matches ${pattern}: it ${why}`)
      }
    })
  }
})

describe('the package declares zero runtime dependencies', () => {
  it('has no dependencies field, or an empty one', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      assert.equal(Object.keys(manifest[key] ?? {}).length, 0, `${key} must stay empty`)
    }
  })
})
