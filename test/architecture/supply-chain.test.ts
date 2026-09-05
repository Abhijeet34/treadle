// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F13: three supply-chain controls the design left unstated. Two of them
// are facts about files in this repository, so they are asserted here rather than described
// anywhere. The third, provenance at publish, is a property of the release workflow and is
// checked by scripts/release-preflight.ts and by actionlint over .github/workflows/release.yml.
//
// The shipping shape is here for the same reason: `files`, `bin` and the path the benchmark
// rig weighs all have to name the same bundle, and three places that agree by hand drift.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = 'dist/treadle.js'

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>
  files?: readonly string[]
  engines?: { node?: string }
}

function tracked(file: string): boolean {
  const listed = execFileSync('git', ['ls-files', '--', file], { cwd: ROOT, encoding: 'utf8' })
  return listed.trim().length > 0
}

describe('F13 control one: install-time scripts are off', () => {
  it('.npmrc sets ignore-scripts=true', () => {
    const npmrc = readFileSync(path.join(ROOT, '.npmrc'), 'utf8')
    const setting = npmrc
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('ignore-scripts'))
    assert.equal(setting, 'ignore-scripts=true', '.npmrc must turn the install lifecycle off')
  })

  it('.npmrc is committed, so a clone and CI inherit it', () => {
    assert.ok(tracked('.npmrc'), '.npmrc only protects the machines that have it')
  })

  // The setting is worth nothing if the build needs a lifecycle script to work. esbuild
  // resolves its platform binary through an optional dependency instead, and CI proves it on
  // every run: `npm ci` under this .npmrc, then `npm run build`, which fails if it did not.
  it('the manifest declares no lifecycle script of its own to be silenced', () => {
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }).scripts ?? {}
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
      assert.equal(scripts[name], undefined, `${name} would not run under ignore-scripts=true`)
    }
  })
})

describe('F13 control two: the lockfile is committed and is what CI installs', () => {
  it('package-lock.json is tracked', () => {
    assert.ok(tracked('package-lock.json'), 'npm ci has nothing to install from without it')
  })

  it('every workflow that installs uses npm ci rather than npm install', () => {
    const workflows = execFileSync('git', ['ls-files', '--', '.github/workflows'], {
      cwd: ROOT, encoding: 'utf8',
    }).split('\n').filter((f) => f.endsWith('.yml'))
    assert.ok(workflows.length >= 3, `only ${workflows.length} workflows found`)
    for (const workflow of workflows) {
      const text = readFileSync(path.join(ROOT, workflow), 'utf8')
      const installs = text.match(/npm (?:ci|install)\b[^\n]*/g) ?? []
      for (const line of installs) {
        if (line.startsWith('npm ci')) continue
        // `npm install <spec>` names a package from the registry, which is what the smoke job
        // does to the published tarball. What must never appear is the form that resolves this
        // repository's own tree, because that is the one the lockfile binds.
        const named = line
          .replace(/^npm install\b/, '')
          .split(/\s+/)
          .filter((token) => token.length > 0 && !token.startsWith('-'))
        assert.ok(
          named.length > 0,
          `${workflow} runs "${line}", which resolves this repository's tree without the lockfile; use npm ci`,
        )
      }
    }
  })
})

describe('the published package is the bundle and nothing else', () => {
  it('bin points at the bundle', () => {
    assert.deepEqual(manifest.bin, { treadle: BUNDLE })
  })

  it('files ships the bundle and carries no source', () => {
    const files = manifest.files ?? []
    assert.ok(files.includes('dist/'), 'files must ship the bundle')
    for (const entry of files) {
      assert.ok(!entry.startsWith('src'), `files must not ship ${entry}: the bundle is the product`)
      assert.ok(!entry.startsWith('bin'), `files must not ship ${entry}: bin/ runs from source`)
    }
  })

  it('the benchmark rig weighs the same file that ships', () => {
    const facts = readFileSync(path.join(ROOT, 'bench', 'package-facts.ts'), 'utf8')
    const [dir, file] = BUNDLE.split('/')
    assert.match(facts, new RegExp(`path\\.join\\(root, '${dir}'\\)`))
    assert.match(facts, new RegExp(`path\\.join\\(dist, '${file}'\\)`))
  })

  it('the declared runtime floor is the real one, in all three places that name it', () => {
    const floor = '24.15.0'
    assert.equal(manifest.engines?.node, `>=${floor}`)
    assert.equal(readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), floor)
    // ci.yml cannot read .nvmrc into a matrix, so it names the floor literally. This is what
    // stops that literal drifting: raising the floor without raising it there would leave CI
    // testing a version the product no longer supports.
    const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    assert.match(ci, new RegExp(`node: \\["${floor.replaceAll('.', '\\.')}", `),
      `ci.yml's check matrix must have ${floor} as its first leg`)
  })
})

describe('F13 control three: the release path attests what it publishes', () => {
  const release = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  // The comments in that file discuss the flags it deliberately does not pass, so the
  // "carries no token, passes no --provenance" assertions read the instructions alone.
  const instructions = release.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')

  it('exports an SBOM and attests the tarball', () => {
    assert.match(instructions, /dependency-graph\/sbom/)
    assert.match(instructions, /actions\/attest-build-provenance@[0-9a-f]{40}/)
  })

  it('publishes over OIDC and carries no npm token', () => {
    assert.match(instructions, /id-token: write/)
    assert.doesNotMatch(instructions, /NODE_AUTH_TOKEN|NPM_TOKEN/)
    // Trusted publishing generates provenance itself, and the flag turns a
    // provenance-ineligible publish into a failed release.
    assert.doesNotMatch(instructions, /--provenance/)
  })

  it('gates the publish behind a variable and a protected environment', () => {
    assert.match(instructions, /vars\.NPM_PUBLISH_ENABLED == 'true'/)
    assert.match(instructions, /environment: npm-publish/)
  })

  it('pins every third-party action to a full commit SHA', () => {
    for (const workflow of ['ci.yml', 'cross-platform.yml', 'release.yml', 'bench.yml']) {
      const text = readFileSync(path.join(ROOT, '.github', 'workflows', workflow), 'utf8')
      for (const line of text.split('\n')) {
        const used = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)
        if (used === null) continue
        const ref = used[1] ?? ''
        // A local reusable workflow is a path in this repository, so it has no ref to pin.
        if (ref.startsWith('./')) continue
        assert.match(ref, /@[0-9a-f]{40}$/, `${workflow} uses ${ref}, which is not a commit SHA`)
      }
    }
  })
})
