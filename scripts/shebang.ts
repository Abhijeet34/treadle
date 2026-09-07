// SPDX-License-Identifier: Apache-2.0
// How this tool's executables start the runtime, read from the one file that writes the line.
//
// `bin/treadle.js` carries the shebang and the measurements behind its `--stack-size`; the
// build reads it from here rather than spelling a second copy into the bundle banner, so the
// development entry point and the release bundle cannot start node differently.

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

/** The runtime's own default, in KiB, which is what a flag list that names none asks for. */
export const V8_DEFAULT_STACK_KIB = 984

/** KiB of V8 stack a flag list asks for. */
export function stackKibOf(flags: readonly string[]): number {
  const found = flags.map((flag) => /^--stack-size=(\d+)$/.exec(flag)).find((match) => match !== null)
  return found === null || found === undefined ? V8_DEFAULT_STACK_KIB : Number(found[1])
}
