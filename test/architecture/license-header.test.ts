// SPDX-License-Identifier: Apache-2.0
// Apache-2.0 asks that the licence be stated on the work. A LICENSE file states it for the
// repository; the SPDX line states it for a file that travels on its own, which a source
// file routinely does. This test is the enforcement, so a new file cannot land without one.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SPDX = 'SPDX-License-Identifier: Apache-2.0'
const COVERED = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sh', '.yml', '.yaml']

function trackedFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f.length > 0)
}

const covered = trackedFiles().filter((f) => COVERED.includes(path.extname(f)))

describe('every source file carries its SPDX identifier', () => {
  it('found files to check, so a pass is not vacuous', () => {
    assert.ok(covered.length >= 8, `only ${covered.length} covered files are tracked`)
  })

  for (const file of covered) {
    it(`${file} carries the SPDX line near the top`, () => {
      // First 400 bytes: the line belongs at the top, not buried at the bottom.
      const head = readFileSync(path.join(ROOT, file), 'utf8').slice(0, 400)
      assert.ok(head.includes(SPDX), `${file} needs a "${SPDX}" comment near the top`)
    })
  }
})

describe('the licence is declared where a consumer looks for it', () => {
  it('package.json names Apache-2.0', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      license?: string
    }
    assert.equal(manifest.license, 'Apache-2.0')
  })

  it('LICENSE is the Apache 2.0 text and NOTICE carries the copyright', () => {
    const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8')
    assert.ok(license.includes('Apache License'))
    assert.ok(license.includes('Version 2.0, January 2004'))
    const notice = readFileSync(path.join(ROOT, 'NOTICE'), 'utf8')
    assert.match(notice, /Copyright \d{4} Abhijeet Halder/)
  })
})
