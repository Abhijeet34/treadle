// SPDX-License-Identifier: Apache-2.0
// The round-six findings, each as the sequence that found it.
//
// The theme is two surfaces that describe the same fact and describe it differently: the
// machine contract against `doctor`'s own exit, `status`'s finding count against the set
// `doctor` serves, `explain`'s records column against what `transition` refuses one at a time,
// and a change log that reported which fields moved by printing fields that did not. Every
// test below pins the answer a caller reads rather than the code path that produces it.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' } as const

type Run = { code: number; out: string; err: string }
type Cli = (argv: readonly string[]) => Promise<Run>

async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-r6-'))
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: root, env: ENV })
  const init = await cli(['init'])
  assert.equal(init.code, 0, init.err)
  return { root, cli }
}

function must(run: Run, what: string): Run {
  assert.equal(run.code, 0, `${what}: ${run.err}`)
  return run
}

describe('SEAM-1: an ok envelope carries the code its exit status comes from', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'A first task', '--id', 'first-task']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('says on line 1 what --contract promises the exit status is a function of', async () => {
    // A CRLF shard is the `H16` a Windows clone produces by accident, and the one finding
    // `doctor` serves rather than hides: it answers `ok` and exits 0.
    const shard = path.join(root, '.work', 'items', `${new Date().toISOString().slice(0, 7)}.md`)
    const text = await readFile(shard, 'utf8')
    await writeFile(shard, text.replaceAll('\n', '\r\n'))

    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 0, doctor.err)
    assert.match(doctor.out, /^ok doctor /m, 'a served finding is not a refusal')
    assert.doesNotMatch(doctor.out.split('\n')[0] as string, / INTEGRITY$/, 'nothing here is hidden')
  })

  it('prints the code on an ok line whose exit status is not 0, and only then', async () => {
    // A record the store holds and cannot serve: `doctor` answers `ok` and exits 7, which is
    // the one case the contract's own rule was false for.
    const shard = path.join(root, '.work', 'items', `${new Date().toISOString().slice(0, 7)}.md`)
    await writeFile(shard, `${await readFile(shard, 'utf8')}\n# : \nstate: draft\n`)

    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 7, doctor.out)
    assert.match(doctor.out.split('\n')[0] as string, /^ok doctor \S+ INTEGRITY$/, doctor.out.split('\n')[0])

    const contract = must(await cli(['--contract']), 'contract')
    assert.match(contract.out, /^rule the exit status is a function of the code on line 1 .*not OK$/m)
    assert.match(contract.out, /^envelope tool line 1 only: ok <command> <workspace> \[<txn\|-> <changed>\] \[<CODE>\]/m)
  })
})

describe('SEAM-2: status and doctor count findings by one definition', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'A first task', '--id', 'first-task']), 'file')
    const shard = path.join(root, '.work', 'items', `${new Date().toISOString().slice(0, 7)}.md`)
    await writeFile(shard, (await readFile(shard, 'utf8')).replaceAll('\n', '\r\n'))
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('reads findings 0 on a store doctor serves whole and exits 0 on', async () => {
    const status = await cli(['status'])
    assert.equal(status.code, 0, status.err)
    assert.match(status.out, /^findings 0$/m, status.out)
    // The audit line's own definition of what that number counts, which is what made the
    // previous answer of 1 wrong rather than merely different.
    assert.match(status.out, /^audit not run here; treadle doctor reads every record/m)

    const doctor = await cli(['doctor'])
    assert.equal(doctor.code, 0, doctor.err)
    assert.match(doctor.out, /^serving 1 finding reports content this store still serves/m)
    assert.match(doctor.out, /^H16 /m, 'the finding is still reported, only not counted as hidden')
  })
})

describe('SEAM-3: a transition names every record its edge wants, in one refusal', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'Beta task', '--id', 'beta-task']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('refuses once for the two records explain already names together', async () => {
    const explained = must(await cli(['explain', 'beta-task']), 'explain')
    assert.match(explained.out, /^cancelled G7 reason,resolution$/m, explained.out)

    const refused = await cli(['transition', 'beta-task', 'cancelled'])
    assert.equal(refused.code, 2, refused.out)
    assert.match(refused.err, /records resolution, why the item stopped, and none was given/)
    assert.match(refused.err, /records a reason, and none was given/)
  })

  it('names a wrong value and a missing one together', async () => {
    const refused = await cli(['transition', 'beta-task', 'cancelled', '--resolution', 'nope'])
    assert.equal(refused.code, 2, refused.out)
    assert.match(refused.err, /nope is not a resolution/)
    assert.match(refused.err, /records a reason, and none was given/)
  })
})

describe('SEAM-8: file names every wrong value at once, as it names every missing field', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('names severity and found_in in one cause', async () => {
    const refused = await cli([
      'file', 'bug', 'Bug two', '--set', 'severity=S9', '--set', 'found_in=1.0', '--set', 'repro_steps=x',
    ])
    assert.equal(refused.code, 2, refused.out)
    assert.match(refused.err, /severity must be one of/)
    assert.match(refused.err, /found_in must be one of/)
  })
})

