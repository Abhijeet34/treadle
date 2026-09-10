// SPDX-License-Identifier: Apache-2.0
// The release path cannot be rehearsed end to end without cutting a release, so the gate in
// front of it is tested instead: every clause is exercised against a tag that would fail it.
// A green suite here is the evidence that a bad tag stops before anything is attached.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { notesFor, preflight, type Manifest, type TagFacts } from '../../scripts/release-preflight.ts'

const RELEASED_COMMIT = '0f2b1a6d9c4e7f80a1b2c3d4e5f60718293a4b5c'

const GOOD_TAG: TagFacts = {
  commit: RELEASED_COMMIT,
  onReleaseBranch: true,
}

const GOOD_MANIFEST: Manifest = {
  version: '0.2.0',
  private: false,
  license: 'Apache-2.0',
  files: ['dist/', 'schemas/'],
  bin: { treadle: 'dist/treadle.js' },
  repository: { url: 'git+https://github.com/Abhijeet34/treadle.git' },
}

function run(overrides: {
  tag?: string
  facts?: Partial<TagFacts>
  releasedCommit?: string
  manifest?: Partial<Manifest>
  bundleBytes?: number | undefined
  staleAgainst?: string | undefined
  publishing?: boolean
}): readonly string[] {
  return preflight({
    tag: overrides.tag ?? 'v0.2.0',
    facts: { ...GOOD_TAG, ...overrides.facts },
    releasedCommit: overrides.releasedCommit ?? RELEASED_COMMIT,
    manifest: { ...GOOD_MANIFEST, ...overrides.manifest },
    bundleBytes: 'bundleBytes' in overrides ? overrides.bundleBytes : 173891,
    bundleLimit: 512000,
    staleAgainst: overrides.staleAgainst,
    publishing: overrides.publishing ?? false,
  })
}

describe('the release preflight', () => {
  it('passes the tag this run created, on the released branch', () => {
    assert.deepEqual(run({}), [])
  })

  it('passes the same tag when it is about to publish', () => {
    assert.deepEqual(run({ publishing: true }), [])
  })

  it('refuses a tag that is not v<semver>', () => {
    assert.match(run({ tag: 'release-0.2.0', manifest: { version: 'release-0.2.0' } })[0] ?? '', /not v<semver>/)
  })

  it('refuses a tag that names a different version than the tree does', () => {
    assert.match(run({ tag: 'v0.3.0' })[0] ?? '', /does not name package.json's version 0\.2\.0/)
  })

  // What replaced the signature clause when ADR-0037 reversed the signed-tag decision. The
  // tag release-please creates is lightweight and unsigned, so the only question left about
  // it is whether this run is the run that made it.
  it('refuses a tag that points anywhere but the commit this run released', () => {
    const problems = run({ facts: { commit: 'deadbeef' } }).join('\n')
    assert.match(problems, /not at the released commit 0f2b1a6/)
    assert.match(problems, /must be deleted rather than reused/)
  })

  it('refuses a tag on a commit that never reached the released branch', () => {
    assert.match(run({ facts: { onReleaseBranch: false } }).join('\n'), /not on the released branch/)
  })

  it('refuses a release with no bundle built', () => {
    assert.match(run({ bundleBytes: undefined }).join('\n'), /dist\/treadle\.js does not exist/)
  })

  it('refuses a bundle over the DR1 budget', () => {
    assert.match(run({ bundleBytes: 512001 }).join('\n'), /over DR1's 512000/)
  })

  // Found by truncating dist/treadle.js to 200 bytes and touching it: every other clause
  // passed, because an mtime says when a file was written and not that a build wrote it.
  it('refuses a bundle far under the budget, which is a partial write and not a build', () => {
    assert.match(run({ bundleBytes: 200 }).join('\n'), /partial write rather than a build/)
    assert.equal(run({ bundleBytes: 51200 }).length, 0, 'a bundle at a tenth of the limit was refused')
  })

  // This clause and not `prepack` is the one that runs: .npmrc sets ignore-scripts=true as a
  // supply-chain control and the workflow's pack step passes --ignore-scripts as well.
  it('refuses a bundle older than the source it would be packed from, naming that file', () => {
    const problems = run({ staleAgainst: 'src/cli/main.ts' }).join('\n')
    assert.match(problems, /src\/cli\/main\.ts/)
    assert.match(problems, /npm run build/)
    assert.equal(run({ staleAgainst: undefined }).length, 0, 'a fresh bundle was refused')
  })

  it('names the publication interlock rather than looking like a broken workflow', () => {
    const problems = run({ manifest: { private: true }, publishing: true })
    assert.match(problems.join('\n'), /publication interlock/)
    // And it is silent on a build that is not publishing, so the interlock never blocks the
    // GitHub release, the tarball, the SBOM or the attestation.
    assert.deepEqual(run({ manifest: { private: true } }), [])
  })

  // Regression guards rather than a first setup: the manifest satisfies all four today, and
  // each is what stops a field going missing later. `repository` is the expensive one - npm
  // rejects the publish at the registry with the tag already cut, and a `v*` tag here can be
  // neither moved nor deleted, so that costs a version number permanently.
  it('refuses to publish without a licence npm would accept', () => {
    assert.match(run({ manifest: { license: 'UNLICENSED' }, publishing: true }).join('\n'), /npm will not publish/)
    assert.match(run({ manifest: { license: undefined }, publishing: true }).join('\n'), /license is absent/)
  })

  it('refuses to publish without a files allowlist, which would ship the whole tree', () => {
    assert.match(run({ manifest: { files: [] }, publishing: true }).join('\n'), /no files allowlist/)
    assert.match(run({ manifest: { files: undefined }, publishing: true }).join('\n'), /no files allowlist/)
  })

  it('refuses to publish a bin that points anywhere but the bundle', () => {
    const problems = run({ manifest: { bin: { treadle: 'bin/treadle.js' } }, publishing: true })
    assert.match(problems.join('\n'), /must point into the bundle/)
  })

  it('refuses to publish without the repository npm needs for provenance', () => {
    assert.match(run({ manifest: { repository: 'ssh://git@github.com/x/y' }, publishing: true }).join('\n'), /provenance/)
  })

  it('collects every problem rather than stopping at the first', () => {
    const problems = run({
      tag: 'v9.9.9',
      facts: { commit: 'deadbeef', onReleaseBranch: false },
      bundleBytes: undefined,
    })
    assert.equal(problems.length, 4, problems.join('\n'))
  })
})

describe('the release notes come from the changelog', () => {
  const changelog = `# Changelog

## [0.2.0](https://example.invalid/compare/v0.1.0...v0.2.0) (2026-09-05)

### Features

* a thing ([#7](https://example.invalid/7))

## 0.1.0 (2026-09-01)

### Features

* the first thing
`

  it('takes the section for the version being released, and stops at the next one', () => {
    const notes = notesFor(changelog, '0.2.0')
    assert.match(notes ?? '', /^## \[0\.2\.0\]/)
    assert.match(notes ?? '', /a thing/)
    assert.doesNotMatch(notes ?? '', /the first thing/)
  })

  it('takes the last section too, where there is no next one to stop at', () => {
    assert.match(notesFor(changelog, '0.1.0') ?? '', /the first thing/)
  })

  it('says nothing rather than guessing when the version has no section', () => {
    assert.equal(notesFor(changelog, '0.3.0'), undefined)
  })
})
