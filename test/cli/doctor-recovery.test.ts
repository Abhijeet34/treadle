// SPDX-License-Identifier: Apache-2.0
// A refusal that can only be cleared by an undocumented manual step is an incomplete refusal.
// An index that disagrees with the files once locked a workspace until `.work/.index` was
// deleted by hand, which no refusal named. Every integrity refusal prints `fix treadle doctor`,
// so doctor has to be the way back: it answers from the files, never from what the index held
// (ADR-0020). The same run shows the guard was corrected and not weakened: a duplicate the
// file really carries is reported by doctor and keeps refusing every other command.

import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { IndexCache } from '../../src/adapters/store/index.ts'
import { aDemoWorkspace } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

/** The one `fix` line a refusal prints, as the argv to run it with. */
function printedFix(text: string): readonly string[] {
  const match = /^fix (.+)$/m.exec(text)
  assert.ok(match !== null, `no fix line in:\n${text}`)
  const [tool, ...argv] = (match[1] as string).split(' ')
  assert.equal(tool, 'treadle')
  return argv
}

describe('a workspace locked by an index that disagrees with its files', () => {
  it('is recovered by running only the fix line the refusal printed', async () => {
    const demo = await aDemoWorkspace()
    try {
      const warm = await runCli(['show', 'metrics-p95'], { cwd: demo.root })
      assert.equal(warm.code, 0, warm.out + warm.err)

      // What a partial read once recorded: a finding under the file's true fingerprint, so
      // no refresh will re-read the file and the finding outlives the misreading.
      const cache = new IndexCache(path.join(demo.root, '.index'))
      const [log] = [...cache.fingerprints().keys()].filter((file) => file.endsWith('.jsonl'))
      assert.ok(log !== undefined)
      const fingerprint = cache.fingerprints().get(log)
      assert.ok(fingerprint !== undefined)
      cache.replaceEventFile(log, fingerprint, [], [], [{
        file: log, line: 1, rule: 'S14', id: 'planted',
        reason: 'event planted at line 1 repeats an id the index only thought it held',
      }], true, fingerprint.size)
      cache.close()

      const locked = await runCli(['show', 'metrics-p95'], { cwd: demo.root })
      assert.equal(locked.code, 7, locked.out + locked.err)
      assert.match(locked.out + locked.err, /^rule S14$/m)

      const recovered = await runCli(printedFix(locked.out + locked.err), { cwd: demo.root })
      assert.equal(recovered.code, 0, recovered.out + recovered.err)
      assert.match(recovered.out, /^clean checked /m)

      const served = await runCli(['show', 'metrics-p95'], { cwd: demo.root })
      assert.equal(served.code, 0, served.out + served.err)
    } finally {
      await demo.dispose()
    }
  })

  it('stays locked while a record file really carries the duplicate, and doctor names its line', async () => {
    const demo = await aDemoWorkspace()
    try {
      const warm = await runCli(['show', 'metrics-p95'], { cwd: demo.root })
      assert.equal(warm.code, 0, warm.out + warm.err)
      const cache = new IndexCache(path.join(demo.root, '.index'))
      const [log] = [...cache.fingerprints().keys()].filter((file) => file.endsWith('.jsonl'))
      cache.close()
      assert.ok(log !== undefined)
      const lines = (await readFile(path.join(demo.root, log), 'utf8')).split('\n').filter((l) => l !== '')
      await appendFile(path.join(demo.root, log), `${lines[0]}\n`)

      const locked = await runCli(['show', 'metrics-p95'], { cwd: demo.root })
      assert.equal(locked.code, 7, locked.out + locked.err)
      assert.match(locked.out + locked.err, /^rule S14$/m)

      const doctor = await runCli(printedFix(locked.out + locked.err), { cwd: demo.root })
      assert.equal(doctor.code, 7, doctor.out + doctor.err)
      assert.match(doctor.out, new RegExp(`^S14 \\S+ ${log.replace('.', '\\.')}:${lines.length + 1} `, 'm'))

      const still = await runCli(['show', 'metrics-p95'], { cwd: demo.root })
      assert.equal(still.code, 7, still.out + still.err)
    } finally {
      await demo.dispose()
    }
  })
})
