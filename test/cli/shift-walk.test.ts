// SPDX-License-Identifier: Apache-2.0
// One agent's shift, walked end to end, with the record asserted at every point the agent
// has to decide what to do next.
//
// Every other suite here proves a part. This one proves the sequence, which is the thing
// that kept breaking while every part was green: three defects were found by hand after
// thirteen merges had each passed the whole pipeline individually, and the audit that found
// them cost hours and expired the moment the next branch landed. The gap is not coverage of
// a command, it is that nobody had run `file -> groom -> block -> hold -> submit -> reject ->
// fix -> accept -> remove` in one order over one store and read what the tool said at each
// step.
//
// It is deliberately not `runnable-lines.test.ts`. That file provokes one state per emitted
// line and runs the line against a fresh copy; the state never advances and no step depends
// on the one before it. Here the workspace is the same one throughout, so a step reads what
// its predecessor wrote, which is what an agent's shift actually is.
//
// WHAT AN ASSERTION IS ALLOWED TO BE. A step names the command, the exit it expects, and the
// facts about the record that must hold after it. It never asserts a byte count, a timing or
// a rendering: those belong to `budget.test.ts` and the snapshot. A refusal step also asserts
// the rule id and that the refusal carried at least one `fix` line, because a refusal an
// agent cannot act on is the failure this whole surface exists to prevent.
//
// TWO STEPS CHARACTERISE A GAP RATHER THAN A GUARANTEE, and both say so in their names. The
// `DOD3` pair asserts that the actor half refuses a self-accept when an assignee is named and
// does not when none ever was, because `workedBy` is folded from the assignee the log
// recorded and an unassigned record leaves it empty. That is the boundary as it stands today.
// Closing it turns these two red together, which is the point: the next change to that rule
// is told what it moved.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { runCli } from '../helpers/cli-run.ts'

const WORKER = { TREADLE_ACTOR: 'worker', TREADLE_ACTOR_KIND: 'agent' }

type Answer = {
  readonly code: number
  /** Both streams joined: an answer goes to stdout and a refusal to stderr. */
  readonly out: string
  /** Line 1 split on spaces: `ok <command> ...` or `err <CODE> <workspace>`. */
  readonly envelope: readonly string[]
  /** Every `<key> <value>` and `"<key> <value>` line, last one wins, the quote dropped. */
  readonly scalars: ReadonlyMap<string, string>
  /** Every `fix` line in order, which a scalar map would collapse to one. */
  readonly fixes: readonly string[]
}

/**
 * The `agent/1` line grammar, read only as far as this file asserts about it: the envelope,
 * the scalars and the repeated `fix` key. Block rows are left alone deliberately - a step
 * that wants one reads `out` - so that this stays a reader and does not become a second
 * renderer with its own opinions.
 */
function parse(code: number, out: string): Answer {
  const lines = out.split('\n').filter((line) => line.length > 0)
  const scalars = new Map<string, string>()
  const fixes: string[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith('~') || line.startsWith('#') || line.startsWith('+')) continue
    const body = line.startsWith('"') ? line.slice(1) : line
    const at = body.indexOf(' ')
    if (at < 0) continue
    const key = body.slice(0, at)
    const value = body.slice(at + 1)
    if (key === 'fix') fixes.push(value)
    else scalars.set(key, value)
  }
  return { code, out, envelope: (lines[0] ?? '').split(' '), scalars, fixes }
}

/** Steps taken and assertions made, so the run reports what it examined rather than a green. */
const tally = { steps: 0, assertions: 0, calls: 0, bytes: 0, refusals: 0 }

