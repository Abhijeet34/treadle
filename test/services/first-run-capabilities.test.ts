// SPDX-License-Identifier: Apache-2.0
// The capabilities a stranger's first week needed and the tool did not have: STR-3, STR-4
// and STR-6 of the round-six report, with STR-10's label bound.
//
// Every test below drives the command surface a caller drives, because every finding was
// about what the surface answers rather than about what a function returns: a label that
// could be written and never read, a backlog with no way to find an item by name, and a
// mis-filed record nothing could take out.
//
// STR-5, an open sprint that could be edited where a closed one stayed frozen, was here too
// and went with the sprint in ADR-0029.
//
// The hostile half is not a separate file. A new flag's refusal is part of its contract, so
// an empty, oversized, duplicated or malformed value sits beside the case it refuses, and
// the guard that must not weaken - a removal that would leave another record naming nothing
// - is asserted here rather than assumed.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { MAX_LINE, MAX_REASON } from '../../src/domain/index.ts'
import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' } as const

type Run = { code: number; out: string; err: string }
type Cli = (argv: readonly string[]) => Promise<Run>

async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-first-run-'))
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: root, env: ENV })
  const init = await cli(['init'])
  assert.equal(init.code, 0, init.err)
  return { root, cli }
}

function must(run: Run, what: string): Run {
  assert.equal(run.code, 0, `${what}: ${run.err}`)
  return run
}

