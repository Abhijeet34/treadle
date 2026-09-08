// SPDX-License-Identifier: Apache-2.0
// The command line refuses what it cannot mean, and the tool describes itself truthfully.
//
// Eight defects, each measured by driving the tool rather than by reading it. The largest was
// silent: twelve of the eighteen commands read the operand indices they wanted and dropped
// every one after, at exit 0. `backlog ready`, written for `backlog --state ready`, listed
// every item; `show <id> desc`, written for `--field desc`, printed the whole record; and
// `transition <id> ready extra` moved the item and said nothing about the word it threw away.
// `set` and `remove` refused the same shape, so the rule existed and reached two commands.
//
// The sweep below is written against the inventory: one line per command, sitting exactly at
// the bound its own usage publishes, and the same line with one operand more. A command added
// without a row here fails the first test by name, so the bound cannot be published for
// seventeen commands and forgotten for the eighteenth.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before, after } from 'node:test'

import { EXIT_OF } from '../../src/cli/exit.ts'
import { COMMANDS } from '../../src/cli/inventory.ts'
import { operandLimit } from '../../src/cli/operands.ts'
import { topLevelHelp } from '../../src/cli/help.ts'
import { runCli } from '../helpers/cli-run.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENV = { TREADLE_ACTOR: 'dana' } as const

type Run = { code: number; out: string; err: string }
type Cli = (argv: readonly string[]) => Promise<Run>

function must(run: Run, what: string): Run {
  assert.equal(run.code, 0, `${what}: ${run.err}`)
  return run
}

async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-line-'))
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: root, env: ENV })
  must(await cli(['init', '--name', 'truthful']), 'init')
  must(await cli(['file', 'task', 'A record to name', '--id', 'a-record']), 'file')
  must(await cli(['file', 'task', 'Another record', '--id', 'other-record']), 'file')
  must(await cli(['transition', 'a-record', 'ready']), 'transition')
  return { root, cli }
}

/**
 * One line per command, carrying exactly as many operands as its own usage publishes. The
 * first test holds each row against `operandLimit`, so a row that drifts from the usage it
 * was written for fails there rather than silently testing one operand short.
 */
const AT_THE_BOUND: Readonly<Record<string, readonly string[]>> = {
  init: [],
  file: ['task', 'A title'],
  show: ['a-record'],
  backlog: [],
  transition: ['a-record', 'in_progress'],
  mark: ['a-record'],
  evidence: ['add', 'a-record', 'run', '8813', 'a label'],
  relation: ['add', 'a-record', 'blocks', 'other-record'],
  config: ['set', 'aging_days', '7'],
  doctor: [],
  next: [],
  explain: ['a-record'],
  history: ['a-record'],
  status: [],
  help: ['version'],
  version: [],
  // The two the sweep does not drive, each for a reason its own test holds below. `set` takes
  // any number of assignments, and `remove` refuses a second id with a sentence about what a
  // dropped one would cost, which a count cannot say.
  set: ['a-record', 'title=x'],
  remove: ['a-record'],
}

/** Every command whose extra operand the general bound answers, which is sixteen of eighteen. */
const SWEPT = COMMANDS.map((command) => command.name).filter((name) => name !== 'set' && name !== 'remove')