describe('one agent shift, walked in order', () => {
  let cwd = ''

  const call = async (...argv: readonly string[]): Promise<Answer> => {
    const run = await runCli(argv, { cwd, env: WORKER })
    tally.calls += 1
    tally.bytes += run.out.length + run.err.length
    return parse(run.code, `${run.out}${run.err}`)
  }

  /**
   * One step of the shift. `expect` is the exit the agent is entitled to, and `then` holds the
   * facts about the record that must be true once the step has run. The counter moves here so
   * a step that stops asserting is visible in the diagnostic rather than silently cheaper.
   */
  const step = async (
    what: string,
    argv: readonly string[],
    expect: number,
    then?: (answer: Answer) => void,
  ): Promise<Answer> => {
    const answer = await call(...argv)
    tally.steps += 1
    assert.equal(answer.code, expect, `${what}: expected exit ${expect}, got ${answer.code}\n${answer.out}`)
    tally.assertions += 1
    if (expect === 0) {
      assert.equal(answer.envelope[0], 'ok', `${what}: exit 0 with an err envelope\n${answer.out}`)
    } else {
      tally.refusals += 1
      assert.equal(answer.envelope[0], 'err', `${what}: exit ${expect} with an ok envelope\n${answer.out}`)
      assert.ok(answer.scalars.has('cause'), `${what}: a refusal states no cause\n${answer.out}`)
      assert.ok(answer.fixes.length > 0, `${what}: a refusal carries no fix line\n${answer.out}`)
      tally.assertions += 2
    }
    tally.assertions += 1
    then?.(answer)
    return answer
  }

  /** The state one record holds now, read back through the surface an agent would read it on. */
  const stateOf = async (id: string): Promise<string> => {
    const answer = await call('show', id)
    assert.equal(answer.code, 0, `show ${id} refused\n${answer.out}`)
    return answer.scalars.get('state') ?? '(none)'
  }

  const holds = async (what: string, id: string, state: string): Promise<void> => {
    assert.equal(await stateOf(id), state, `${what}: ${id} is not ${state}`)
    tally.assertions += 1
  }

  before(async () => { cwd = await mkdtemp(path.join(tmpdir(), 'treadle-shift-')) })
  after(async () => { await rm(cwd, { recursive: true, force: true }) })

  it('refuses every command before the workspace exists, and names the one that creates it', async () => {
    const answer = await step('status with no workspace', ['status'], 6)
    assert.equal(answer.scalars.get('rule'), 'S1')
    assert.ok(answer.fixes.includes('treadle init'), `S1 did not name init: ${answer.fixes.join(' | ')}`)
    tally.assertions += 2
    await step('the fix line S1 printed', ['init'], 0)
  })

  it('files one item of every type the tool has', async () => {
    await step('an epic', ['file', 'epic', 'Token refresh hardening', '--id', 'hardening',
      '--set', 'outcome=a 401 never reaches the user'], 0)
    await step('a story under it', ['file', 'story', 'Refresh the token on a 401', '--id', 'refresh',
      '--parent', 'hardening', '--set', 'acceptance_criteria=a 401 refreshes once'], 0)
    await step('a task under it', ['file', 'task', 'Rotate the signing key', '--id', 'rotate',
      '--parent', 'hardening'], 0)
    await step('a bug', ['file', 'bug', 'Checkout charges twice', '--id', 'double',
      '--set', 'severity=S2', '--set', 'repro_steps=add, pay, retry', '--set', 'found_in=production'], 0)
    await step('a spike', ['file', 'spike', 'Which refresh window the IdP allows', '--id', 'window',
      '--set', 'question=what is the shortest window'], 0)
    await step('an impediment', ['file', 'impediment', 'Staging certificate expired', '--id', 'cert',
      '--set', 'severity=S1', '--set', 'proposed_resolution=platform renews it'], 0)

    const backlog = await step('the backlog an agent reads next', ['backlog'], 0)
    assert.match(backlog.out, /^~items 6 6$/m, `six items were filed, backlog shows:\n${backlog.out}`)
    tally.assertions += 1
  })

  it('blocks one item on an impediment, and the refusal walks to the state that clears it', async () => {
    await step('raise the impediment against the task', ['relation', 'add', 'cert', 'blocks', 'rotate'], 0)

    // The remedy names the next move from where the blocker stands, never the destination, so
    // an agent following fix lines walks the blocker to done one state at a time. Asserting
    // the walk rather than one refusal is what proves the chain terminates: a remedy that
    // names the state the blocker is already in loops here instead of passing.
    const walked: string[] = []
    for (let hop = 0; hop < 6; hop += 1) {
      const refused = await call('transition', 'rotate', 'ready')
      if (refused.code === 0) break
      tally.steps += 1
      assert.equal(refused.code, 3, `hop ${hop}: expected a guard refusal\n${refused.out}`)
      assert.equal(refused.scalars.get('rule'), 'G1')
      assert.match(refused.scalars.get('cause') ?? '', /DOR3/)
      tally.refusals += 1
      tally.assertions += 3
      const next = refused.fixes.find((line) => line.startsWith('treadle transition cert '))
      assert.ok(next !== undefined, `hop ${hop}: no fix line moves the blocker\n${refused.out}`)
      assert.ok(!walked.includes(next), `hop ${hop}: the remedy repeated itself: ${next}`)
      walked.push(next)
      tally.assertions += 2
      const applied = await call(...next.split(' ').slice(1))
      assert.equal(applied.code, 0, `hop ${hop}: the printed fix line was refused\n${applied.out}`)
      tally.assertions += 1
    }
    assert.deepEqual(walked, [
      'treadle transition cert ready',
      'treadle transition cert in_progress',
      'treadle transition cert done',
    ])
    tally.assertions += 1
    await holds('the blocker is resolved by reaching done', 'cert', 'done')
    await holds('the task it blocked is groomable again', 'rotate', 'ready')
  })

  it('never ranks the container, and says which clause excluded it', async () => {
    await step('groom the epic', ['transition', 'hardening', 'ready'], 0)
    await step('groom the story', ['transition', 'refresh', 'ready'], 0)
    const ranked = await step('the dispatch read', ['next'], 0)
    assert.doesNotMatch(ranked.out, /^hardening /m, `a container was ranked:\n${ranked.out}`)
    tally.assertions += 1
    const absence = await step('why the epic is absent', ['next', '--explain-absence', 'hardening'], 0)
    assert.match(absence.scalars.get('clause') ?? '', /^type epic/, 'the clause named is not the type')
    tally.assertions += 1
  })

  it('holds one item with a reason and an expiry, and resumes it to the state it was held from', async () => {
    await step('start the task', ['transition', 'rotate', 'in_progress'], 0)
    await step('hold it', ['transition', 'rotate', 'on_hold',
      '--reason', 'the platform window is shut', '--until', '2030-01-01T00:00:00Z'], 0)
    const held = await call('show', 'rotate')
    assert.equal(held.scalars.get('held_from'), 'in_progress', `held_from was not recorded\n${held.out}`)
    tally.assertions += 1
    await step('resume it', ['transition', 'rotate', 'resume'], 0)
    await holds('a resume returns the item to where it was held from', 'rotate', 'in_progress')
  })

  it('hands one item to review, takes a rejection, fixes it and resubmits', async () => {
    await step('start the story', ['transition', 'refresh', 'in_progress'], 0)
    await step('submit it', ['transition', 'refresh', 'in_review'], 0)
    await step('the reviewer rejects it', ['transition', 'refresh', 'in_progress',
      '--reason', 'the retry has no cap'], 0)
    await holds('a rejection returns the item to the worker', 'refresh', 'in_progress')
    await step('the worker ticks the criterion', ['set', 'refresh',
      'acceptance_criteria=[x] a 401 refreshes once'], 0)
    await step('resubmit', ['transition', 'refresh', 'in_review'], 0)
  })

  it('refuses an accept that names no reviewer and points at no evidence, and each fix line lands', async () => {
    const refused = await step('accept with neither', ['transition', 'refresh', 'done'], 3)
    assert.equal(refused.scalars.get('rule'), 'G6')
    assert.match(refused.scalars.get('cause') ?? '', /DOD3/)
    assert.match(refused.scalars.get('cause') ?? '', /DOD7/)
    tally.assertions += 3
    await step('name a reviewer', ['set', 'refresh', 'reviewer=reviewer'], 0)
    await step('point at the evidence', ['evidence', 'add', 'refresh', 'pr',
      'https://example.test/pr/42', 'the refresh cap'], 0)
    await step('accept it', ['transition', 'refresh', 'done'], 0)
    await holds('the story is accepted', 'refresh', 'done')
    const shown = await call('show', 'refresh')
    assert.equal(shown.scalars.get('ac'), '1/1', `the criterion is not ticked\n${shown.out}`)
    assert.match(shown.out, /^~evidence 1 1$/m, `the evidence is not on the record\n${shown.out}`)
    tally.assertions += 2
  })

  it('refuses the self-accept when an assignee is named (DOD3 actor half, armed)', async () => {
    await step('file it', ['file', 'story', 'Assigned twin', '--id', 'twin-yes',
      '--set', 'acceptance_criteria=[x] it works'], 0)
    await step('assign it to the worker', ['set', 'twin-yes', 'assignee=worker'], 0)
    await step('name another reviewer', ['set', 'twin-yes', 'reviewer=reviewer'], 0)
    await step('point at evidence', ['evidence', 'add', 'twin-yes', 'pr', 'https://example.test/pr/1'], 0)
    await step('groom it', ['transition', 'twin-yes', 'ready'], 0)
    await step('start it', ['transition', 'twin-yes', 'in_progress'], 0)
    await step('submit it', ['transition', 'twin-yes', 'in_review'], 0)
    const refused = await step('the worker accepts its own work', ['transition', 'twin-yes', 'done'], 3)
    assert.equal(refused.scalars.get('rule'), 'G6')
    assert.match(refused.scalars.get('cause') ?? '', /DOD3/)
    assert.ok(
      refused.fixes.some((line) => line === 'treadle transition twin-yes done --actor reviewer'),
      `the refusal did not hand the accept to the reviewer it names: ${refused.fixes.join(' | ')}`,
    )
    tally.assertions += 3
    await step('the reviewer accepts it, as the refusal printed', ['transition', 'twin-yes', 'done',
      '--actor', 'reviewer'], 0)
  })

  it('does not refuse it when no assignee was ever named (DOD3 actor half, disarmed)', async () => {
    // Characterises a gap rather than a guarantee. `workedBy` is folded from the assignee the
    // log recorded while the item was in a worked state, so a record nothing ever assigned
    // leaves it empty and the actor half has no name to compare the caller against. The step
    // above and this one differ by exactly one command, `set twin-yes assignee=worker`.
    await step('file it', ['file', 'story', 'Unassigned twin', '--id', 'twin-no',
      '--set', 'acceptance_criteria=[x] it works'], 0)
    await step('name a reviewer, assign nobody', ['set', 'twin-no', 'reviewer=reviewer'], 0)
    await step('point at evidence', ['evidence', 'add', 'twin-no', 'pr', 'https://example.test/pr/2'], 0)
    await step('groom it', ['transition', 'twin-no', 'ready'], 0)
    await step('start it', ['transition', 'twin-no', 'in_progress'], 0)
    await step('submit it', ['transition', 'twin-no', 'in_review'], 0)
    await step('the actor that did every write accepts it', ['transition', 'twin-no', 'done'], 0)
    await holds('the unassigned record reached done under one actor', 'twin-no', 'done')
    const audit = await step('and the audit says nothing about it', ['doctor'], 0)
    assert.match(audit.out, /^~findings 0 0$/m, `the audit reports the launder after all:\n${audit.out}`)
    tally.assertions += 1
  })

  it('removes a mis-filed record, keeps its events, and tells a removal from a loss', async () => {
    const bare = await step('a removal with no reason', ['remove', 'window'], 2)
    assert.equal(bare.scalars.get('rule'), 'C1')
    tally.assertions += 1
    await step('the removal the refusal printed', ['remove', 'window',
      '--reason', 'the window is published, so there is nothing to investigate', '--yes'], 0)
    const gone = await step('the record is gone', ['show', 'window'], 5)
    assert.equal(gone.envelope[1], 'NOT_FOUND')
    tally.assertions += 1
    const kept = await step('its events are not', ['history', 'window'], 0)
    assert.match(kept.scalars.get('note') ?? '', /removed/, `history does not call it a removal\n${kept.out}`)
    assert.match(kept.out, /item\.remove/, `the removal itself is not in the log\n${kept.out}`)
    tally.assertions += 2
  })

  it('leaves a workspace the audit passes and the orientation call describes', async () => {
    const audit = await step('the audit', ['doctor'], 0)
    assert.match(audit.out, /^~findings 0 0$/m, `the shift left findings behind:\n${audit.out}`)
    tally.assertions += 1
    const orient = await step('the orientation call', ['status'], 0)
    assert.equal(orient.scalars.get('items'), '7', `seven records should remain\n${orient.out}`)
    assert.equal(orient.scalars.get('findings'), '0')
    assert.ok(!orient.scalars.has('writes'), `the store reports itself unwritable\n${orient.out}`)
    tally.assertions += 3
  })

  it('reports what it examined', (t) => {
    t.diagnostic(
      `shift walk: ${tally.steps} steps, ${tally.assertions} assertions, ` +
      `${tally.calls} CLI calls, ${tally.refusals} refusals asserted, ${tally.bytes} bytes read`,
    )
    // A floor, not a target. The walk passing over fewer steps than the shift has means a
    // block above stopped running, which a green suite would otherwise not show anybody.
    assert.ok(tally.steps >= 45, `the walk covered ${tally.steps} steps, which is fewer than the shift has`)
    assert.ok(tally.assertions >= 90, `the walk made ${tally.assertions} assertions`)
    assert.ok(tally.refusals >= 6, `the walk asserted ${tally.refusals} refusals`)
  })
})
