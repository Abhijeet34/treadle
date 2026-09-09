// SPDX-License-Identifier: Apache-2.0
// Every way the store is unavailable carries a fix line that clears that way, and no other.
//
// Three separate causes printed `fix treadle status`, and `status` is a read: it never takes
// the lock, it does not look in `.txn`, and over a workspace that refused every write it
// answered `ok items 1 findings 0`. The unreadable-shard cause was worse, because `status`
// there reproduced the identical refusal, `fix treadle status` included, so the fix line
// printed itself. Either way an agent that follows fix lines loops, while the remedy sits in
// the `cause` sentence it was never told to act on. Four more refusals in the same class
// carried no `fix` at all: the three `init` paths and the Node floor.
//
// So this file holds two rules. The first is over the source: every code and rule pair the
// store can raise into `STORE_UNAVAILABLE` has a line, and no line is a command that reads
// the store, because such a line either repeats the refusal or denies it. The second is over
// the tool: each cause is provoked, the remedy its own fix line names is carried out, and the
// same command is run again and succeeds.

import assert from 'node:assert/strict'
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import type { StoreError } from '../../src/application/ports/store.ts'
import { unavailableFixes } from '../../src/application/services/refusal.ts'
import { checkRuntime } from '../../src/cli/runtime.ts'
import { commandNamed } from '../../src/cli/inventory.ts'
import { runCli, type Run } from '../helpers/cli-run.ts'
import { POSIX_MODES } from '../helpers/platform.ts'
import { codeOnly, sources, SRC } from '../helpers/src-scan.ts'

const ENV = { TREADLE_ACTOR: 'dana' }

/** Root reads and writes a path whose mode is 0o000 anyway, so the mode proves nothing there. */
const NEEDS_MODES = POSIX_MODES
  || (process.getuid?.() === 0 ? 'root ignores a mode of 0o000' : false)

/** The store codes `CODE_OF` in the refusal service widens into `STORE_UNAVAILABLE`. */
const UNAVAILABLE_CODES = ['STORE_UNAVAILABLE', 'LOCK_TIMEOUT', 'LOCK_LOST', 'SCHEMA_NEWER', 'SCHEMA_OLDER'] as const

const RAISED_POSITIONAL = new RegExp(
  String.raw`storeFail(?:<[^>]*>)?\(\s*'(${UNAVAILABLE_CODES.join('|')})',\s*'(S\d+)'`, 'g',
)
const RAISED_LITERAL = new RegExp(
  String.raw`code:\s*'(${UNAVAILABLE_CODES.join('|')})',\s*rule:\s*'(S\d+)'`, 'g',
)

type Raised = Pick<StoreError, 'code' | 'rule'>

/**
 * Every `(code, rule)` this tool can raise into the unavailable class, read off the source
 * rather than listed here, so a raise site added later is judged by the rules below without
 * anyone remembering to add it.
 */
function raisedPairs(): ReadonlyMap<string, Raised> {
  const found = new Map<string, Raised>()
  for (const file of sources(SRC)) {
    const text = codeOnly(readFileSync(file, 'utf8'))
    for (const re of [RAISED_POSITIONAL, RAISED_LITERAL]) {
      re.lastIndex = 0
      for (const match of text.matchAll(re)) {
        const code = match[1] as StoreError['code']
        const rule = match[2] as string
        found.set(`${code} ${rule}`, { code, rule })
      }
    }
  }
  return found
}

/**
 * A command that opens the refusing store to read it. `version` and `help` are standalone and
 * answer without one, and `init` writes, so all three stay offerable; these do not.
 */
function readsTheStore(line: string): boolean {
  const words = line.split(' ')
  if (words[0] !== 'treadle') return false
  const command = commandNamed(words[1] ?? '')
  return command !== undefined && command.effect === 'read' && command.standalone !== true
}

describe('every unavailable-store cause the source can raise carries a fix line', () => {
  const pairs = raisedPairs()

  it('found the raise sites, so the two rules below are not judging an empty set', () => {
    // Ten was the count when this was written. A floor rather than an equality, because a
    // new raise site should reach the rules below rather than fail this line.
    assert.ok(pairs.size >= 10, `found only ${pairs.size} unavailable raise sites: ${[...pairs.keys()].join(', ')}`)
  })

  for (const [name, pair] of pairs) {
    it(`${name} names a remedy`, () => {
      const fixes = unavailableFixes(pair)
      assert.ok(fixes.length > 0, `${name} offers no fix line, so the refusal cannot be acted on`)
      for (const line of fixes) {
        assert.equal(line.includes('\n'), false, `${name} offers a fix line that is not one line: ${line}`)
      }
    })

    it(`${name} does not answer with a read of the store it refused`, () => {
      for (const line of unavailableFixes(pair)) {
        assert.equal(
          readsTheStore(line), false,
          `${name} offers ${line}, which reads the same store: it either repeats this refusal or reports it clean`,
        )
      }
    })
  }

  it('the Node floor names a remedy too, and it is not a read of any store', () => {
    const checked = checkRuntime('20.0.0')
    assert.equal(checked.ok, false)
    if (checked.ok) return
    assert.ok(checked.fix.length > 0, 'the runtime refusal offers no fix line')
    for (const line of checked.fix) assert.equal(readsTheStore(line), false, line)
  })
})

