// SPDX-License-Identifier: Apache-2.0
// The three assets reach the release release-please already made, and the one shape that
// cannot deliver them is a create.
//
// `release_created` is the output of release-please having created the tag AND the release:
// `skip-github-release` is what would separate them, and the `release-tag` job does not set
// it. So by the time `artifacts` runs, the release exists. Job 102910409340 on run
// 34488379552 is the only time that job has ever executed: it built the tarball, exported the
// SBOM, wrote SHA256SUMS and uploaded an attestation, then ended on `a release with the same
// tag name already exists: v0.1.2`. Three releases are on the forge carrying no assets.
//
// Asserted about the job's own ordered steps rather than about substrings anywhere in the
// file, for the reason test/helpers/workflow.ts exists.

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { workflowOf } from '../helpers/workflow.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('the artifacts job attaches to the release rather than creating it', () => {
  const job = workflowOf(ROOT, 'release.yml')['artifacts']
  const shell = (): string => (job?.steps ?? []).map((step) => step.run ?? '').join('\n')

  it('release.yml still has an artifacts job', () => {
    assert.ok(job !== undefined, 'release.yml no longer has an artifacts job')
  })

  it('never runs gh release create', () => {
    assert.doesNotMatch(shell(), /gh release create/,
      'release-please has already created the release; a create can only fail on the tag it made')
  })

  it('uploads all three assets onto the existing tag', () => {
    const upload = (job?.steps ?? []).find((step) => (step.run ?? '').includes('gh release upload'))
    assert.ok(upload, 'the artifacts job must upload the assets it built')
    for (const asset of ['"$TARBALL"', 'sbom.spdx.json', 'SHA256SUMS']) {
      assert.ok(upload.run?.includes(asset), `the upload must name ${asset}`)
    }
    // A re-run of the job re-uploads assets that are already there, and without this it fails
    // on the first one rather than replacing it.
    assert.match(upload.run ?? '', /--clobber/, 'the upload must replace an asset it finds')
  })

  it('sets the release body before the upload, because publication appends to that body', () => {
    const at = (want: string): number =>
      (job?.steps ?? []).findIndex((step) => (step.run ?? '').includes(want))
    const notes = at('--notes-out')
    const attach = at('gh release upload')
    assert.ok(notes >= 0, 'the preflight no longer writes the release notes')
    assert.ok(attach >= 0, 'the artifacts job no longer uploads the assets')
    assert.ok(notes < attach, `the notes are written at step ${notes} and read at step ${attach}`)
    // Both commands live in one step, so the order that matters is the order of its lines.
    const body = job?.steps[attach]?.run ?? ''
    const editAt = body.indexOf('gh release edit')
    assert.ok(editAt >= 0, 'the artifacts job no longer puts the changelog notes on the release')
    assert.ok(editAt < body.indexOf('gh release upload'),
      'the body is set first, so the release reads correctly even when the upload is what fails')
  })
})
