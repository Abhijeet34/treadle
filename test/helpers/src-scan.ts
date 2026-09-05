// SPDX-License-Identifier: Apache-2.0
// Reading every source file under src/ and pulling its import specifiers out, shared by the
// three suites that hold a rule over the whole tree: the layer direction, the refusal to
// execute anything (F1, F7), and the refusal to generate a file the caller did not ask for
// (F11). One walker rather than three, because a rule enforced over a stale file list is a
// rule that stops being enforced without saying so.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SRC = path.join(ROOT, 'src')

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every `.ts` file under a directory, recursively; an empty list if it does not exist. */
export function sources(dir: string): readonly string[] {
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

/** Static and dynamic import specifiers, in source order. */
export function specifiersOf(file: string): readonly string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const re of [IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0
    for (const match of text.matchAll(re)) if (match[1] !== undefined) found.push(match[1])
  }
  return found
}

/**
 * The file with its comments blanked. A rule stated in a comment is not a violation of that
 * rule, and `[^:]` before `//` keeps a URL in a comment from swallowing the rest of the line.
 */
export function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
