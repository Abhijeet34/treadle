// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F13: three supply-chain controls the design left unstated. Two of them
// are facts about files in this repository, so they are asserted here rather than described
// anywhere. The third, provenance at publish, is a property of the release workflow and is
// checked by scripts/release-preflight.ts and by actionlint over .github/workflows/release.yml.
//
// The shipping shape is here for the same reason: `files`, `bin` and the path the benchmark
// rig weighs all have to name the same bundle, and three places that agree by hand drift.
//
// parseWorkflow below turns a workflow's YAML into `{jobName: {ifExpr, permissions, uses,
// runsOn, environment, text}}` by indentation alone, so an assertion can name the job it is
// actually about (the `publish` job's permissions, not the word "write" anywhere in the file)
// without pulling in a YAML dependency: DR7 already refused one at 686 KB for the record
// format, and this file's workflows only ever nest two levels deep.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = 'dist/treadle.js'
const WORKFLOWS = ['ci.yml', 'cross-platform.yml', 'release.yml', 'bench.yml']

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>
  files?: readonly string[]
  engines?: { node?: string }
}

function tracked(file: string): boolean {
  const listed = execFileSync('git', ['ls-files', '--', file], { cwd: ROOT, encoding: 'utf8' })
  return listed.trim().length > 0
}

type Job = {
  ifExpr?: string
  runsOn?: string
  environment?: string
  permissions: Record<string, string>
  uses: string[]
  text: string
}

function field(block: string, key: string): string | undefined {
  return new RegExp(`^ {4}${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim()
}

function permissionsOf(block: string): Record<string, string> {
  const section = /^ {4}permissions:\n((?: {6}.+\n?)+)/m.exec(`${block}\n`)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const line of section.split('\n')) {
    const kv = /^ {6}([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line)
    if (kv) out[kv[1]!] = kv[2]!.trim()
  }
  return out
}

/** A workflow's jobs, keyed by name, from its own YAML rather than a line found anywhere. */
function parseWorkflow(text: string): Record<string, Job> {
  const jobsAt = text.split('\n').findIndex((line) => line === 'jobs:')
  assert.ok(jobsAt >= 0, 'workflow has no jobs: block')
  const jobs: Record<string, Job> = {}
  let name: string | undefined
  let buf: string[] = []
  const flush = (): void => {
    if (name === undefined) return
    const block = buf.join('\n')
    jobs[name] = {
      ifExpr: field(block, 'if'),
      runsOn: field(block, 'runs-on'),
      environment: field(block, 'environment'),
      permissions: permissionsOf(block),
      uses: [...block.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]!),
      text: block,
    }
  }
  for (const line of text.split('\n').slice(jobsAt + 1)) {
    const header = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line)
    if (header) {
      flush()
      name = header[1]
      buf = []
    } else if (name !== undefined) {
      buf.push(line)
    }
  }
  flush()
  return jobs
}

function workflow(name: string): Record<string, Job> {
  return parseWorkflow(readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8'))
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

  // The setting is worth nothing unless npm itself reads it, so this runs the real consumer
  // rather than reading the file a second time: a config npm ignores would still pass a text
  // match.
  it('npm actually reads ignore-scripts=true from the committed .npmrc', () => {
    const value = execFileSync('npm', ['config', 'get', 'ignore-scripts'], {
      cwd: ROOT, encoding: 'utf8',
    }).trim()
    assert.equal(value, 'true')
  })

  // The setting is also worth nothing if the build needs a lifecycle script to work. esbuild
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

  it('every job that installs uses npm ci rather than npm install', () => {
    let sawInstall = false
    for (const file of WORKFLOWS) {
      for (const [jobName, job] of Object.entries(workflow(file))) {
        const installs = job.text.match(/npm (?:ci|install)\b[^\n]*/g) ?? []
        for (const line of installs) {
          if (line.startsWith('npm ci')) {
            sawInstall = true
            continue
          }
          // `npm install <spec>` names a package from the registry, which is what the smoke
          // job does to the published tarball. What must never appear is the form that
          // resolves this repository's own tree, because that is the one the lockfile binds.
          const named = line
            .replace(/^npm install\b/, '')
            .split(/\s+/)
            .filter((token) => token.length > 0 && !token.startsWith('-'))
          assert.ok(
            named.length > 0,
            `${file}:${jobName} runs "${line}", which resolves this repository's tree without the lockfile; use npm ci`,
          )
        }
      }
    }
    assert.ok(sawInstall, 'no job anywhere ran npm ci; the assertion above would pass vacuously')
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
    const check = workflow('ci.yml')['check']
    assert.ok(check, 'ci.yml must declare a check job')
    assert.match(check!.text, new RegExp(`node: \\["${floor.replaceAll('.', '\\.')}", `),
      `ci.yml's check matrix must have ${floor} as its first leg`)
  })
})

describe('F13 control three: the release path attests what it publishes', () => {
  const release = workflow('release.yml')

  it('the artifacts job exports an SBOM and attests the tarball', () => {
    const artifacts = release['artifacts']
    assert.ok(artifacts, 'release.yml must declare an artifacts job')
    assert.match(artifacts!.text, /dependency-graph\/sbom/)
    assert.match(artifacts!.uses.join('\n'), /actions\/attest-build-provenance@[0-9a-f]{40}/)
  })

  it('the publish job gates on OIDC id-token, the npm-publish environment and the enable flag', () => {
    const publish = release['publish']
    assert.ok(publish, 'release.yml must declare a publish job')
    assert.equal(publish!.permissions['id-token'], 'write')
    assert.equal(publish!.environment, 'npm-publish')
    assert.match(publish!.ifExpr ?? '', /vars\.NPM_PUBLISH_ENABLED == 'true'/)
  })

  it('the publish job carries no long-lived npm token and no redundant --provenance flag', () => {
    const publish = release['publish']
    assert.ok(publish)
    // The comments in this job discuss the flags it deliberately does not pass, so the
    // instructions are read with comment lines stripped rather than the job's prose.
    const instructions = publish!.text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
    assert.doesNotMatch(instructions, /NODE_AUTH_TOKEN|NPM_TOKEN/)
    // Trusted publishing generates provenance itself, and the flag turns a
    // provenance-ineligible publish into a failed release.
    assert.doesNotMatch(instructions, /--provenance/)
  })

  it('pins every third-party action, in every job, to a full commit SHA', () => {
    for (const file of WORKFLOWS) {
      for (const [jobName, job] of Object.entries(workflow(file))) {
        for (const ref of job.uses) {
          // A local reusable workflow is a path in this repository, so it has no ref to pin.
          if (ref.startsWith('./')) continue
          assert.match(ref, /@[0-9a-f]{40}$/, `${file}:${jobName} uses ${ref}, which is not a commit SHA`)
        }
      }
    }
  })
})
