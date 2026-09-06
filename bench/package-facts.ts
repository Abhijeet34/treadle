// SPDX-License-Identifier: Apache-2.0
// The DR8 budget rows that are properties of the package rather than of a run: dependency
// count, install size and bundle size. All three need `npm run build` to have run, because
// `dist/treadle.js` is what the `files` allowlist ships and what `bin` points at. Without it
// every one of them says so rather than reporting a number that weighs an incomplete tree.
//
// A bundle older than the sources says so too. An absent one was already refused, and a stale
// one was not: a run on 2026-09-06 published 281,312 bytes off a bundle a previous session
// had left behind, and building at the same commit produced 328,057. A size budget over a
// bundle from another commit is worse than no figure, because it reads like one.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type PackageFacts = {
  readonly runtimeDependencies: number
  readonly devDependencies: number
  readonly packedBytes: number | string
  readonly unpackedBytes: number | string
  readonly fileCount: number | string
  readonly bundleBytes: number | string
}

export function packageFacts(root: string): PackageFacts {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const dist = path.join(root, 'dist')
  const bundle = path.join(dist, 'treadle.js')
  const present = existsSync(bundle)
  const staleBy = present ? olderThanSources(root, bundle) : undefined
  const built = present && staleBy === undefined
  const unbuilt = !present
    ? 'NOT MEASURED: dist/treadle.js has not been built, so the package is incomplete; run npm run build'
    : `NOT MEASURED: dist/treadle.js is older than ${staleBy}, so it is not this tree; run npm run build`

  let packed: number | string
  let unpacked: number | string
  let files: number | string
  try {
    if (!built) throw new Error(unbuilt)
    // `npm pack --dry-run` writes nothing and needs no network; it reports the tarball the
    // `files` list would produce, which is the install size DR8 budgets.
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const report = JSON.parse(out) as readonly { size: number; unpackedSize: number; entryCount: number }[]
    const first = report[0]
    if (first === undefined) throw new Error('npm pack --dry-run --json returned an empty array')
    packed = first.size
    unpacked = first.unpackedSize
    files = first.entryCount
  } catch (error) {
    const message = (error as Error).message.split('\n')[0]
    const reason = built ? `NOT MEASURED: npm pack --dry-run failed: ${message}` : unbuilt
    packed = reason
    unpacked = reason
    files = reason
  }

  return {
    runtimeDependencies: Object.keys(manifest.dependencies ?? {}).length,
    devDependencies: Object.keys(manifest.devDependencies ?? {}).length,
    packedBytes: packed,
    unpackedBytes: unpacked,
    fileCount: files,
    bundleBytes: built ? statSync(bundle).size : unbuilt,
  }
}

/** The first source file newer than the bundle, or undefined when the bundle is current. */
function olderThanSources(root: string, bundle: string): string | undefined {
  const at = statSync(bundle).mtimeMs
  const walk = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = walk(full)
        if (found !== undefined) return found
        continue
      }
      if (statSync(full).mtimeMs > at) return path.relative(root, full)
    }
    return undefined
  }
  const manifest = path.join(root, 'package.json')
  if (statSync(manifest).mtimeMs > at) return 'package.json'
  return walk(path.join(root, 'src'))
}
