// SPDX-License-Identifier: Apache-2.0
// Defects an auditor found by driving the command surface by hand. Every one of them got
// past the example-based suites because those exercise the cases someone had already thought
// of; each assertion here names the interface rule it holds to, so a regression reads as the
// rule that broke rather than as a diff.

import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it, before, after } from 'node:test'

import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { COMMAND_OPTIONS } from '../../src/cli/parse.ts'
import { runCli } from '../helpers/cli-run.ts'

/** 69 bytes, which is the length that first showed `show` cutting a title at 64 cells. */
const LONG_TITLE = 'A title that runs to sixty nine bytes in total, which is over the cut'

describe('the defects found by using the tool', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  describe('B.8: quiet suppresses the header and the footer, never an error', () => {
    it('prints the error object on stderr under -q, and keeps the exit status', async () => {
      const refusal = await cli(['show', 'no-such-item', '-q'])
      assert.equal(refusal.code, 5)
      assert.equal(refusal.out, '')
      assert.match(refusal.err, /^err NOT_FOUND /)
      assert.match(refusal.err, /"cause no-such-item is in no record here/)
      assert.match(refusal.err, /^fix treadle backlog$/m, 'the remediation is part of the error object')
    })

    it('still drops the envelope and the scalars on a success', async () => {
      const quiet = await cli(['backlog', '--state', 'ready', '-q'])
      assert.equal(quiet.code, 0)
      assert.doesNotMatch(quiet.out, /^ok backlog/)
      assert.match(quiet.out, /^~items /m, 'the primary data stays')
    })
  })

  describe('A.4: the title is never truncated, because the store bounds it at 200 characters', () => {
    it('prints a 69 byte title whole on show and on the file confirmation', async () => {
      const filed = await cli(['file', 'task', LONG_TITLE, '--id', 'long-title'])
      assert.equal(filed.code, 0, filed.err)
      assert.match(filed.out, new RegExp(`^"title ${LONG_TITLE}$`, 'm'))

      const shown = await cli(['show', 'long-title'])
      assert.match(shown.out, new RegExp(`^"title ${LONG_TITLE}$`, 'm'))
      assert.doesNotMatch(shown.out, /^\+title /m, 'a bounded field emits no truncation sentinel')
      assert.doesNotMatch(shown.out, /^page .*--field title$/m)
    })
  })

  describe('the field dictionary: a hold expiry must be in the future when the hold is set', () => {
    it('refuses an instant in the past and leaves the item where it was', async () => {
      const past = await cli([
        'transition', 'csv-export', 'on_hold', '--reason', 'waiting on legal',
        '--until', '2020-01-01T00:00:00Z',
      ])
      assert.equal(past.code, 2)
      assert.match(past.err, /^err VALIDATION /)
      assert.match(past.err, /hold_until 2020-01-01T00:00:00Z is not in the future/)

      const shown = await cli(['show', 'csv-export'])
      assert.match(shown.out, /^state ready$/m, 'a refused transition writes nothing')
    })

    it('accepts an instant in the future', async () => {
      const future = await cli([
        'transition', 'csv-export', 'on_hold', '--reason', 'waiting on legal',
        '--until', '2099-01-01T00:00:00Z',
      ])
      assert.equal(future.code, 0, future.err)
      assert.match(future.out, /^set hold_until - -> 2099-01-01T00:00:00Z$/m)
    })
  })

  describe('A.2 rule 1: no trailing whitespace on any line', () => {
    it('omits the guards line entirely when the edge evaluates none', async () => {
      const held = await cli(['transition', 'avatar-crop', 'on_hold', '--reason', 'blocked on a decision'])
      assert.equal(held.code, 0, held.err)
      assert.doesNotMatch(held.out, /^guards/m, 'an absent optional value is an absent line')
    })

    it('emits no line ending in a space or a tab, on any command in the inventory', async () => {
      const invocations: readonly (readonly string[])[] = [
        ['status'],
        ['backlog'],
        ['next'],
        ['show', 'auth-refresh'],
        ['explain', 'onboard-copy'],
        ['help'],
        ['help', 'transition'],
        ['version'],
        ['transition', 'webhook-retry', 'on_hold', '--reason', 'the vendor has not replied'],
        ['transition', 'legacy-oauth', 'draft', '--reason', 'we still have callers on OAuth 1'],
      ]
      for (const argv of invocations) {
        const ran = await cli(argv)
        for (const line of `${ran.out}${ran.err}`.split('\n')) {
          assert.equal(line, line.replace(/[ \t]+$/, ''), `${argv.join(' ')} emitted "${line}"`)
        }
      }
    })
  })

  describe('B.2: a flag note says why this command ignores the flag', () => {
    it('does not call a confirmation flag a presentation flag', async () => {
      const help = await cli(['help', 'transition'])
      const noteOf = (flag: string): string =>
        help.out.split('\n').find((line) => line.startsWith(`${flag} `)) ?? ''

      assert.match(noteOf('--color'), /^--color A .*presentation/)
      assert.match(noteOf('--width'), /^--width A .*presentation/)
      for (const flag of ['--yes', '--no-input']) {
        assert.match(noteOf(flag), new RegExp(`^${flag} A `), `${flag} is still accepted and ignored here`)
        assert.doesNotMatch(noteOf(flag), /presentation/, `${flag} has nothing to do with presentation`)
        assert.match(noteOf(flag), /confirm/, `${flag} is ignored because there is no confirmation`)
      }
    })
  })

  describe('T4: a transition that requires a reason records it', () => {
    it('stores the reason in the event and reports it in explain', async () => {
      const reason = 'the acceptance criteria are not agreed yet'
      const ungroomed = await cli(['transition', 'gdpr-export', 'draft', '--reason', reason])
      assert.equal(ungroomed.code, 0, ungroomed.err)

      const events = await demo.store.events({ entity: 'gdpr-export' })
      assert.ok(events.ok)
      const last = events.value.at(-1) as { op: string; reason?: string }
      assert.equal(last.op, 'item.transition')
      assert.equal(last.reason, reason, 'a reason T4 required is stored nowhere else')

      const explained = await cli(['explain', 'gdpr-export'])
      assert.match(explained.out, new RegExp(`^"reason ${reason}$`, 'm'))
    })

    it('records nothing on an edge that needs no reason, rather than an empty value', async () => {
      const groomed = await cli(['transition', 'metrics-p95', 'ready'])
      assert.equal(groomed.code, 0, groomed.err)
      const events = await demo.store.events({ entity: 'metrics-p95' })
      assert.ok(events.ok)
      assert.equal((events.value.at(-1) as { reason?: string }).reason, undefined)

      const explained = await cli(['explain', 'metrics-p95'])
      assert.doesNotMatch(explained.out, /^"?reason/m)
    })
  })

  describe('who changed it: the actor every event carries reaches a read surface', () => {
    it('names the actor of each change in history, newest first', async () => {
      const moved = await cli(['transition', 'i18n-dates', 'ready', '--actor', 'ravi'])
      assert.equal(moved.code, 0, moved.err)

      const log = await cli(['history', 'i18n-dates'])
      assert.equal(log.code, 0, log.err)
      assert.match(log.out, /^#at kind op what "by$/m, 'the actor column is marked as third-party content')
      // "when did this reach ready, and who moved it there" is answered by this one row, so
      // the `what` cell carries both states and not only the name of the field that moved.
      assert.match(log.out, /^\S+ human item\.transition state=draft->ready ravi$/m)
      // Every part of the cell is name=value or name=from->to, which is the convention
      // test/services/history-convention.test.ts holds over every op.
      assert.match(log.out, /^\S+ human item\.file type=task,state=draft,\S+ dana$/m)
      const rows = log.out.split('\n').filter((line) => /^2026-/.test(line))
      assert.deepEqual([...rows].sort().reverse(), rows, 'the rows are newest first')
    })

    it('names the actor of the write that put the item where it is, in explain', async () => {
      const explained = await cli(['explain', 'i18n-dates'])
      assert.equal(explained.code, 0, explained.err)
      assert.match(explained.out, /^"by ravi$/m)
    })

    it('refuses an actor the event log could not carry, naming the length and the limit', async () => {
      const long = 'a'.repeat(201)
      const refused = await cli(['transition', 'theme-dark', 'ready', '--actor', long])
      assert.equal(refused.code, 2, `${refused.out}${refused.err}`)
      assert.match(refused.err, /^"cause an actor is 201 characters and the limit is 200, which is 1 over$/m)

      const events = await demo.store.events({ entity: 'theme-dark' })
      assert.ok(events.ok)
      assert.equal(events.value.length, 1, 'the refused move appended nothing')
    })

    it('accepts and ignores the same out-of-bound actor on a read, which records no event', async () => {
      const long = 'a'.repeat(201)
      const shown = await cli(['show', 'auth-refresh', '--actor', long])
      assert.equal(shown.code, 0, `${shown.out}${shown.err}`)
      assert.match(shown.out, /^item auth-refresh$/m)
    })
  })
})

describe('set echoes a reported change the same way file does', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('reports a multi-line value as its size, exits 0, and the value still reads back whole', async () => {
    const filed = await cli([
      'file', 'bug', 'Card decline', '--id', 'card-decline',
      '--set', 'severity=S2', '--set', 'found_in=production', '--set', 'repro_steps=pay with a declined card',
    ])
    assert.equal(filed.code, 0, filed.err)

    const edited = await cli(['set', 'card-decline', 'description=one\ntwo'])
    assert.equal(edited.code, 0, `${edited.out}${edited.err}`)
    assert.match(edited.out, /^set description - -> 7 chars$/m)

    const shown = await cli(['show', 'card-decline', '--field', 'desc'])
    assert.equal(shown.code, 0, shown.err)
    assert.match(shown.out, /^\|desc 2 7$/m)
    assert.match(shown.out, /^" one$/m)
    assert.match(shown.out, /^" two$/m)
  })
})

describe('a gate that demands a field names a command that can set it', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('files a bug without the fields, sets them, and reaches ready', async () => {
    const filed = await cli([
      'file', 'bug', 'Checkout drops paid orders', '--id', 'checkout-500',
      '--set', 'severity=S2', '--set', 'found_in=production', '--set', 'repro_steps=add to cart, pay',
    ])
    assert.equal(filed.code, 0, filed.err)

    const refused = await cli(['transition', 'checkout-500', 'ready'])
    assert.equal(refused.code, 3, `${refused.out}${refused.err}`)
    assert.match(refused.err, /the ready gate fails: DOR6, DOR7/)

    // The remedy is run verbatim, which is the whole of the invariant: `explain` prints a
    // command line and that command line is what makes the rule pass.
    const why = await cli(['explain', 'checkout-500'])
    const remedies = why.out.split('\n').filter((line) => line.startsWith('ready DOR'))
    assert.deepEqual(remedies, [
      'ready DOR6 fail treadle set checkout-500 expected=<value>',
      'ready DOR7 fail treadle set checkout-500 actual=<value>',
    ])

    const set = await cli(['set', 'checkout-500', 'expected=both orders are listed', 'actual=one is charged'])
    assert.equal(set.code, 0, set.err)
    assert.match(set.out, /^set expected - -> both orders are listed$/m)
    assert.match(set.out, /^set actual - -> one is charged$/m)

    const ready = await cli(['transition', 'checkout-500', 'ready'])
    assert.equal(ready.code, 0, `${ready.out}${ready.err}`)
    assert.match(ready.out, /^state draft -> ready$/m)
  })

  it('keeps severity with mark, and says so rather than writing it', async () => {
    const refused = await cli(['set', 'checkout-500', 'severity=S1'])
    assert.equal(refused.code, 2, refused.out)
    assert.match(refused.err, /^"cause severity is not set here; treadle mark checkout-500 --severity/m)
    assert.match(refused.err, /^fix treadle mark checkout-500 --severity/m)
  })

  it('records the change in the log, with prose recorded as its length', async () => {
    const log = await cli(['history', 'checkout-500', '--limit', '9'])
    assert.equal(log.code, 0, log.err)
    assert.match(
      log.out,
      /item\.set expected=\(unset\)->\(text:\d+\),actual=\(unset\)->\(text:\d+\)/,
      'the fields the set moved reach the what column, each with the length the log stored for it',
    )
  })
})

describe('the write path and the read path agree about a field\'s name', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('accepts both spellings on both paths, for the field that first diverged', async () => {
    const dictionary = await cli(['file', 'task', 'Long form', '--id', 'long-form', '--set', 'description=written long'])
    assert.equal(dictionary.code, 0, dictionary.err)
    const short = await cli(['file', 'task', 'Short form', '--id', 'short-form', '--set', 'desc=written short'])
    assert.equal(short.code, 0, short.err)

    for (const spelling of ['desc', 'description']) {
      const shown = await cli(['show', 'long-form', '--field', spelling])
      assert.equal(shown.code, 0, `show --field ${spelling}: ${shown.err}`)
      assert.match(shown.out, /^"desc written long$/m)
    }

    const edited = await cli(['set', 'long-form', 'desc=written by the short name'])
    assert.equal(edited.code, 0, edited.err)
    assert.match(edited.out, /^set description written long -> written by the short name$/m)
  })

  it('names both accepted spellings when the field really is unknown', async () => {
    const refused = await cli(['show', 'auth-refresh', '--field', 'nonesuch'])
    assert.equal(refused.code, 2, refused.out)
    assert.match(refused.err, /carries no field named nonesuch/)
    assert.match(refused.err, /desc\/description/, 'the refusal offers the dictionary name beside the short one')
  })
})

describe('S3: a duplicate id refuses every answer rather than serving the first match', () => {
  let demo: Demo
  const copy = [
    '',
    '# queue-drain: Drain the dead letter queue on deploy, the copy',
    '',
    'type: task',
    'state: draft',
    'filed_at: 2026-09-04T08:00:00Z',
    'version: 1',
    '',
  ].join('\n')

  before(async () => {
    demo = await aDemoWorkspace()
    const shard = path.join(demo.root, 'items', '2026-09.md')
    await writeFile(shard, `${await readFile(shard, 'utf8')}${copy}`)
  })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('refuses a write to the copied id, and the write leaves the shard untouched', async () => {
    const shard = path.join(demo.root, 'items', '2026-09.md')
    const before = await readFile(shard, 'utf8')

    const moved = await cli(['transition', 'queue-drain', 'ready'])
    assert.equal(moved.code, 7, `expected an integrity refusal, got ${moved.code}: ${moved.out}${moved.err}`)
    assert.match(moved.err, /^err INTEGRITY /)
    assert.match(moved.err, /^rule S3$/m)
    assert.match(moved.err, /^entity queue-drain$/m)
    assert.match(moved.err, /queue-drain names 2 records in this file/)

    assert.equal(await readFile(shard, 'utf8'), before, 'a refused write leaves the shard untouched')
  })

  // The first fix left every other record writable, and that was the hole: a gate on
  // another item reads its children from the set the copy is missing from, and a new id is
  // chosen against that same set. The store still writes every other record, which
  // test/store/duplicate-id.test.ts holds; the command surface refuses until the copy is gone.
  it('refuses every other command too, until the copy is removed, and then serves them all', async () => {
    const shard = path.join(demo.root, 'items', '2026-09.md')
    const refused = await cli(['transition', 'i18n-dates', 'ready'])
    assert.equal(refused.code, 7, refused.out)
    assert.match(refused.err, /^fix treadle doctor$/m)

    const text = await readFile(shard, 'utf8')
    assert.ok(text.endsWith(copy), 'the fixture no longer ends with the copy this case removes')
    await writeFile(shard, text.slice(0, -copy.length))

    const moved = await cli(['transition', 'i18n-dates', 'ready'])
    assert.equal(moved.code, 0, moved.err)
    const clean = await cli(['doctor'])
    assert.equal(clean.code, 0, clean.out)
  })
})

describe('a refusal about a flag is written by the tool, not by its argument parser', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  /** Byte sequences only `node:util`'s parseArgs writes. None of them may reach a surface. */
  const PARSER_PROSE = /Unknown option|does not take an argument|argument missing|argument is ambiguous|place it at the end of the command/

  const lines: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['an unknown long flag', ['show', 'i18n-dates', '--bogus'], /^"cause --bogus is not a flag of show$/m],
    ['an unknown short flag', ['show', 'i18n-dates', '-Z'], /^"cause -Z is not a flag of show$/m],
    ['a flag another command owns', ['transition', 'i18n-dates', 'ready', '--set', 'x=y'], /^"cause --set is not a flag of transition$/m],
    ['a value on a flag that takes none', ['show', 'i18n-dates', '--quiet=1'], /^"cause --quiet takes no value$/m],
    ['a flag whose value is missing', ['show', 'i18n-dates', '--field'], /^"cause --field needs a value$/m],
    ['a value that starts with a dash', ['backlog', '--limit', '-x'], /^"cause --limit needs a value, and one starting with a dash is written --limit=-x$/m],
    // The first pass is not strict and there is no command word to trigger the second, so
    // this line used to run the default command with the flag silently dropped.
    ['an unknown flag with no command word', ['--nope'], /^"cause --nope is not a flag of treadle$/m],
  ]

  for (const [what, argv, cause] of lines) {
    it(`names ${what} and points at the flag table that lists them`, async () => {
      const refused = await cli(argv)
      assert.equal(refused.code, 2, `${refused.out}${refused.err}`)
      assert.match(refused.err, cause)
      assert.doesNotMatch(refused.err, PARSER_PROSE, 'no third-party message reaches the surface')
      assert.match(refused.err, /^fix treadle help( \w+)?$/m, 'the remedy is the command that prints the flags')
      // A `cause` is a marked scalar; the parser's three-line message arrived as a counted
      // block instead, which is a different line kind for the same key.
      assert.doesNotMatch(refused.err, /^\|cause /m)
    })
  }
})

describe('an aggregate says what it aggregates, and a heading with no value prints none', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('names the completed-points counter for the points it sums, not for the items', async () => {
    const listed = await cli(['backlog'])
    assert.equal(listed.code, 0, listed.err)
    assert.match(listed.out, /^done_points \d+$/m)
    // `done` was the key, and beside a row whose STATE cell reads `done` it was read as a
    // count of finished items. No key on this surface may be read that way again.
    assert.doesNotMatch(listed.out, /^done \d+$/m)
  })

  it('drops the absent workspace from a heading that has none', async () => {
    const version = await cli(['version', '--out', 'human'])
    assert.equal(version.code, 0, version.err)
    assert.equal(version.out.split('\n')[0], 'version')

    const listed = await cli(['backlog', '--out', 'human'])
    assert.match(listed.out, /^backlog {2}\S+$/m, 'a command that opened a workspace still names it')
  })
})

describe('the defects the second adversarial pass found by using the tool', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  describe('a value that spans lines is projected on the set line, never spliced into it', () => {
    it('reports a multi-line description as its size and exits 0, because the write landed', async () => {
      const written = await cli(['set', 'auth-refresh', 'description=line one\nline two'])
      assert.equal(written.code, 0, written.err)
      assert.match(written.out, /^set description .* -> 17 chars$/m)
      const shown = await cli(['show', 'auth-refresh', '--field', 'desc'])
      assert.match(shown.out, /^\|desc 2 \d+$/m)
    })
  })

  describe('the store never writes a record it would not serve back', () => {
    it('refuses a criterion carrying a newline at exit 2, and every read after it still answers', async () => {
      const refused = await cli(['set', 'auth-refresh', 'acceptance_criteria=one\ntwo'])
      assert.equal(refused.code, 2, refused.out)
      assert.match(refused.err, /^rule V4$/m)
      assert.match(refused.err, /single line of text/)
      const shown = await cli(['show', 'auth-refresh'])
      assert.equal(shown.code, 0, shown.err)
    })
  })

  describe('a cursor that names nothing is a refusal, not the first page again', () => {
    for (const [argv, entity] of [
      [['history', 'auth-refresh', '--cursor', 'nosuch'], 'auth-refresh'],
      [['backlog', '--cursor', 'nosuch'], 'nosuch'],
      [['next', '--cursor', 'nosuch'], 'nosuch'],
    ] as const) {
      it(`${argv[0]} exits 2 naming the cursor`, async () => {
        const run = await cli(argv)
        assert.equal(run.code, 2, run.out)
        assert.match(run.err, /^rule C1$/m)
        assert.match(run.err, new RegExp(`^entity ${entity}$`, 'm'))
        assert.match(run.err, /^"cause --cursor nosuch names nothing in this list/m)
      })
    }
  })

  describe('the index is a cache, so a damaged one is rebuilt and never a stack trace', () => {
    const index = () => path.join(demo.root, '.index', 'index.sqlite')
    // The fixture's own connection is closed first: a real run is one process, and a second
    // connection holding the file open across the damage is the fixture's shape, not the tool's.
    before(async () => { await demo.store.close() })

    it('rebuilds over garbage bytes at the index path', async () => {
      assert.equal((await cli(['status'])).code, 0)
      await writeFile(index(), Buffer.from('not a database, not even close'))
      const run = await cli(['status'])
      assert.equal(run.code, 0, run.err)
      assert.match(run.out, /^items \d+$/m)
    })

    it('recomputes over a meta row that is not JSON', async () => {
      assert.equal((await cli(['status'])).code, 0)
      const db = new DatabaseSync(index())
      db.prepare("insert or replace into meta (key, value) values ('hierarchy_cycle', 'not json')").run()
      db.close()
      const run = await cli(['status'])
      assert.equal(run.code, 0, run.err)
    })

    it('refuses with S13 naming the path when a directory sits where the index goes', async () => {
      await rm(path.join(demo.root, '.index'), { recursive: true, force: true })
      await mkdir(index(), { recursive: true })
      const run = await cli(['status'])
      assert.equal(run.code, 6, run.out)
      assert.match(run.err, /^rule S13$/m)
      assert.match(run.err, /could not be opened or rebuilt/)
      await rm(path.join(demo.root, '.index'), { recursive: true, force: true })
      assert.equal((await cli(['status'])).code, 0)
    })
  })

  describe('a nearer workspace the walk cannot read is a refusal, not a step past it', () => {
    it('exits 6 with S13 naming the unreadable directory, rather than answering from the parent', { skip: process.getuid?.() === 0 }, async () => {
      const inner = path.join(demo.root, 'inner')
      const nested = path.join(inner, '.work')
      await mkdir(nested, { recursive: true })
      await chmod(nested, 0o000)
      try {
        const run = await runCli(['status'], { cwd: inner })
        assert.equal(run.code, 6, run.out)
        assert.match(run.err, /^rule S13$/m)
        assert.match(run.err, /could not be read: stat failed with EACCES/)
      } finally {
        await chmod(nested, 0o755)
        await rm(inner, { recursive: true, force: true })
      }
    })
  })
})

describe('the defects a caller found on its first walk through the tool', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('never reports a structured field as [object Object], in the set output or in history', async () => {
    const written = await cli(['set', 'csv-export', 'acceptance_criteria=a header row is present|the rows match the filter'])
    assert.equal(written.code, 0, written.err)
    assert.doesNotMatch(written.out, /\[object Object\]/)

    const ticked = await cli(['set', 'csv-export', 'acceptance_criteria=[x] a header row is present|the rows match the filter'])
    assert.equal(ticked.code, 0, ticked.err)
    assert.doesNotMatch(ticked.out, /\[object Object\]/)

    const logged = await cli(['history', 'csv-export', '--limit', '2'])
    assert.doesNotMatch(logged.out, /\[object Object\]/)
  })

  it('names --cursor in the help of every command that prints a --cursor line', async () => {
    for (const command of ['backlog', 'next', 'history']) {
      const help = await cli(['help', command])
      assert.equal(help.code, 0, help.err)
      assert.match(help.out, /^--cursor S /m, `treadle help ${command} does not name --cursor`)
      assert.match(help.out, /--cursor </, `treadle help ${command} has no usage line for --cursor`)
    }
  })

  it('refuses --cursor where it refuses --limit, rather than accepting it in silence', async () => {
    // The parser accepted `--cursor` on every command because the flag was absent from the
    // scope table, so a caller who passed it to the wrong command was told nothing.
    const refused = await cli(['show', 'csv-export', '--cursor', 'anything'])
    assert.equal(refused.code, 2)
    assert.match(refused.err, /--cursor cannot apply to show/)
    assert.match(refused.err, /^fix treadle help show$/m)
  })
})

describe('help names every flag the parser accepts', () => {
  let demo: Demo

  before(async () => { demo = await aDemoWorkspace() })
  after(async () => { await demo.dispose() })

  const cli = (argv: readonly string[]) => runCli(argv, { cwd: demo.root })

  it('has a usage line for each command flag, so a caller finds one by asking', async () => {
    // `file` accepted --id, --desc, --assignee, --label, --sprint and --parent, and `backlog`
    // accepted --sprint and --priority, none of which appeared in any help output. A caller's
    // only way to those eight was the refusal it got for guessing wrong.
    const missing: string[] = []
    for (const [command, options] of Object.entries(COMMAND_OPTIONS)) {
      const help = await cli(['help', command])
      assert.equal(help.code, 0, help.err)
      for (const flag of Object.keys(options)) {
        if (!help.out.includes(`--${flag} `) && !help.out.includes(`--${flag}=`)) {
          missing.push(`${command} --${flag}`)
        }
      }
    }
    assert.deepEqual(missing, [], `help does not name: ${missing.join(', ')}`)
  })
})
