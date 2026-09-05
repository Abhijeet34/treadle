// SPDX-License-Identifier: Apache-2.0
// scripts/check-licences.ts has no fixture of its own installed tree to check itself against,
// so every clause below builds one: a permissive package, a scoped package, a package that
// declares no licence at all, a package nested inside another package's own node_modules, a
// copyleft package, and a compliant and a non-compliant compound SPDX expression.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { findProblems, installed } from '../../scripts/check-licences.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-licences.ts')

function pkg(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
}

const fixture = mkdtempSync(path.join(os.tmpdir(), 'treadle-licences-'))
after(() => rmSync(fixture, { recursive: true, force: true }))

writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
const modules = path.join(fixture, 'node_modules')
pkg(path.join(modules, 'good-pkg'), { name: 'good-pkg', version: '1.0.0', license: 'MIT' })
pkg(path.join(modules, '@scope', 'scoped-pkg'), { name: '@scope/scoped-pkg', version: '1.0.0', license: 'Apache-2.0' })
pkg(path.join(modules, 'no-licence-pkg'), { name: 'no-licence-pkg', version: '1.0.0' })
pkg(path.join(modules, 'nested-pkg'), { name: 'nested-pkg', version: '1.0.0', license: 'MIT' })
pkg(path.join(modules, 'nested-pkg', 'node_modules', 'inner-pkg'), { name: 'inner-pkg', version: '1.0.0', license: 'ISC' })
pkg(path.join(modules, 'bad-pkg'), { name: 'bad-pkg', version: '1.0.0', license: 'GPL-3.0' })
pkg(path.join(modules, 'compound-ok-pkg'), { name: 'compound-ok-pkg', version: '1.0.0', license: '(MIT OR Apache-2.0)' })
pkg(path.join(modules, 'compound-bad-pkg'), { name: 'compound-bad-pkg', version: '1.0.0', license: '(MIT OR GPL-3.0)' })

describe('installed() walks the whole tree', () => {
  const tree = installed(modules)
  const names = tree.map((p) => p.name).sort()

  it('finds a plain package, a scoped package and a package nested inside another', () => {
    assert.ok(names.includes('good-pkg'))
    assert.ok(names.includes('@scope/scoped-pkg'))
    assert.ok(names.includes('inner-pkg'))
  })

  it('finds every package planted in the fixture, and only those', () => {
    assert.deepEqual(names, [
      '@scope/scoped-pkg',
      'bad-pkg',
      'compound-bad-pkg',
      'compound-ok-pkg',
      'good-pkg',
      'inner-pkg',
      'nested-pkg',
      'no-licence-pkg',
    ])
  })
})

describe('findProblems() names what is wrong', () => {
  const tree = installed(modules)
  const problems = findProblems(tree, {})

  it('flags the GPL-3.0 package', () => {
    assert.ok(problems.some((p) => p.includes('bad-pkg@1.0.0') && p.includes('GPL-3.0')))
  })

  it('flags the package with no declared licence', () => {
    assert.ok(problems.some((p) => p.includes('no-licence-pkg@1.0.0') && p.includes('NONE DECLARED')))
  })

  it('accepts a compound SPDX expression whose terms are all allowed', () => {
    assert.ok(!problems.some((p) => p.includes('compound-ok-pkg')))
  })

  it('rejects a compound SPDX expression naming a disallowed term', () => {
    assert.ok(problems.some((p) => p.includes('compound-bad-pkg')))
  })
})

describe('the command form, pointed at a fixture with --root', () => {
  it('exits 1 and names the offending package', () => {
    assert.throws(
      () => execFileSync('node', [SCRIPT, '--root', fixture], { encoding: 'utf8', stdio: 'pipe' }),
      (error: unknown) => {
        const e = error as { status?: number; stderr?: string }
        assert.equal(e.status, 1)
        assert.match(e.stderr ?? '', /bad-pkg@1\.0\.0 is GPL-3\.0/)
        return true
      },
    )
  })
})
