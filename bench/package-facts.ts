// SPDX-License-Identifier: Apache-2.0
// The DR8 budget rows that are properties of the package rather than of a run: dependency
// count, install size and bundle size. All three need `npm run build` to have run, because
// `dist/treadle.js` is what the `files` allowlist ships and what `bin` points at. Without it
// every one of them says so rather than reporting a number that weighs an incomplete tree.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
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
  const built = existsSync(bundle)
  const unbuilt = 'NOT MEASURED: dist/treadle.js has not been built, so the package is incomplete; run npm run build'

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
