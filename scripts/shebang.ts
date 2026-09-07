// SPDX-License-Identifier: Apache-2.0
// How this tool's executables start the runtime, read from the one file that writes the line.
//
// `bin/treadle.js` carries the shebang and the reasoning behind it; the build reads it from
// here rather than spelling a second copy into the bundle banner, so the development entry
// point and the release bundle cannot start node differently.

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** The first line of `bin/treadle.js`, which is the shebang every executable of this tool gets. */
export function shebangOf(root: string): string {
  return readFileSync(path.join(root, 'bin', 'treadle.js'), 'utf8').split('\n')[0] as string
}

/** The node flags a shebang asks for: every word after the interpreter's name. */
export function flagsOf(shebang: string): readonly string[] {
  const words = shebang.replace(/^#!/, '').trim().split(/\s+/)
  const node = words.findIndex((word) => word === 'node' || word.endsWith('/node'))
  return node < 0 ? [] : words.slice(node + 1)
}

/**
 * Why a shebang would not start the tool somewhere the package says it runs, or undefined
 * when it starts everywhere. `package.json` declares no `os` restriction and the README names
 * a Node version rather than a userland, so "everywhere" is every POSIX userland, BusyBox
 * included.
 *
 * This exists because the regression it names shipped: `#!/usr/bin/env -S node
 * --stack-size=3072` was measured on 2026-09-07 printing `env: unrecognized option: S` and
 * exiting 1 on `node:24-alpine`, whose BusyBox 1.37.0 `env` takes `-i`, `-0` and `-u` only.
 * `-S` is GNU coreutils 8.30 and later, FreeBSD and macOS. A flag after `node` needs `-S` to
 * reach the interpreter at all, so either half of that line is the same defect.
 */
export function portabilityProblem(shebang: string): string | undefined {
  if (!shebang.startsWith('#!')) return `${shebang} is not a shebang`
  const words = shebang.replace(/^#!/, '').trim().split(/\s+/)
  const env = words[0] as string
  if (!env.endsWith('/env')) return undefined
  const option = words.slice(1).find((word) => word.startsWith('-') && word !== '-i')
  if (option !== undefined) {
    return `env ${option} is not in BusyBox env, which takes -i, -0 and -u, so the tool does not start on Alpine`
  }
  if (flagsOf(shebang).length > 0) {
    return `a flag after node needs env -S to reach it, and BusyBox env has no -S: ${shebang}`
  }
  return undefined
}
