// SPDX-License-Identifier: Apache-2.0
// Everything that must be true about a tag before anything is built, attached or published,
// and the release notes for the version it names.
//
// treadle's release is started by a person signing a tag, not by a workflow creating one, so
// the tag is the authorisation and this is where that authorisation is checked. The checks
// answer three questions a green build does not: is this tag the one this repository's policy
// allows (annotated, signed, `v<semver>`), does it name the version the tree it points at
// actually declares, and is that tree on the released branch rather than off to one side.
//
// Measured, and the reason the signature clause is here at all: pointback's four release tags
// are all lightweight (`git/refs/tags` reports `"type": "commit"` for v0.1.0 through v0.1.3),
// because release-please creates a GitHub Release and GitHub creates the tag for it. Nothing
// signs that. docs/RELEASING.md carries what treadle does instead.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { staleAgainst } from './check-dist-fresh.ts'

const SEMVER = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

export type Manifest = {
  readonly version?: string
  readonly private?: boolean
  readonly license?: string
  readonly files?: readonly string[]
  readonly bin?: Readonly<Record<string, string>>
  readonly repository?: string | { readonly url?: string }
}

export type TagFacts = {
  /** 'tag' for an annotated tag object, 'commit' for a lightweight one. */
  readonly objectType: string
  /** The commit the tag resolves to, after dereferencing an annotated tag. */
  readonly commit: string
  /** Whether `git verify-tag` accepted the signature. */
  readonly signed: boolean
  /** Whether the commit is an ancestor of, or is, the released branch's head. */
  readonly onReleaseBranch: boolean
}

/**
 * One line per problem; an empty array means the release may proceed.
 * @param publishing whether a tarball is about to leave the machine, which adds the clauses
 * that only matter at the registry.
 */
export function preflight(input: {
  readonly tag: string
  readonly facts: TagFacts
  readonly manifest: Manifest
  readonly bundleBytes: number | undefined
  readonly bundleLimit: number
  /** The source file newer than the bundle, when there is one; see `check-dist-fresh.ts`. */
  readonly staleAgainst: string | undefined
  readonly publishing: boolean
}): readonly string[] {
  const { tag, facts, manifest, bundleBytes, bundleLimit, staleAgainst, publishing } = input
  const problems: string[] = []

  if (!SEMVER.test(tag)) {
    problems.push(`tag ${tag} is not v<semver>, which the release path requires`)
  }
  if (tag !== `v${manifest.version}`) {
    problems.push(`tag ${tag} does not name package.json's version ${manifest.version}`)
  }
  if (facts.objectType !== 'tag') {
    problems.push(
      `tag ${tag} is lightweight, not an annotated tag object; a release tag carries a message ` +
        'and a signature, so it must be created with git tag -s',
    )
  }
  if (!facts.signed) {
    problems.push(
      `tag ${tag} carries no signature git could verify; every commit in this repository is ` +
        'signed and the tag that releases them must be too',
    )
  }
  if (!facts.onReleaseBranch) {
    problems.push(
      `tag ${tag} points at ${facts.commit}, which is not on the released branch; a release is ` +
        'cut from what was reviewed and merged, never from a commit off to one side',
    )
  }

  // The bundle is the product. A release with no bundle would attach a tarball carrying the
  // metadata and the schemas, which installs and then has no executable to run.
  if (bundleBytes === undefined) {
    problems.push('dist/treadle.js does not exist; run npm run build before packing')
  } else if (bundleBytes > bundleLimit) {
    problems.push(`dist/treadle.js is ${bundleBytes} bytes, over DR1's ${bundleLimit}`)
  } else if (bundleBytes < bundleLimit / 10) {
    // A floor as well as a ceiling, found by truncating a bundle and watching the freshness
    // clause pass it: an mtime says when a file was written and not that a build wrote it. The
    // measured bundle sits at about half the limit, so a tenth of it is far below any plausible
    // build of this tool and far above a partial write.
    problems.push(
      `dist/treadle.js is ${bundleBytes} bytes, under a tenth of DR1's ${bundleLimit}; `
        + 'that is a partial write rather than a build, so run npm run build again',
    )
  } else if (staleAgainst !== undefined) {
    // The workflow builds one step above this one, so a bundle older than the source here
    // means the build did not land. `prepack` cannot be relied on to catch it: this
    // repository's .npmrc sets ignore-scripts=true as a supply-chain control and the release
    // workflow's own pack step passes --ignore-scripts as well, so the packing lifecycle is
    // off by design and this is the gate that actually runs before the tarball is built.
    problems.push(
      `dist/treadle.js was written before ${staleAgainst} was last changed, so the tarball `
        + 'would carry a bundle that is not this source; run npm run build',
    )
  }

  if (publishing) {
    // `private: true` was the first publication interlock and the manifest no longer carries it.
    // The clause stays: a manifest that carries the field again is refused before anything is
    // packed, and the refusal reads as the gate holding rather than as a broken workflow.
    if (manifest.private === true) {
      problems.push(
        'package.json is "private": true, which is treadle\'s publication interlock: the name ' +
          'has not been cleared, so nothing may be published until the captain removes it',
      )
    }
    if (!manifest.license || manifest.license === 'UNLICENSED') {
      problems.push(`package.json license is ${manifest.license ?? 'absent'}, which npm will not publish`)
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      problems.push('package.json has no files allowlist, so the tarball would carry the whole tree')
    }
    const bin = Object.values(manifest.bin ?? {})
    if (bin.length === 0 || !bin.every((target) => target.startsWith('dist/'))) {
      problems.push(`package.json bin is ${JSON.stringify(manifest.bin)}; it must point into the bundle`)
    }
    // Trusted publishing generates provenance on its own, and npm's provenance prerequisites
    // require a public `repository` matching where the publish comes from. Without the field
    // the publish fails at the registry, after the tag and the release already exist, which is
    // the most expensive place to find out.
    const repository = typeof manifest.repository === 'string'
      ? manifest.repository
      : (manifest.repository?.url ?? '')
    if (!/^(git\+)?https:\/\/github\.com\//.test(repository)) {
      problems.push(
        `package.json repository is ${repository || 'absent'}, so npm cannot generate the ` +
          'provenance that trusted publishing publishes by default',
      )
    }
  }

  return problems
}