describe('SEAM-7 and STR-8: a sprint reports what moved and says when its window is behind', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('writes no set line for a close that finished nothing', async () => {
    must(await cli(['sprint', 'open', 'Sprint two', '--id', 'sp2', '--end', '2026-12-31']), 'open')
    const closed = must(await cli(['sprint', 'close', 'sp2']), 'close')
    assert.doesNotMatch(closed.out, /^"set finished - -> -$/m, closed.out)
    assert.doesNotMatch(closed.out, /^"set carried - -> -$/m, closed.out)
    assert.match(closed.out, /^"set state open -> closed$/m)

    const log = must(await cli(['history', 'sp2']), 'history')
    assert.doesNotMatch(log.out, /finished=\(unset\)->\(unset\)/, log.out)
    assert.match(log.out, /state=open->closed/)
  })

  it('says so when a sprint opens after its own end date', async () => {
    const opened = must(await cli([
      'sprint', 'open', 'Old sprint', '--id', 'old-sprint', '--start', '2026-01-01', '--end', '2026-01-14',
    ]), 'open')
    assert.match(opened.out, /^note this sprint's window closed on 2026-01-14, \d+ days ago, so every read reports it as ended\+\d+d\/14/m, opened.out)
  })
})

describe('STR-1 and STR-2: an id that names nothing, and a workspace inside a workspace', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('refuses a title whose every character folds away rather than filing it as its type', async () => {
    const refused = await cli(['file', 'task', '日本語のタイトルだけ'])
    assert.equal(refused.code, 2, refused.out)
    assert.match(refused.err, /^rule C1$/m)
    assert.match(refused.err, /no character of this title becomes part of an id/)
    assert.match(refused.err, /--id <slug>/)

    const named = await cli(['file', 'task', '日本語のタイトルだけ', '--id', 'nihongo'])
    assert.equal(named.code, 0, named.err)
  })

  it('refuses an init under a workspace, and names the one that would have been shadowed', async () => {
    const under = path.join(root, 'sub')
    await mkdir(under, { recursive: true })
    const nested = await runCli(['init', '--name', 'inner'], { cwd: under, env: ENV })
    assert.equal(nested.code, 2, nested.out)
    assert.match(nested.err, /^rule C1$/m)
    assert.match(nested.err, /is already a workspace above this directory/)
    assert.match(nested.err, /every command run here would answer from the new one instead/)

    // The override is the flag that already means "I know, do it anyway".
    const forced = await runCli(['init', '--name', 'inner', '--yes'], { cwd: under, env: ENV })
    assert.equal(forced.code, 0, forced.err)
  })
})

describe('STR-7: the two variables that decide who every event names', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('names them on a help page and in the first thing init tells a stranger to do', async () => {
    const help = must(await cli(['help', 'transition']), 'help')
    assert.match(help.out, /--actor S supported: it names who the event records; TREADLE_ACTOR and TREADLE_ACTOR_KIND/)

    const fresh = await mkdtemp(path.join(tmpdir(), 'treadle-r6-init-'))
    try {
      const started = await runCli(['init', '--name', 'fresh'], { cwd: fresh, env: {} })
      assert.equal(started.code, 0, started.err)
      assert.match(started.out, /^next export TREADLE_ACTOR=/m, started.out)
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})

// Two defects this branch introduced and then found by attacking its own change. Both are
// here because the shape that produced them - a rule stated over a rendering rather than over
// the record, and a widening that manufactures a well-shaped value out of a malformed one -
// is the shape a later round would find again.
describe('the change log still reports an edit whose two sides render alike', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'Prose probe', '--id', 'prose-probe']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('prints a description replaced by another of the same length', async () => {
    // Prose reaches the event log as its length, so both sides render `(text:14)`. A filter
    // that dropped a pair whose two sides rendered alike made the whole cell `-` for a write
    // that happened; the filter is `(unset)` on both sides and nothing else.
    must(await cli(['set', 'prose-probe', 'description=aaaaaaaaaaaaaa']), 'first')
    must(await cli(['set', 'prose-probe', 'description=bbbbbbbbbbbbbb']), 'second')
    const log = must(await cli(['history', 'prose-probe']), 'history')
    const rows = log.out.split('\n').filter((line) => line.includes('item.set'))
    assert.equal(rows.length, 2, log.out)
    for (const row of rows) assert.doesNotMatch(row, / - unknown| - dana/, `a write that happened reports no move: ${row}`)
    assert.match(rows[0] as string, /description=\(text:14\)->\(text:14\)/, rows[0] as string)
  })
})

describe('a day that does not exist is refused rather than widened into one that does', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'Key rotation', '--id', 'key-rotation']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('takes a real calendar day and refuses one the calendar does not have', async () => {
    for (const day of ['2026-99-99', '2026-02-31', '2027-02-29', '2026-13-01']) {
      const refused = await cli(['set', 'key-rotation', `due=${day}`])
      assert.equal(refused.code, 2, `${day} was accepted: ${refused.out}`)
    }
    must(await cli(['set', 'key-rotation', 'due=2028-02-29']), 'a leap day is a real day')
    const refusedHold = await cli(['transition', 'key-rotation', 'on_hold', '--until', '2026-02-31', '--reason', 'x'])
    assert.equal(refusedHold.code, 2, refusedHold.out)
  })
})

describe('STR-9: a due date and a hold both take the day the rest of the tool takes', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'Rotate the signing key', '--id', 'key-rotate']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('stores a day as its first instant, and still names both forms when neither is given', async () => {
    must(await cli(['set', 'key-rotate', 'due=2026-09-30']), 'set due')
    assert.match(must(await cli(['show', 'key-rotate']), 'show').out, /^due 2026-09-30T00:00:00Z$/m)

    must(await cli(['transition', 'key-rotate', 'on_hold', '--until', '2026-10-15', '--reason', 'waiting']), 'hold')
    assert.match(must(await cli(['show', 'key-rotate']), 'show').out, /^hold_until 2026-10-15T00:00:00Z$/m)

    const refused = await cli(['set', 'key-rotate', 'due=2026-9-30'])
    assert.equal(refused.code, 2, refused.out)
    assert.match(refused.err, /or a day such as 2026-09-05/)
  })
})
