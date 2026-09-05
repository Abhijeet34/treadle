// SPDX-License-Identifier: Apache-2.0
// The licence gate, and the generator for THIRD-PARTY-NOTICES.md.
//
// Two questions, because they have different answers. What ships: nothing but treadle's own
// bundle, which is what the `files` allowlist and the zero-dependency budget produce, so no
// third-party attribution attaches to the published tarball and NOTICE says so. What is
// installed to build and test it: 88 packages at last count, none of which ship, every one of
// which still has to carry a licence this project may use.
//
// Run it to verify, `--write` to regenerate the notices file, `--list` to enumerate the whole
// installed tree with each package's licence.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Permissive licences only. A copyleft licence on a build tool is not an emergency, but it is
// a decision, and this list is where the decision would be recorded rather than discovered.
const ALLOWED = new Set([
  'MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD',
  'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0',
])

/**
 * A bare licence id behaves exactly as before. A compound SPDX expression such as
 * `(MIT OR Apache-2.0)` is accepted when every term it names is on the allowlist: strip the
 * surrounding parentheses, split on the `OR`/`AND` operators, drop any `WITH` exception clause
 * per term, and require each remaining id to be allowed.
 */
function isAllowedLicence(licence: string): boolean {
  const stripped = licence.trim().replace(/^\((.*)\)$/, '$1')
  return stripped
    .split(/\s+(?:OR|AND)\s+/)
    .every((term) => ALLOWED.has(term.trim().split(/\s+WITH\s+/)[0]?.trim() ?? term))
}

/** What each direct development dependency is for. A package with no line here fails. */
const PURPOSE: Readonly<Record<string, string>> = {
  '@anthropic-ai/tokenizer': "the token counts in the benchmark rig's output budgets",
  '@commitlint/cli': 'the Conventional Commits check CI runs over a pull request',
  '@commitlint/config-conventional': 'the rule set that check uses',
  '@types/node': "type declarations for the runtime, which is the only API treadle's code calls",
  esbuild: "DR1's bundler: one entry file, at most 500 KB",
  'gpt-tokenizer': 'the second tokenizer the rig reports, so no single vocabulary decides a budget',
  typescript: 'type checking; Node strips the types at run time and never compiles them',
}

export type Installed = { readonly name: string; readonly version: string; readonly licence: string }

/** Every package in the installed tree, including transitive ones and nested trees. */
export function installed(dir: string, scope = ''): Installed[] {
  if (!existsSync(dir)) return []
  const found: Installed[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      found.push(...installed(path.join(dir, entry.name), `${entry.name}/`))
      continue
    }
    const home = path.join(dir, entry.name)
    const manifest = path.join(home, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      version?: string
      license?: string | { type?: string }
      licenses?: readonly { type?: string }[]
    }
    const declared = typeof parsed.license === 'string'
      ? parsed.license
      : (parsed.license?.type ?? parsed.licenses?.[0]?.type ?? 'NONE DECLARED')
    found.push({ name: `${scope}${entry.name}`, version: parsed.version ?? '?', licence: declared })
    found.push(...installed(path.join(home, 'node_modules')))
  }
  return found
}

/**
 * The problem list for a walked tree: a disallowed licence anywhere in it, and a declared
 * devDependency that is either missing from the tree or missing its PURPOSE line.
 */
export function findProblems(
  tree: readonly Installed[],
  devDependencies: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = []
  for (const pkg of tree) {
    if (!isAllowedLicence(pkg.licence)) {
      problems.push(`${pkg.name}@${pkg.version} is ${pkg.licence}, which is not on the allowlist`)
    }
  }
  const byName = new Map(tree.map((p) => [p.name, p]))
  for (const name of Object.keys(devDependencies).sort()) {
    if (!byName.has(name)) problems.push(`${name} is a devDependency but is not installed`)
    else if (PURPOSE[name] === undefined) problems.push(`${name} has no line in PURPOSE; say what it is for`)
  }
  return problems
}

function notices(direct: readonly Installed[]): string {
  const rows = direct.map((p) => `| \`${p.name}\` | ${p.licence} | ${PURPOSE[p.name]} |`)
  return `# Third-party notices

Nothing third-party ships in the published package.

The tarball carries \`dist/treadle.js\`, the JSON Schemas, \`LICENSE\`, \`NOTICE\` and this file.
The bundle is built from this repository's own source and from no other code: treadle declares zero runtime dependencies, which \`test/architecture/layering.test.ts\` enforces, so there is no third-party attribution to make and \`NOTICE\` states that.
That is the whole notice obligation, and the rest of this file is about a tree that never leaves the machine it was installed on.

## The development tree

Building, type checking, testing and benchmarking treadle installs a tree of packages.
None of them ships.
Every one of them still has to carry a licence this project may use, and \`scripts/check-licences.ts\` checks the whole installed tree, transitive packages included, against this allowlist:

${[...ALLOWED].sort().map((id) => `\`${id}\``).join(', ')}.

A package licensed under anything else fails the check rather than being noticed later.

## Direct development dependencies

Versions move; the licence and the reason are what this table is for.
\`package.json\` holds the version ranges and \`package-lock.json\` holds what was actually installed.

| Package | Licence | What it is for |
|---|---|---|
${rows.join('\n')}

This file is generated. Run \`npm run licences -- --write\` after changing a development dependency, and commit the result.
`
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      list: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
    },
  })
  const root = values.root !== undefined ? path.resolve(values.root) : ROOT
  const noticesFile = path.join(root, 'THIRD-PARTY-NOTICES.md')

  const tree = installed(path.join(root, 'node_modules'))
  if (tree.length === 0) {
    console.error('no packages are installed, so this check would pass vacuously; run npm ci first')
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const problems = findProblems(tree, manifest.devDependencies ?? {})

  const byName = new Map(tree.map((p) => [p.name, p]))
  const direct: Installed[] = []
  for (const name of Object.keys(manifest.devDependencies ?? {}).sort()) {
    const found = byName.get(name)
    if (found !== undefined && PURPOSE[name] !== undefined) direct.push(found)
  }

  if (values.list) {
    for (const pkg of [...tree].sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`${pkg.name}@${pkg.version}\t${pkg.licence}`)
    }
  }

  const wanted = notices(direct)
  if (values.write) {
    writeFileSync(noticesFile, wanted)
    console.log(`wrote ${path.relative(root, noticesFile)}`)
  } else if (!existsSync(noticesFile) || readFileSync(noticesFile, 'utf8') !== wanted) {
    problems.push('THIRD-PARTY-NOTICES.md is not what this script generates; run npm run licences -- --write')
  }

  const shipped = Object.keys(manifest.dependencies ?? {}).length
  for (const problem of problems) console.error(problem)
  console.log(
    problems.length === 0
      ? `licences: ok, ${tree.length} installed packages, ${direct.length} direct, ${shipped} shipped`
      : `licences: ${problems.length} problem(s) over ${tree.length} installed packages`,
  )
  process.exitCode = problems.length === 0 ? 0 : 1
}
