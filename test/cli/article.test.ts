// SPDX-License-Identifier: Apache-2.0
// The indefinite article before a noun the code fills in. `withArticle` in src/domain/text.ts
// is the one rule, and two sites still spelled the article themselves: `file impediment
// --set expected=x` read `a impediment` and `mark <epic> --severity` read `a epic` off the
// validator, while `set` on the same field read `an impediment` off the editor, and a
// transition given `--outcome nope` read `not a outcome`. Fixing the sentences one at a time
// is how those two survived the first fix, so the rule is held over the source: no template
// literal puts a bare `a` or `an` in front of a placeholder.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'
import { SRC, codeOnly, sources } from '../helpers/src-scan.ts'

const COMPOSED = /\b(?:a|an) \$\{/g

describe('the indefinite article is composed by one rule', () => {
  it('no source line spells an article in front of a value it fills in', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      if (file.endsWith(path.join('domain', 'text.ts'))) continue
      const lines = codeOnly(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, at) => {
        if (COMPOSED.test(line)) offenders.push(`${path.relative(SRC, file)}:${at + 1}: ${line.trim()}`)
        COMPOSED.lastIndex = 0
      })
    }
    assert.deepEqual(offenders, [], 'compose the article with withArticle(noun) from src/domain/text.ts')
  })

  describe('and the three paths that spelled it themselves now agree with the editor', () => {
    let demo: Demo
    before(async () => { demo = await aDemoWorkspace() })
    after(async () => { await demo.dispose() })
    const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

    it('file refuses a field the type has not got with the same article set uses', async () => {
      const filed = await cli(['file', 'impediment', 'Late', '--set', 'severity=S1', '--set', 'proposed_resolution=renew', '--set', 'expected=x'])
      assert.equal(filed.code, 2)
      assert.match(filed.err, /^"cause expected is not a field of an impediment$/m)
      const epic = await cli(['file', 'epic', 'Wide', '--set', 'outcome=y', '--set', 'severity=S1'])
      assert.equal(epic.code, 2)
      assert.match(epic.err, /^"cause severity is not a field of an epic$/m)
    })

    it('a value outside a closed set names the set with its article', async () => {
      const outcome = await cli(['transition', 'auth-refresh', 'ready', '--outcome', 'nope', '--reason', 'x'])
      assert.equal(outcome.code, 2)
      assert.match(outcome.err, /^"cause nope is not an outcome; the set is failed, yielded$/m)
      const resolution = await cli(['transition', 'csv-export', 'cancelled', '--resolution', 'nope', '--reason', 'x'])
      assert.equal(resolution.code, 2)
      assert.match(resolution.err, /^"cause nope is not a resolution; the set is /m)
    })
  })
})