/** The CHANGELOG section for one version, header included, or undefined when there is none. */
export function notesFor(changelog: string, version: string): string | undefined {
  // Anchored at the start of the heading text, because release-please's heading links to a
  // compare view that names the PREVIOUS version too: a loose `includes` finds 0.1.0 inside
  // `## [0.2.0](.../compare/v0.1.0...v0.2.0)` and returns the wrong release's notes.
  const heading = new RegExp(`^##\\s+\\[?${version.replaceAll('.', '\\.')}[\\]\\s(]`)
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trim()
}

function git(...args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function tagFacts(tag: string, branch: string): TagFacts | undefined {
  let objectType: string
  try {
    objectType = git('cat-file', '-t', tag)
  } catch {
    // A tag that does not exist is a refusal with a sentence, not a stack trace: the release
    // path passes `github.ref_name`, so this is what a mis-triggered run should read like.
    return undefined
  }
  // `<tag>^{}` dereferences an annotated tag to its commit; a lightweight tag answers the
  // same thing, so one form covers both.
  const commit = git('rev-parse', `${tag}^{}`)
  let signed = false
  try {
    execFileSync('git', ['verify-tag', tag], { stdio: 'ignore' })
    signed = true
  } catch {
    signed = false
  }
  let onReleaseBranch = false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, branch], { stdio: 'ignore' })
    onReleaseBranch = true
  } catch {
    onReleaseBranch = false
  }
  return { objectType, commit, signed, onReleaseBranch }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      branch: { type: 'string', default: 'origin/main' },
      publishing: { type: 'boolean', default: false },
      'notes-out': { type: 'string' },
    },
  })
  const tag = values.tag
  if (tag === undefined) throw new Error('--tag is required')

  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest
  const budgets = JSON.parse(readFileSync(path.join(root, 'bench', 'budgets.json'), 'utf8')) as {
    absolute: Record<string, { limit: number }>
  }
  let bundleBytes: number | undefined
  try {
    bundleBytes = readFileSync(path.join(root, 'dist', 'treadle.js')).byteLength
  } catch {
    bundleBytes = undefined
  }

  const facts = tagFacts(tag, values.branch)
  if (facts === undefined) {
    console.error(`::error::${tag} is not a tag in this repository`)
    console.log('release preflight: 1 problem(s)')
    process.exitCode = 1
    process.exit()
  }
  const problems = preflight({
    tag,
    facts,
    manifest,
    bundleBytes,
    bundleLimit: budgets.absolute['bundleBytes']?.limit ?? 768000,
    staleAgainst: staleAgainst(root),
    publishing: values.publishing,
  })

  for (const problem of problems) console.error(`::error::${problem}`)
  console.log(
    problems.length === 0
      ? `release preflight: ok, ${tag} is an annotated signed tag at ${facts.commit}`
      : `release preflight: ${problems.length} problem(s)`,
  )

  const out = values['notes-out']
  if (out !== undefined && problems.length === 0) {
    const version = manifest.version ?? ''
    const notes = notesFor(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version)
    if (notes === undefined) {
      console.error(`::error::CHANGELOG.md has no section for ${version}`)
      process.exitCode = 1
    } else {
      writeFileSync(out, `${notes}\n`)
      console.log(`wrote ${notes.split('\n').length} lines of release notes to ${out}`)
    }
  }

  if (problems.length > 0) process.exitCode = 1
}
