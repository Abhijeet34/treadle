// SPDX-License-Identifier: Apache-2.0
// No invisible code point is a literal in any tracked file, in source, in a test, in a
// document or in the fuzzing corpus.
//
// Two reasons, and the second is the one that makes this a test rather than a convention.
// A zero-width or bidi character in a diff is unreadable, so a reviewer cannot see what a
// line does. And a file carrying one is indistinguishable from a file carrying a hidden
// marker, which is the class the machine-wide provenance scan refuses on sight.
//
// The suites here need these characters as their subject constantly. They build them from
// their numbers with `String.fromCodePoint`, or write them as `\u` escapes, which reads
// better anyway: `cp(0x2069)` beside `POP DIRECTIONAL ISOLATE` says what a literal cannot.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The same class `src/domain/text.ts` refuses, minus the three whitespace characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const ALLOWED = new Set([0x09, 0x0a, 0x0d])

/** Text this check applies to. A binary file has no notion of a literal code point. */
const TEXT = new Set(['.ts', '.js', '.json', '.md', '.yml', '.yaml', '.sh', '.txt', '.gitignore', '.gitattributes', '.editorconfig', '.nvmrc'])

function isText(file: string): boolean {
  const extension = path.extname(file)
  return TEXT.has(extension === '' ? path.basename(file) : extension)
}

describe('no tracked file carries a literal invisible code point', () => {
  it('holds across every tracked text file', (t) => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((file) => file.length > 0 && isText(file))
    assert.ok(tracked.length > 100, `only ${tracked.length} tracked text files were found`)

    const offenders: string[] = []
    for (const file of tracked) {
      const text = readFileSync(path.join(ROOT, file), 'utf8')
      if (!INVISIBLE.test(text)) continue
      for (const [at, character] of [...text].entries()) {
        const codePoint = character.codePointAt(0) as number
        if (ALLOWED.has(codePoint) || !INVISIBLE.test(character)) continue
        offenders.push(`${file} character ${at}: U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`)
        break
      }
    }

    assert.deepEqual(
      offenders, [],
      'write it as String.fromCodePoint or a \\u escape instead of a literal',
    )
    t.diagnostic(`${tracked.length} tracked text files scanned, 0 carrying a literal invisible code point`)
  })

  it('recognises one, so a green result means something', () => {
    assert.equal(INVISIBLE.test(String.fromCodePoint(0x200d)), true)
    assert.equal(INVISIBLE.test(String.fromCodePoint(0x202e)), true)
    assert.equal(INVISIBLE.test(String.fromCodePoint(0xfeff)), true)
    assert.equal(INVISIBLE.test(String.fromCodePoint(0xd800)), true)
    assert.equal(INVISIBLE.test('a'), false)
    assert.equal(INVISIBLE.test(String.fromCodePoint(0x1f642)), false)
  })
})