describe('an operand past the last one a command publishes is refused', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('has a line for every command in the inventory, each sitting on its own bound', () => {
    const wrong: string[] = []
    for (const command of COMMANDS) {
      const operands = AT_THE_BOUND[command.name]
      if (operands === undefined) {
        wrong.push(`${command.name}: no line is written for it`)
        continue
      }
      const limit = operandLimit(command, operands)
      // `set` alone publishes a repeating slot, and an unbounded line has no bound to sit on.
      if (command.name === 'set') {
        assert.equal(limit, undefined, 'set is the one command that takes any number of operands')
        continue
      }
      if (limit !== operands.length) wrong.push(`${command.name}: ${operands.length} operands against a bound of ${String(limit)}`)
    }
    assert.deepEqual(wrong, [], 'a line here no longer matches the usage the inventory publishes')
  })

  for (const name of SWEPT) {
    it(`refuses one operand past ${name}'s bound, and answers nothing`, async () => {
      const operands = AT_THE_BOUND[name] as readonly string[]
      const run = await cli([name, ...operands, 'one-too-many'])
      assert.equal(run.code, EXIT_OF.VALIDATION, `exited ${run.code}: ${run.err}${run.out}`)
      assert.equal(run.out, '', 'the command answered as well as refusing')
      assert.match(run.err, /^err VALIDATION /, run.err)
      assert.match(run.err, /^rule C1$/m, run.err)
      assert.match(
        run.err,
        new RegExp(`^"cause ${name} takes (no|one|two|three|four|five) operands? and this line writes ${operands.length + 1}, so operand ${operands.length + 1} would be read by nothing$`, 'm'),
        run.err,
      )
      assert.match(run.err, new RegExp(`^fix treadle help ${name}$`, 'm'), run.err)
      // The operand is a caller's own word and no slot of the usage holds it, so nothing has
      // held it to a line: the count is the whole of the answer and the word never reaches
      // the stream. This is `operandRefusal`'s rule at one more position.
      assert.equal(run.err.includes('one-too-many'), false, 'the refusal echoed the operand it refused')
    })
  }

  it('lists the backlog for the caller who wrote a state as an operand, and does not', async () => {
    const refused = await cli(['backlog', 'ready'])
    assert.equal(refused.code, EXIT_OF.VALIDATION, refused.err)
    assert.equal(refused.out, '', 'every item was listed for a line that named a filter wrong')
    // The line the caller meant, which is what the help page the fix names publishes.
    const meant = must(await cli(['backlog', '--state', 'ready']), 'backlog --state')
    assert.match(meant.out, /^~items 1 1$/m, meant.out)
  })

  it('writes nothing when a mutating line carries one operand too many', async () => {
    const before = must(await cli(['show', 'a-record']), 'show')
    assert.match(before.out, /^state ready$/m, before.out)

    const refused = await cli(['transition', 'a-record', 'in_progress', 'extra'])
    assert.equal(refused.code, EXIT_OF.VALIDATION, refused.err)
    assert.equal(refused.out, '', 'a refused line still printed a transition')

    const after = must(await cli(['show', 'a-record']), 'show again')
    assert.match(after.out, /^state ready$/m, 'the item moved on a line that was refused')
    assert.match(after.out, /^v 2$/m, 'the version moved on a line that was refused')
  })

  it('leaves a verb no usage line carries to the command, which names the verb', async () => {
    // A count past a verb the caller never reached answers about an operand they have not
    // written yet, so the bound stands aside and the command refuses on its own word.
    const evidence = await cli(['evidence', 'list', 'a-record', 'run', '8813'])
    assert.equal(evidence.code, EXIT_OF.VALIDATION, evidence.err)
    assert.match(evidence.err, /^"cause evidence takes one subcommand, add, not list$/m, evidence.err)

    const config = await cli(['config', 'aging_days'])
    assert.equal(config.code, EXIT_OF.VALIDATION, config.err)
    assert.match(config.err, /^"cause config takes no verb to read and set to write/m, config.err)
  })

  it('keeps the two sentences the commands that already refused this shape wrote', async () => {
    const removal = await cli(['remove', 'a-record', 'other-record'])
    assert.equal(removal.code, EXIT_OF.VALIDATION, removal.err)
    assert.match(removal.err, /^"cause remove takes one id and this line names 2; a removal is confirmed one record at a time$/m, removal.err)

    // `set` takes any number of assignments, so a word that is not one is refused by what it
    // is rather than by where it sits.
    const assignment = await cli(['set', 'a-record', 'title=A new title', 'extra'])
    assert.equal(assignment.code, EXIT_OF.VALIDATION, assignment.err)
    assert.match(assignment.err, /extra is not a field=value assignment/, assignment.err)
  })
})

describe('file takes one title, and the line it confirms is the line it stored', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('refuses a title operand and --set title= that disagree, and files nothing', async () => {
    const refused = await cli(['file', 'task', 'Title A', '--set', 'title=Title B', '--id', 'two-titles'])
    assert.equal(refused.code, EXIT_OF.VALIDATION, refused.err)
    assert.equal(refused.out, '', 'the item was filed as well as refused')
    assert.match(refused.err, /^rule C1$/m, refused.err)
    assert.match(refused.err, /^"cause the title operand and --set title= both set title, and a field is set once on one line$/m, refused.err)

    const absent = await cli(['show', 'two-titles'])
    assert.equal(absent.code, EXIT_OF.NOT_FOUND, 'the refused line filed a record')
  })

  it('refuses it the same way the flags were already refused, which is the rule it was missing', async () => {
    const flagged = await cli(['file', 'task', 'A title', '--id', 'two-assignees', '--assignee', 'kim', '--set', 'assignee=bob'])
    assert.equal(flagged.code, EXIT_OF.VALIDATION, flagged.err)
    assert.match(flagged.err, /^"cause --assignee and --set assignee= both set assignee, and a field is set once on one line$/m, flagged.err)
  })

  it('confirms the title it stored, on every line that carries one', async () => {
    const filed = must(await cli(['file', 'task', 'One title only', '--id', 'one-title']), 'file')
    assert.match(filed.out, /^"title One title only$/m, filed.out)
    const shown = must(await cli(['show', 'one-title', '--field', 'title']), 'show --field title')
    assert.match(shown.out, /^"title One title only$/m, 'the confirmation and the record disagree')
  })

  it('takes both spellings of the one title, because they name one value', async () => {
    const agreed = must(await cli(['file', 'task', 'Agreed', '--set', 'title=Agreed', '--id', 'agreed-title']), 'file')
    assert.match(agreed.out, /^"title Agreed$/m, agreed.out)
  })
})

describe('a value this line cannot mean is refused wherever the line writes it', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // `next --for ""` armed the assignee weight for a name no record carries and printed
  // `asg 8` over it, while `--actor ""` was refused by the actor rule. One rule, asked
  // wherever a line names an actor.
  for (const [what, value] of [['empty', ''], ['blank', '  ']] as const) {
    it(`refuses a ${what} --for with the sentence --actor is refused with`, async () => {
      const run = await cli(['next', '--for', value])
      assert.equal(run.code, EXIT_OF.VALIDATION, `exited ${run.code}: ${run.err}${run.out}`)
      assert.equal(run.out, '', 'the ranking was printed for a name no record carries')
      assert.match(run.err, /^"cause an actor must be a name with no leading or trailing whitespace$/m, run.err)

      const actor = await cli(['--actor', value, 'set', 'a-record', 'assignee=kim'])
      assert.match(actor.err, /^"cause an actor must be a name with no leading or trailing whitespace$/m, actor.err)
    })
  }

  it('still weights a ranking for an actor a record carries', async () => {
    must(await cli(['set', 'a-record', 'assignee=kim']), 'set assignee')
    const ranked = must(await cli(['next', '--for', 'kim']), 'next --for')
    assert.match(ranked.out, /^weights .*asg 8/m, ranked.out)
  })

  it('refuses a field this line assigns twice, rather than keeping the last', async () => {
    const run = await cli(['set', 'other-record', 'assignee=kim', 'assignee=bob'])
    assert.equal(run.code, EXIT_OF.VALIDATION, `exited ${run.code}: ${run.err}${run.out}`)
    assert.equal(run.out, '', 'one of the two values was written')
    assert.match(run.err, /^"cause assignee is assigned more than once on this line and the last would silently replace the first$/m, run.err)

    const shown = must(await cli(['show', 'other-record']), 'show')
    assert.doesNotMatch(shown.out, /^"assignee /m, 'the refused line wrote an assignee')
  })

  it('reads both spellings of one field as the one field they name', async () => {
    const run = await cli(['set', 'other-record', 'desc=first', 'description=second'])
    assert.equal(run.code, EXIT_OF.VALIDATION, `exited ${run.code}: ${run.err}${run.out}`)
    assert.match(run.err, /^"cause description is assigned more than once on this line/m, run.err)
  })

  it('names what a dash-led operand is, rather than sending the caller to a flag list', async () => {
    const run = await cli(['config', 'set', 'aging_days', '-1'])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.err)
    assert.match(run.err, /^"cause -1 was read as a flag of config, and an operand beginning with a dash is written after --$/m, run.err)

    // The line that sentence names, and the refusal it earns, which is about the value.
    const written = await cli(['config', 'set', 'aging_days', '--', '-1'])
    assert.equal(written.code, EXIT_OF.VALIDATION, written.err)
    assert.match(written.err, /^rule V8$/m, written.err)
    assert.match(written.err, /^entity aging_days$/m, written.err)
    assert.match(written.err, /it is a whole number of days/, written.err)
  })

  it('leaves a flag whose name is not a number saying what it always said', async () => {
    const run = await cli(['backlog', '--nope'])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.err)
    assert.match(run.err, /^"cause --nope is not a flag of backlog$/m, run.err)
  })

  it('names a multi-digit or non-integer dash-led operand whole, not the letter a cluster split it into', async () => {
    const multiDigit = await cli(['config', 'set', 'aging_days', '-100'])
    assert.equal(multiDigit.code, EXIT_OF.VALIDATION, multiDigit.err)
    assert.match(multiDigit.err, /^"cause -100 was read as a flag of config, and an operand beginning with a dash is written after --$/m, multiDigit.err)

    const decimal = await cli(['config', 'set', 'aging_days', '-0.5'])
    assert.equal(decimal.code, EXIT_OF.VALIDATION, decimal.err)
    assert.match(decimal.err, /^"cause -0\.5 was read as a flag of config, and an operand beginning with a dash is written after --$/m, decimal.err)
  })

  it('still names the flag, not the dash-led value, when a flag needing a value is written first', async () => {
    const run = await cli(['backlog', '--priority', '-1'])
    assert.equal(run.code, EXIT_OF.VALIDATION, run.err)
    assert.match(run.err, /^"cause --priority needs a value, and one starting with a dash is written --priority=-1$/m, run.err)
  })
})

describe('the first sentence the tool says about itself', () => {
  it('is the sentence the README opens with, and not the category the README denies', async () => {
    const about = topLevelHelp('-').data['about']
    const readme = (await readFile(path.join(ROOT, 'README.md'), 'utf8')).split('\n')
    assert.equal(about, readme[2],
      'treadle help and README.md say different things about what this tool is')
    assert.match(readme[8] ?? '', /It is not a Rally and not a Kanban board/,
      'the README line this pins against has moved; re-read both before changing either')
  })

  it('says it on the page a stranger reads first, in the rendering an agent reads', async () => {
    const run = await runCli(['help'], { env: ENV })
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /^"about The record of the work between people and agents, over files you commit to git\.$/m, run.out)
  })
})