/** The `fix` lines a refusal carried, in the order it printed them. */
function fixLines(run: Run): readonly string[] {
  return [...run.err.matchAll(/^fix (.+)$/gm)].map((match) => match[1] as string)
}

function refused(run: Run): void {
  assert.equal(run.code, 6, `expected exit 6, got ${run.code}: ${run.out}${run.err}`)
  assert.match(run.err, /^err STORE_UNAVAILABLE /m)
}

describe('each unavailable-store fix line clears the refusal that printed it', () => {
  let root: string
  let work: string
  let pristine: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'treadle-unavailable-fix-'))
    work = path.join(root, '.work')
    pristine = path.join(root, 'pristine')
    const init = await runCli(['init', '--name', 'unavailable', '--yes'], { cwd: root, env: ENV })
    assert.equal(init.code, 0, init.err)
    const filed = await runCli(['file', 'task', 'The first task', '--id', 'first-task'], { cwd: root, env: ENV })
    assert.equal(filed.code, 0, filed.err)
    // Stands in for the copy in git, which is what the damaged-file line points a reader at.
    await cp(work, pristine, { recursive: true })
  })
  after(async () => {
    await chmod(work, 0o755).catch(() => undefined)
    await chmod(path.join(work, 'items'), 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })

  it('a stray file in .txn says to delete that file, and deleting it lets the write through', async () => {
    const stray = path.join(work, '.txn', 'tstale.json')
    await writeFile(stray, 'this is not a journal\n')
    const run = await runCli(['file', 'task', 'A second task'], { cwd: root, env: ENV })

    // What the line says, done: the file is read, then removed. Ahead of the assertions, so a
    // failure here does not leave the stray journal refusing every test after this one.
    assert.equal(await readFile(stray, 'utf8'), 'this is not a journal\n')
    await rm(stray)

    refused(run)
    assert.match(run.err, /^rule S13$/m)
    assert.deepEqual(fixLines(run), [
      'delete the .txn file named in cause; read it first, because the store will not discard it on a guess',
    ])

    const after = await runCli(['file', 'task', 'A second task'], { cwd: root, env: ENV })
    assert.equal(after.code, 0, `the fix line did not clear the refusal: ${after.err}`)
  })

  it('a shard this process may not read says to make the path readable, and that clears it', { skip: NEEDS_MODES }, async () => {
    const items = path.join(work, 'items')
    await chmod(items, 0o000)
    const run = await runCli(['backlog'], { cwd: root, env: ENV })
    await chmod(items, 0o755)
    refused(run)
    assert.match(run.err, /^rule S13$/m)
    assert.deepEqual(fixLines(run), [
      'make the path named in cause readable and writable by this user, and check its filesystem for space',
    ])

    const after = await runCli(['backlog'], { cwd: root, env: ENV })
    assert.equal(after.code, 0, `the fix line did not clear the refusal: ${after.err}`)
  })

  it('a lock that cannot be created says the same, because it is the same errno', { skip: NEEDS_MODES }, async () => {
    await chmod(work, 0o500)
    const run = await runCli(['file', 'task', 'A third task'], { cwd: root, env: ENV })
    await chmod(work, 0o755)
    refused(run)
    assert.match(run.err, /^rule S11$/m)
    assert.deepEqual(fixLines(run), [
      'make the path named in cause readable and writable by this user, and check its filesystem for space',
    ])

    const after = await runCli(['file', 'task', 'A third task'], { cwd: root, env: ENV })
    assert.equal(after.code, 0, `the fix line did not clear the refusal: ${after.err}`)
  })

  it('a damaged workspace.md says to restore the file, and restoring it clears it', async () => {
    const record = path.join(work, 'workspace.md')
    await writeFile(record, 'this is not a schema line\n')
    const run = await runCli(['backlog'], { cwd: root, env: ENV })
    // Restored before the assertions, so a failure here leaves the next test its own state
    // rather than a second failure that says nothing about the line it is checking.
    const damaged = await readFile(record, 'utf8')
    await cp(path.join(pristine, 'workspace.md'), record)
    assert.equal(damaged, 'this is not a schema line\n')
    refused(run)
    assert.match(run.err, /^rule S1$/m)
    assert.deepEqual(fixLines(run), [
      'the store file named in cause is damaged, missing or past a ceiling, and no command here repairs it; repair it by hand or restore it from git',
    ])

    const after = await runCli(['backlog'], { cwd: root, env: ENV })
    assert.equal(after.code, 0, `the fix line did not clear the refusal: ${after.err}`)
  })

  it('no refusal here offers status, which is the read that answered clean over all of them', async () => {
    const stray = path.join(work, '.txn', 'tstale.json')
    await writeFile(stray, 'this is not a journal\n')
    const run = await runCli(['file', 'task', 'A fourth task'], { cwd: root, env: ENV })
    refused(run)
    assert.equal(fixLines(run).includes('treadle status'), false, run.err)

    // The half that made the loop vicious rather than merely useless: over this exact state,
    // the command the old fix line named exits 0 and reports the store holding no findings.
    const status = await runCli(['status'], { cwd: root, env: ENV })
    assert.equal(status.code, 0, status.err)
    assert.match(status.out, /^findings 0$/m)
    await rm(stray)
  })
})
