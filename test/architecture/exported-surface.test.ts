// SPDX-License-Identifier: Apache-2.0
// A value under `src/` that nothing outside its own file names is not exported.
//
// Two sweeps have now been run over this tree for dead code. The first reported "no uncalled
// functions, just some unnecessary export keywords" and left them; the second named fourteen
// and missed three. A sweep is the wrong instrument for a condition that returns on the next
// commit, because the keyword costs nothing to type and nothing notices it afterwards.
//
// Why it is worth refusing at all: an export is a claim that a symbol has readers elsewhere,
// so it is what a reader trusts when deciding whether a change is local. A wrong claim makes
// every genuine one worth less, and it hides the case this file exists to surface, which is a
// symbol that has no readers anywhere and should have gone with the code that stopped calling
// it. `rollUp` sat exported and uncalled through two sweeps and one release cycle.
//
// Values only. A `type` or an `interface` names a shape a caller builds structurally, so it
// can be exported for a reader with no line anywhere that spells its name, and refusing that
// would be refusing documentation. A value has no such second life: nothing can use it
// without naming it.
//
// A barrel line is not a reader. `export { X } from './x.ts'` names X and reads nothing, so
// a symbol whose only mention outside its own file is a barrel line is exported to nobody:
// nothing is published (`"private": true`), only `dist/treadle.js` ships, and no external
// consumer keeps one alive. Eleven values sat in that position when this rule was widened,
// so the re-export clauses are stripped out of the reference text before the match.
//
// A document IS a reader. `MAX_GOAL`, `MAX_EVIDENCE_REF` and `nextTowardDone` are named in
// docs/DOMAIN.md as the domain core's published surface, which is a deliberate claim about
// the symbol and not an accident, so the tracked Markdown counts alongside the code.
//
// The reference scan is a word match over every `.ts` in the tree, `bin/`, and the tracked
// Markdown. That is deliberately lenient in one direction only: an unrelated local or a
// prose word of the same name reads as a reference and lets an export through, which
// under-reports. It cannot invent a reference for a name that appears nowhere else, which is
// the direction that matters.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function filesUnder(dir: string, extensions: readonly string[]): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(full, extensions))
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full)
  }
  return found
}

const SOURCES = filesUnder(path.join(ROOT, 'src'), ['.ts'])
const EVERYWHERE = ['src', 'test', 'bench', 'scripts'].flatMap(
  (dir) => filesUnder(path.join(ROOT, dir), ['.ts']),
  ).concat(filesUnder(path.join(ROOT, 'bin'), ['.js']))
  .concat(filesUnder(path.join(ROOT, 'docs'), ['.md']))
  .concat(['README.md', 'AGENTS.md', 'CONTRIBUTING.md'].map((name) => path.join(ROOT, name)))

/** `export const X`, `export function X`, `export async function X`, `export class X`. */
const VALUE_EXPORT = /^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm

/** `export { a, b }` with no `from`: the file's own values, listed rather than prefixed. */
const VALUE_LIST = /^export \{ ([A-Za-z_$][\w$, ]*) \}$/gm

/** A re-export clause names a symbol and reads nothing, so it is not a reference. */
const reference = (source: string): string =>
  source.replace(/export\s*\{[^}]*\}\s*from\s*'[^']*'/g, ' ')

const text = new Map(EVERYWHERE.map((file) => [file, reference(readFileSync(file, 'utf8'))]))

describe('every value src exports is named outside the file that declares it', () => {
  it('names no export that only its own file uses', () => {
    const orphans: string[] = []
    for (const file of SOURCES) {
      const source = readFileSync(file, 'utf8')
      const names = [...source.matchAll(VALUE_EXPORT)].map((match) => match[1] as string)
      for (const listed of source.matchAll(VALUE_LIST)) {
        for (const name of (listed[1] as string).split(',')) names.push(name.trim())
      }
      for (const name of new Set(names)) {
        const named = EVERYWHERE.some((other) =>
          other !== file && new RegExp(`\\b${name}\\b`).test(text.get(other) as string))
        if (!named) orphans.push(`${path.relative(ROOT, file)}: ${name}`)
      }
    }
    assert.deepEqual(orphans, [],
      'these are exported and named nowhere else; drop the export keyword, or delete the value if nothing calls it either')
  })

  it('scans a set large enough to mean something', () => {
    const exports = SOURCES.reduce(
      (sum, file) => sum + [...readFileSync(file, 'utf8').matchAll(VALUE_EXPORT)].length, 0)
    assert.ok(exports >= 100, `only ${exports} value exports were found under src/`)
  })
})