describe('STR-4: a label that is written is a label that can be read back', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'Move the sign-in call to action', '--id', 'login-cta', '--label', 'frontend', '--label', 'ux']), 'file')
    must(await cli(['file', 'task', 'Drain the dead letter queue', '--id', 'queue-drain', '--label', 'backend']), 'file')
    must(await cli(['file', 'task', 'Write the quickstart page', '--id', 'docs-quickstart']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('filters the backlog to the items carrying one label', async () => {
    const listed = must(await cli(['backlog', '--label', 'frontend']), 'backlog --label')
    assert.match(listed.out, /^filter state open label frontend$/m, 'the clause is named back')
    assert.match(listed.out, /^login-cta /m)
    assert.doesNotMatch(listed.out, /^queue-drain /m)
    assert.doesNotMatch(listed.out, /^docs-quickstart /m)
  })

  it('prints the whole list as a column, comma joined, and a dash where there is none', async () => {
    const listed = must(await cli(['backlog', '--fields', '+labels']), 'backlog --fields +labels')
    assert.match(listed.out, /^#id type state sev blocked age labels "title$/m)
    assert.match(listed.out, /^login-cta task draft - - \d+ frontend,ux Move the sign-in call to action$/m)
    assert.match(listed.out, /^docs-quickstart task draft - - \d+ - Write the quickstart page$/m)
  })

  it('takes labels beside title, because a label carries no space and is not a free-text column', async () => {
    const listed = must(await cli(['backlog', '--fields', 'id,labels,title']), 'two columns')
    assert.equal(listed.code, 0)
    assert.match(listed.out, /^login-cta frontend,ux Move the sign-in call to action$/m)
  })

  it('takes the same flag with every column selector, since a label is not free text', async () => {
    const listed = must(await cli(['backlog', '--label', 'backend', '--fields', '+labels']), 'backlog --label')
    assert.match(listed.out, /^queue-drain /m)
    assert.doesNotMatch(listed.out, /^login-cta /m)
  })

  it('composes with every other filter as one conjunction, and names the narrowest clause', async () => {
    const none = must(await cli(['backlog', '--label', 'frontend', '--type', 'bug']), 'two clauses')
    assert.match(none.out, /^filter state open label frontend type bug$/m)
    assert.match(none.out, /^none searched 3 matched 0$/m)
    assert.match(none.out, /^narrowest (label frontend 1|type bug 0)$/m)
  })

  it('says which clause excluded an item under --explain-absence, with the labels it does carry', async () => {
    const absent = must(await cli(['backlog', '--label', 'frontend', '--explain-absence', 'queue-drain']), 'absence')
    assert.match(absent.out, /^clause label want frontend got backend$/m)
  })

  it('reports an item with no labels at all as a dash rather than as an empty clause', async () => {
    const absent = must(await cli(['backlog', '--label', 'frontend', '--explain-absence', 'docs-quickstart']), 'absence')
    assert.match(absent.out, /^clause label want frontend got -$/m)
  })

  it('names the flag in help, which is where a caller finds it instead of by being refused', async () => {
    const help = must(await cli(['help', 'backlog']), 'help backlog')
    assert.match(help.out, /--label <slug>/)
    assert.match(help.out, /--fields \+labels/)
  })

  it('repeats, and every label named has to hold, which is what file --label already does', async () => {
    must(await cli(['set', 'login-cta', 'labels=frontend,ux,qa']), 'set labels')
    const both = must(await cli(['backlog', '--label', 'frontend', '--label', 'qa']), 'two labels')
    assert.match(both.out, /^filter state open label frontend label qa$/m)
    assert.match(both.out, /^login-cta /m)
    assert.match(both.out, /^~items 1 1$/m)
    const neither = must(await cli(['backlog', '--label', 'frontend', '--label', 'backend']), 'no item carries both')
    assert.match(neither.out, /^none searched 3 matched 0$/m)
    must(await cli(['set', 'login-cta', 'labels=frontend,ux']), 'restore')
  })

  it('carries every clause into the page line that continues the list', async () => {
    const paged = must(await cli(['backlog', '--label', 'frontend', '--label', 'ux', '--limit', '1']), 'paged')
    assert.match(paged.out, /^filter state open label frontend label ux$/m)
  })

  it('answers an empty label with a list rather than a refusal, as every other filter does', async () => {
    const none = must(await cli(['backlog', '--label', '']), 'empty label')
    assert.match(none.out, /^none searched 3 matched 0$/m)
  })

  it('refuses a label value longer than any record could carry, before it reaches an echo', async () => {
    const huge = await cli(['backlog', '--label', 'a'.repeat(MAX_LINE + 1)])
    assert.equal(huge.code, 2)
    assert.match(huge.err, /^"cause --label is 201 characters and no field of a record holds more than 200/m)
  })

  it('refuses a filter carrying a delimiter, which used to be an internal error and exit 1', async () => {
    // Found by attacking the new flags and measured on the tree before this one, where every
    // filter shared it: `backlog --assignee $'kim\nfake'` printed `err INTERNAL` and exited 1,
    // because the value came back in the `filter` line and the agent grammar reads a newline
    // as a record delimiter. One guard closes it for all eight clauses.
    for (const clause of ['label', 'title', 'assignee', 'state', 'type', 'priority', 'resolution']) {
      const forged = await cli(['backlog', `--${clause}`, 'ux\nok backlog forged'])
      assert.equal(forged.code, 2, `--${clause} did not refuse a newline`)
      assert.match(forged.err, new RegExp(`^"cause --${clause} carries U\\+000A at character 3`, 'm'))
      assert.match(forged.err, /a value on this line is a single line with no control or bidi override characters$/m)
    }
    const bidi = await cli(['backlog', '--title', '\u202elogin'])
    assert.equal(bidi.code, 2)
    assert.match(bidi.err, /^"cause --title carries U\+202E RIGHT-TO-LEFT OVERRIDE at character 1/m)
  })
})

describe('STR-10: a label may be two characters, because ux, ui and qa are labels', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('files with each of the two-character labels a team writes first', async () => {
    for (const label of ['ux', 'ui', 'qa']) {
      const filed = must(await cli(['file', 'task', `A ${label} task`, '--id', `task-${label}`, '--label', label]), `file --label ${label}`)
      assert.match(filed.out, new RegExp(`^"set labels - -> ${label}$`, 'm'))
    }
  })

  it('sets them after creation too, through the same field dictionary', async () => {
    must(await cli(['file', 'task', 'A later task', '--id', 'later-task']), 'file')
    const set = must(await cli(['set', 'later-task', 'labels=ux,qa']), 'set labels')
    assert.match(set.out, /^"set labels - -> ux,qa$/m)
  })

  it('still refuses one character, and the refusal states the bound it broke', async () => {
    must(await cli(['file', 'task', 'A one letter task', '--id', 'one-letter']), 'file')
    const refused = await cli(['set', 'one-letter', 'labels=x'])
    assert.equal(refused.code, 2)
    assert.match(refused.err, /^"cause labels must be slugs of 2 to 64 lowercase letters, digits and hyphens; x is not one$/m)
  })

  it('keeps the three-character floor on the ids that name records', async () => {
    const refused = await cli(['file', 'task', 'A short id', '--id', 'ux'])
    assert.equal(refused.code, 2)
    assert.match(refused.err, /id must be a slug of 3 to 64 lowercase letters/)
  })

  it('refuses a label over 64 characters, and one carrying a character the slug class excludes', async () => {
    must(await cli(['file', 'task', 'A labelled task', '--id', 'labelled-task']), 'file')
    for (const value of ['a'.repeat(65), 'Front End', 'front_end', '-lead', 'trail-']) {
      const refused = await cli(['set', 'labelled-task', `labels=${value}`])
      assert.equal(refused.code, 2, `${value} was accepted`)
      assert.match(refused.err, /^"cause labels must be slugs of 2 to 64 lowercase letters, digits and hyphens/m)
    }
  })

  it('refuses the same label twice on one item, which is the rule that was already there', async () => {
    must(await cli(['file', 'task', 'A repeated label', '--id', 'repeat-label']), 'file')
    const refused = await cli(['set', 'repeat-label', 'labels=ux,ux'])
    assert.equal(refused.code, 2)
    assert.match(refused.err, /labels must be unique within one item/)
  })
})

describe('STR-3: the backlog searches titles by their words', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'story', 'Refresh the access token on a 401', '--id', 'auth-refresh', '--desc', 'the token refresh flow']), 'file')
    must(await cli(['file', 'task', 'Rotate the signing key', '--id', 'key-rotate']), 'file')
    must(await cli(['file', 'bug', 'Checkout drops the second order', '--id', 'checkout-500',
      '--set', 'severity=S2', '--set', 'found_in=production', '--set', 'repro_steps=add two, pay']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('matches every word of the value anywhere in the title', async () => {
    const found = must(await cli(['backlog', '--title', 'access token']), 'title search')
    assert.match(found.out, /^auth-refresh /m)
    assert.doesNotMatch(found.out, /^key-rotate /m)
  })

  it('folds case on both sides', async () => {
    const found = must(await cli(['backlog', '--title', 'CHECKOUT']), 'folded')
    assert.match(found.out, /^checkout-500 /m)
  })

  it('is order independent, so the same two words the other way round find the same row', async () => {
    const forward = must(await cli(['backlog', '--title', 'access token']), 'forward')
    const backward = must(await cli(['backlog', '--title', 'token access']), 'backward')
    assert.match(backward.out, /^auth-refresh /m)
    assert.equal(forward.out.includes('~items 1 1'), backward.out.includes('~items 1 1'))
  })

  it('searches the title and not the description, so every row on the page shows why it matched', async () => {
    // `auth-refresh` carries "the token refresh flow" as its description and "Refresh the
    // access token on a 401" as its title, so a description search would find it on "flow"
    // and the backlog has no column that would say so.
    const none = must(await cli(['backlog', '--title', 'flow']), 'description not searched')
    assert.match(none.out, /^none searched 3 matched 0$/m)
  })

  it('is one conjunction with every other clause, and the filter line names both', async () => {
    const found = must(await cli(['backlog', '--title', 'the', '--type', 'bug']), 'two clauses')
    assert.match(found.out, /^filter state open title the type bug$/m)
    assert.match(found.out, /^checkout-500 /m)
    assert.doesNotMatch(found.out, /^auth-refresh /m)
  })

  it('names the title an item does carry under --explain-absence', async () => {
    const absent = must(await cli(['backlog', '--title', 'access', '--explain-absence', 'key-rotate']), 'absence')
    assert.match(absent.out, /^clause title want access got Rotate the signing key$/m)
  })

  it('refuses a value with no word in it, which would otherwise select everything', async () => {
    for (const value of ['', '   ', '\u00a0']) {
      const refused = await cli(['backlog', `--title=${value}`])
      assert.equal(refused.code, 2, `${JSON.stringify(value)} was accepted`)
      assert.match(refused.err, /^"cause --title searches titles for the words it is given, and this value has none$/m)
    }
    // A tab is refused one rule earlier, because no title can hold one: the delimiter guard
    // runs first and its sentence is the true one.
    const tabbed = await cli(['backlog', '--title=\t'])
    assert.equal(tabbed.code, 2)
    assert.match(tabbed.err, /^"cause --title carries U\+0009 at character 1/m)
  })

  it('refuses a value longer than any title could be', async () => {
    const huge = await cli(['backlog', '--title', 'a'.repeat(MAX_LINE + 1)])
    assert.equal(huge.code, 2)
    assert.match(huge.err, /^"cause --title is 201 characters and no field of a record holds more than 200/m)
  })

  it('treats a regular-expression metacharacter as text, not as a pattern', async () => {
    const none = must(await cli(['backlog', '--title', '.*']), 'metacharacters')
    assert.match(none.out, /^none searched 3 matched 0$/m)
  })

  it('takes the same flag beside a column selector', async () => {
    const found = must(await cli(['backlog', '--title', 'checkout', '--fields', 'id,title']), 'backlog --title')
    assert.match(found.out, /^checkout-500 /m)
  })

  it('states the rule in help rather than leaving a caller to discover it', async () => {
    const help = must(await cli(['help', 'backlog']), 'help backlog')
    assert.match(help.out, /--title <words>/)
    assert.match(help.out, /every word, case folded, anywhere in the title and in any order; descriptions are not searched/)
  })
})

describe('STR-6: a mis-filed record is removed and its trail is not', () => {
  let root: string
  let cli: Cli
  before(async () => {
    ({ root, cli } = await aWorkspace())
    must(await cli(['file', 'task', 'Move the sign-in call to action', '--id', 'login-cta']), 'file')
    must(await cli(['file', 'task', 'Move the sign-in call to action', '--id', 'login-cta-2', '--label', 'ux']), 'file')
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('refuses without a reason, and without the confirmation, before it writes anything', async () => {
    const bare = await cli(['remove', 'login-cta-2'])
    assert.equal(bare.code, 2)
    assert.match(bare.err, /^"cause a removal records why the record should not exist, and none was given$/m)
    const unconfirmed = await cli(['remove', 'login-cta-2', '--reason', 'filed twice'])
    assert.equal(unconfirmed.code, 2)
    assert.match(unconfirmed.err, /takes the record out of .* and no command puts it back/)
    assert.match(unconfirmed.err, /^fix treadle remove login-cta-2 --reason "<why>" --yes$/m)
    must(await cli(['show', 'login-cta-2']), 'the record is still there')
  })

  it('refuses a reason of whitespace, and one over the reason bound', async () => {
    const blank = await cli(['remove', 'login-cta-2', '--reason', '   ', '--yes'])
    assert.equal(blank.code, 2)
    assert.match(blank.err, /records why the record should not exist/)
    const long = await cli(['remove', 'login-cta-2', '--reason', 'x'.repeat(MAX_REASON + 1), '--yes'])
    assert.equal(long.code, 2)
    assert.match(long.err, /^rule T7$/m)
  })

  it('answers a dry run with what would go, and writes nothing', async () => {
    const dry = must(await cli(['remove', 'login-cta-2', '--reason', 'filed twice', '--dry-run']), 'dry run')
    assert.match(dry.out, /^dry_run 1$/m)
    assert.match(dry.out, /^would_exit 0$/m)
    assert.match(dry.out, /^"set labels ux -> -$/m)
    must(await cli(['show', 'login-cta-2']), 'a dry run wrote nothing')
  })

  it('takes the record out, and reports the audited fields it carried', async () => {
    const removed = must(await cli(['remove', 'login-cta-2', '--reason', 'filed twice by the same import', '--yes']), 'remove')
    assert.match(removed.out, /^item login-cta-2$/m)
    assert.match(removed.out, /^"set state draft -> -$/m)
    assert.match(removed.out, /^event \S+$/m)
    const gone = await cli(['show', 'login-cta-2'])
    assert.equal(gone.code, 5)
    const listed = must(await cli(['backlog']), 'backlog')
    assert.doesNotMatch(listed.out, /^login-cta-2 /m)
  })

  it('keeps every event the record earned, and answers history from the log alone', async () => {
    const log = must(await cli(['history', 'login-cta-2']), 'history after removal')
    assert.match(log.out, /^note no record here carries this id now; these are the events it earned while it did$/m)
    assert.match(log.out, /^\S+ human item\.remove type=task,state=draft,/m)
    assert.match(log.out, /^\S+ human item\.file type=task,state=draft,/m)
    assert.match(log.out, /^\S+ item\.remove filed twice by the same import$/m)
  })

  it('leaves the store clean, because nothing was left naming the record', async () => {
    const audit = must(await cli(['doctor']), 'doctor')
    assert.match(audit.out, /^~findings 0 0$/m)
  })

  it('still refuses an id that names nothing at all', async () => {
    const missing = await cli(['remove', 'no-such-item', '--reason', 'a typo', '--yes'])
    assert.equal(missing.code, 5)
    assert.match(missing.err, /is in no record here/)
  })

  it('refuses a record another record names through a relation, and names the edge', async () => {
    must(await cli(['file', 'task', 'A blocker', '--id', 'a-blocker']), 'file')
    must(await cli(['relation', 'add', 'a-blocker', 'blocks', 'login-cta']), 'relation add')
    const refused = await cli(['remove', 'login-cta', '--reason', 'mis-filed', '--yes'])
    assert.equal(refused.code, 3)
    assert.match(refused.err, /^rule R6$/m)
    assert.match(refused.err, /^"cause a-blocker blocks login-cta, and removing login-cta would leave that edge naming no record$/m)
    assert.match(refused.err, /^fix treadle relation remove a-blocker blocks login-cta$/m)
  })

  it('takes it once the edge is gone, which is what the refusal offered', async () => {
    must(await cli(['relation', 'remove', 'a-blocker', 'blocks', 'login-cta']), 'relation remove')
    must(await cli(['remove', 'login-cta', '--reason', 'mis-filed', '--yes']), 'remove after unlink')
  })

  it('refuses a record a child names as its parent, and names the child', async () => {
    must(await cli(['file', 'epic', 'An epic', '--id', 'an-epic', '--set', 'outcome=a shipped thing']), 'file epic')
    must(await cli(['file', 'story', 'A child story', '--id', 'a-child', '--parent', 'an-epic']), 'file child')
    const refused = await cli(['remove', 'an-epic', '--reason', 'mis-filed', '--yes'])
    assert.equal(refused.code, 3)
    assert.match(refused.err, /^rule R6$/m)
    assert.match(refused.err, /^"cause a-child has an-epic as its parent, and removing an-epic would leave that record naming no parent$/m)
    assert.match(refused.err, /^fix treadle set a-child parent_id=$/m)
  })

  it('says what stopped being blocked, rather than changing it in silence', async () => {
    must(await cli(['file', 'task', 'A blocking task', '--id', 'blocking-task']), 'file')
    must(await cli(['file', 'task', 'A held task', '--id', 'held-task']), 'file')
    must(await cli(['relation', 'add', 'blocking-task', 'blocks', 'held-task']), 'relation add')
    const removed = must(await cli(['remove', 'blocking-task', '--reason', 'filed against the wrong project', '--yes']), 'remove')
    assert.match(removed.out, /^note held-task is no longer blocked by it$/m)
    const audit = must(await cli(['doctor']), 'doctor')
    assert.match(audit.out, /^~findings 0 0$/m)
  })

  it('removes a done item nothing depends on, because a state is not what a record names', async () => {
    must(await cli(['file', 'task', 'A done task nothing names', '--id', 'lone-done']), 'file')
    for (const target of ['ready', 'in_progress', 'done']) {
      must(await cli(['transition', 'lone-done', target]), `transition ${target}`)
    }
    must(await cli(['remove', 'lone-done', '--reason', 'filed against the wrong project', '--yes']), 'remove a done item')
    const audit = must(await cli(['doctor']), 'doctor')
    assert.match(audit.out, /^~findings 0 0$/m)
  })

  it('refuses the same removal twice, because the second names no record', async () => {
    const again = await cli(['remove', 'lone-done', '--reason', 'again', '--yes'])
    assert.equal(again.code, 5)
    assert.match(again.err, /is in no record here/)
  })

  it('takes one id and refuses a line that names none', async () => {
    const none = await cli(['remove'])
    assert.equal(none.code, 2)
    assert.match(none.err, /^"cause remove needs the id of one item$/m)
  })

  it('refuses a second id rather than removing the first and dropping the rest', async () => {
    // Every other single-entity command drops an operand past the first, and here that cost a
    // record: found by attacking the command, `remove a b` removed `a`, exited 0, and left
    // `b` filed with no line saying so.
    must(await cli(['file', 'task', 'One of two', '--id', 'one-of-two']), 'file')
    must(await cli(['file', 'task', 'Two of two', '--id', 'two-of-two']), 'file')
    const both = await cli(['remove', 'one-of-two', 'two-of-two', '--reason', 'both', '--yes'])
    assert.equal(both.code, 2)
    assert.match(both.err, /^"cause remove takes one id and this line names 2; a removal is confirmed one record at a time$/m)
    assert.match(both.err, /^fix treadle remove <id> --reason "<why>" --yes$/m)
    must(await cli(['show', 'one-of-two']), 'the first record is still there')
    must(await cli(['show', 'two-of-two']), 'and so is the second')
  })

  it('names the command, its flags and the transition it is not, in help', async () => {
    const help = must(await cli(['help', 'remove']), 'help remove')
    assert.match(help.out, /treadle remove <id> --reason <text> --yes/)
    assert.match(help.out, /work that really stopped is transition <id> cancelled instead, which keeps the record/)
  })

})
