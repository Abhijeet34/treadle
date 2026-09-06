// SPDX-License-Identifier: Apache-2.0
// Every line this tool prints for the reader to run is run here, as printed, from the state
// that printed it.
//
// The same fault has shipped three times, and twice it was fixed one line at a time. A gate
// remedy said `transition <blocker> done`, which T1 refuses from four of the five states a
// blocker can be in. A `page` line dropped the filter, the limit and `--for` it was built
// under, so an agent following the cursor the tool handed it read a different list and never
// learned that it did. Six more fix lines were refused as printed: a dropped operand, a
// missing required flag, a field the type has not got. `test/domain/gate-remedies.test.ts`
// let all of them through, because it checks that a remedy's first word is `treadle` and its
// second is a command, and a line can be both and still be refused.
//
// So this file does not read the lines. It runs them. Each scenario builds a workspace in a
// state that makes the tool emit, each provocation is run against a fresh copy of that state,
// every `fix`, `page` and `whole` line and every block cell that is a command line is taken
// off the result object, its placeholders are filled from the one table below, and the line
// is tokenised as a POSIX shell would and run in-process on another fresh copy of the same
// state. It passes if it exits 0, or with an exit the inventory declares as a verdict rather
// than a failure, which is `doctor`'s 7.
//
// The pass criterion is deliberately what a reader experiences. A line refused for a reason
// the emitter could have known (no such edge, a required flag left off, a field of another
// type, an id that names nothing, an operand dropped) fails here by the line's own text. A
// line whose second-order outcome depends on the workspace, such as a dry run over a refused
// edge, is provoked in a state where it succeeds, because that is what "runnable from where
// the reader stands" means: the line is the right next command, and where it hands back a
// refusal, that refusal carries its own runnable line.
//
// WHAT A FUTURE EMITTER'S AUTHOR HAS TO DO. Add a provocation to the scenario that reaches
// the new line, or a scenario if no existing state does. A placeholder the table below does
// not know fails the run by name. The floor on collected lines and the list of shapes that
// must be seen are what stops the sweep passing over nothing.
//
// The second half proves that a `page` line is a continuation: the pages a filtered list
// prints, walked by its own cursor lines, concatenate to the same rows the same filter
// prints in one page, in the same order, and every row still matches the filter.

import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { commandNamed } from '../../src/cli/inventory.ts'
import { runCli, type Run } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' }

/**
 * Every placeholder an emitted line may carry, and the value a reader in this workspace
 * would fill it with. A quoted placeholder stays quoted, so `--reason "<why>"` fills to one
 * token. An angle-bracket set, `<a|b|c>`, fills to its last member, which is why the
 * relation kind lands on `relates-to` and `fix_confirmed` on `false`.
 */
const FILL: Readonly<Record<string, string>> = {
  '<why>': 'because it must',
  '<title>': 'A title',
  '<value>': 'something',
  '<n>': '3',
  '<name>': 'kim',
  '<id>': 'ready-task',
  '<other>': 'spare-task',
  '<sprint>': 'sprint-open',
  '<slug>': 'fresh-slug',
  '<S1-S4>': 'S2',
  '<1-5>': '3',
  '<instant>': '2030-01-01T00:00:00Z',
  '<date>': '2030-01-31',
  '<kind>': 'run',
  '<ref>': '8813',
  '<entry>': 'one',
  '<state>': 'ready',
  '<r>': 'wont_do',
  '<type>': 'task',
  '<field>': 'title',
}

function fill(line: string): string {
  let out = line.replace(' [label]', '')
  for (const [placeholder, value] of Object.entries(FILL)) out = out.replaceAll(placeholder, value)
  out = out.replace(/<([a-z_-]+(?:\|[a-z_-]+)+)>/g, (_, set: string) => set.split('|').at(-1) as string)
  const left = /<[^>]+>/.exec(out)
  assert.equal(left, null, `${line} carries the placeholder ${left?.[0] ?? ''}, which FILL in this file does not know`)
  return out
}

/** A command line split as a POSIX shell splits it: single quotes literal, double quotes and backslashes escaping. */
function shellSplit(line: string): readonly string[] {
  const words: string[] = []
  let word = ''
  let open = false
  let quote: '"' | "'" | undefined
  for (let at = 0; at < line.length; at += 1) {
    const ch = line[at] as string
    if (quote === "'") {
      if (ch === "'") quote = undefined
      else word += ch
    } else if (quote === '"') {
      if (ch === '"') quote = undefined
      else if (ch === '\\' && at + 1 < line.length) { word += line[at + 1]; at += 1 }
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      open = true
    } else if (ch === '\\' && at + 1 < line.length) {
      word += line[at + 1]
      at += 1
      open = true
    } else if (ch === ' ' || ch === '\t') {
      if (open) words.push(word)
      word = ''
      open = false
    } else {
      word += ch
      open = true
    }
  }
  assert.equal(quote, undefined, `${line} closes no ${String(quote)} quote`)
  if (open) words.push(word)
  return words
}

/** Every command line the result carries, wherever the shape put it: `fix`, `page`, `whole`, a block cell. */
function emittedLines(run: Run): readonly string[] {
  const text = `${run.out}${run.err}`
  const found: string[] = []
  if (text.startsWith('{')) {
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.startsWith('treadle ')) found.push(value)
      } else if (Array.isArray(value)) {
        for (const entry of value) walk(entry)
      } else if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value)) walk(entry)
      }
    }
    walk((JSON.parse(text) as { data: unknown }).data)
  } else {
    // A refusal the parser raises is rendered before `--out` is read, so it arrives in the
    // line format whatever was asked for.
    for (const match of text.matchAll(/^(?:fix|page|whole) (treadle .*)$/gm)) found.push(match[1] as string)
  }
  return [...new Set(found)]
}

type Scenario = {
  readonly name: string
  /** Builds the state under `dir`, which holds `.work` unless the scenario says otherwise. */
  readonly build: (dir: string) => Promise<void>
  readonly provocations: readonly (readonly string[])[]
}

/** Runs one setup command and refuses to build a fixture on a refusal it did not expect. */
async function must(dir: string, argv: readonly string[]): Promise<Run> {
  const run = await runCli(argv, { cwd: dir, env: ENV })
  assert.equal(run.code, 0, `${argv.join(' ')}: ${run.err}`)
  return run
}

async function baseWorkspace(dir: string): Promise<void> {
  const m = (argv: readonly string[]) => must(dir, argv)
  await m(['init', '--name', 'runnable'])
  const task = async (id: string, to: readonly string[] = [], flags: readonly string[] = []): Promise<void> => {
    await m(['file', 'task', `Task ${id}`, '--id', id, ...flags])
    for (const state of to) await m(['transition', id, state, '--reason', 'fixture'])
  }
  const impediment = async (id: string, to: readonly string[], blocks: string): Promise<void> => {
    await m(['file', 'impediment', `Impediment ${id}`, '--id', id, '--set', 'severity=S1', '--set', 'proposed_resolution=renew it'])
    for (const state of to) await m(['transition', id, state, '--reason', 'fixture'])
    await m(['relation', 'add', id, 'blocks', blocks])
  }
  const story = async (id: string, to: readonly string[], flags: readonly string[] = []): Promise<void> => {
    await m(['file', 'story', `Story ${id}`, '--id', id, '--points', '3', '--set', 'acceptance_criteria=one|two', '--assignee', 'dana', ...flags])
    for (const state of to) await m(['transition', id, state, '--reason', 'fixture'])
  }

  await task('task-plain', [], ['--priority', '2'])
  await task('spare-task')
  await task('ready-task', ['ready'], ['--assignee', 'kim', '--priority', '1'])
  await task('done-task', ['ready', 'in_progress', 'done'])
  // Blockers in each non-terminal state, each holding a task that is refused because of it.
  await task('blocked-draft')
  await impediment('imp-draft', [], 'blocked-draft')
  await task('blocked-ready', ['ready'])
  await impediment('imp-ready', ['ready'], 'blocked-ready')
  await task('blocked-wip', ['ready', 'in_progress'])
  await impediment('imp-wip', ['ready', 'in_progress'], 'blocked-wip')
  await task('blocked-held', ['ready', 'in_progress'])
  await impediment('imp-hold', ['ready', 'on_hold'], 'blocked-held')
  // Review-step types out of in_progress: G5 on the story, G5 and G8 on the epic.
  await story('story-wip', ['ready', 'in_progress'])
  await story('story-review', ['ready', 'in_progress', 'in_review'])
  await m(['file', 'epic', 'Epic one', '--id', 'epic-one', '--set', 'outcome=tenants sign in'])
  await story('child-story', ['ready', 'in_progress'], ['--parent', 'epic-one'])
  for (const state of ['ready', 'in_progress']) await m(['transition', 'epic-one', state])
  await m(['file', 'bug', 'Bug cold', '--id', 'bug-cold', '--set', 'severity=S1', '--set', 'repro_steps=reload', '--set', 'found_in=test'])
  await m(['file', 'story', 'Story without criteria', '--id', 'draft-story-noac'])
  // One closed sprint that carried an item, and the one open sprint every `<sprint>` fills to.
  await task('carried-task', ['ready'])
  await m(['sprint', 'open', 'Sprint closed', '--id', 'sprint-closed', '--start', '2026-01-05', '--end', '2026-01-16'])
  await m(['sprint', 'commit', 'sprint-closed', 'carried-task'])
  await m(['sprint', 'close', 'sprint-closed'])
  await task('sprint-task', ['ready'], ['--assignee', 'dana', '--priority', '1'])
  await m(['sprint', 'open', 'Sprint open', '--id', 'sprint-open', '--end', '2030-01-31'])
  await m(['sprint', 'commit', 'sprint-open', 'sprint-task'])
  await task('committed-task', ['ready'])
  // Three more drafts, so a filtered page of two has a page after it.
  await task('draft-two')
  await task('draft-three')
}

async function rewriteSchema(dir: string, files: readonly string[], schema: number): Promise<void> {
  for (const file of files) {
    const full = path.join(dir, '.work', file)
    const text = await readFile(full, 'utf8')
    assert.match(text, /^schema: 1\n/, `${file} does not open with the schema line this rewrite expects`)
    await writeFile(full, text.replace(/^schema: 1\n/, `schema: ${schema}\n`))
  }
}

async function shards(dir: string): Promise<readonly string[]> {
  return (await readdir(path.join(dir, '.work', 'items'))).filter((name) => name.endsWith('.md')).map((name) => `items/${name}`)
}

const LONG_ACTOR = 'a'.repeat(201)

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a workspace with blockers in every state, review-step work in progress and two sprints',
    build: baseWorkspace,
    provocations: [
      // The gate and guard remedies, on every edge a blocker or a child can stand in the way of.
      ['transition', 'blocked-draft', 'ready'],
      ['transition', 'blocked-ready', 'in_progress'],
      ['transition', 'blocked-wip', 'done'],
      ['transition', 'blocked-held', 'done'],
      ['transition', 'story-wip', 'done'],
      ['transition', 'story-review', 'done'],
      ['transition', 'epic-one', 'done'],
      ['transition', 'bug-cold', 'ready'],
      ['transition', 'draft-story-noac', 'ready'],
      ['explain', 'blocked-draft'],
      ['explain', 'blocked-wip'],
      ['explain', 'story-review'],
      ['explain', 'epic-one'],
      ['explain', 'bug-cold'],
      // The transition command's own refusals.
      ['transition', 'task-plain', 'ready', '--dry-run', '--preview'],
      ['transition', 'task-plain', 'on_hold'],
      ['transition', 'task-plain', 'cancelled', '--reason', 'no resolution given'],
      ['transition', 'imp-hold', 'done'],
      ['transition', 'blocked-ready', 'in_progress', '--override', 'G1', '--reason', 'not overridable'],
      ['transition', 'task-plain', 'nope'],
      ['transition', 'task-plain'],
      ['transition', 'nope', 'done'],
      // Every field `set` refuses, each naming the command that writes it.
      ['set', 'task-plain', 'nonsense=1'],
      ['set', 'task-plain', 'state=done'],
      ['set', 'task-plain', 'type=bug'],
      ['set', 'task-plain', 'id=other'],
      ['set', 'task-plain', 'priority=1'],
      ['set', 'bug-cold', 'severity=S2'],
      ['set', 'task-plain', 'severity=S2'],
      ['set', 'task-plain', 'sprint_id=sprint-open'],
      ['set', 'task-plain', 'resolution=wont_do'],
      ['set', 'task-plain', 'hold_reason=x'],
      ['set', 'task-plain', 'hold_until=2030-01-01T00:00:00Z'],
      ['set', 'task-plain', 'held_from=draft'],
      ['set', 'task-plain', 'evidence=x'],
      ['set', 'task-plain', 'relations=x'],
      ['set', 'task-plain', 'filed_at=x'],
      ['set', 'task-plain', 'acceptance_criteria=x'],
      ['set', 'task-plain'],
      ['set', 'task-plain', 'nonsense'],
      ['set', 'task-plain', 'title=x', '--actor', LONG_ACTOR],
      ['set', 'nope', 'title=x'],
      ['set'],
      // The hierarchy rules where a parent edge is written, and the fields that refuse to clear.
      ['set', 'task-plain', 'parent_id=task-plain'],
      ['set', 'task-plain', 'parent_id=spare-task'],
      ['set', 'epic-one', 'parent_id=child-story'],
      ['set', 'task-plain', 'parent_id=nope'],
      ['file', 'task', 'Under nothing', '--parent', 'nope'],
      ['set', 'task-plain', 'title='],
      ['set', 'bug-cold', 'repro_steps='],
      // `mark` and `evidence`.
      ['mark', 'task-plain'],
      ['mark', 'bug-cold'],
      ['mark', 'task-plain', '--priority', '4'],
      ['mark', 'task-plain', '--severity', 'S9', '--reason', 'x'],
      ['mark'],
      ['evidence', 'add', 'task-plain', 'nope', 'x'],
      ['evidence', 'list'],
      ['evidence', 'add', 'task-plain'],
      ['relation', 'add', 'task-plain', 'nope', 'spare-task'],
      ['relation', 'add', 'task-plain', 'blocks', 'task-plain'],
      ['relation', 'add', 'task-plain', 'blocks', 'nope'],
      ['relation', 'add'],
      ['relation', 'nope'],
      // Sprints: taken ids, closed and other sprints, items that are not ready, and `file --sprint`.
      ['sprint', 'open', 'Again', '--id', 'sprint-open', '--end', '2030-03-31'],
      ['sprint', 'open', 'Again', '--id', 'task-plain', '--end', '2030-03-31'],
      ['sprint', 'open', 'Again'],
      ['sprint', 'open'],
      ['sprint', 'nope'],
      ['sprint', 'close'],
      ['sprint', 'commit'],
      ['sprint', 'commit', 'sprint-open'],
      ['sprint', 'commit', 'nope', 'task-plain'],
      ['sprint', 'commit', 'sprint-closed', 'task-plain'],
      ['sprint', 'commit', 'sprint-open', 'draft-story-noac'],
      ['sprint', 'commit', 'sprint-open', 'done-task'],
      ['sprint', 'uncommit'],
      ['sprint', 'uncommit', 'carried-task'],
      ['sprints', 'nope'],
      ['file', 'task', 'Taken', '--id', 'sprint-open'],
      ['file', 'story', 'Filed into a sprint', '--sprint', 'sprint-open'],
      ['file', 'bug', 'Filed into a sprint', '--set', 'severity=S1', '--set', 'repro_steps=x', '--set', 'found_in=test', '--sprint', 'sprint-open'],
      ['file', 'story', 'Filed into nothing', '--sprint', 'nope'],
      ['file', 'bug', 'Cold'],
      ['file', 'nope', 'x'],
      ['file'],
      // Lists: page and whole lines under filters, columns, limits and `--for`, and bad cursors.
      ['backlog', '--state', 'draft', '--limit', '2'],
      ['backlog', '--type', 'task', '--fields', 'id,state', '--limit', '1'],
      ['backlog', '--assignee', 'dana', '--limit', '1'],
      ['backlog', '--limit', '2', '--cursor', 'nope'],
      ['backlog', '--fields', 'id,title,desc'],
      ['backlog', '--fields', 'nope'],
      ['backlog', '--cursor'],
      ['next', '--for', 'kim', '--limit', '1'],
      ['next', '--cursor', 'nope'],
      ['history', 'blocked-held', '--limit', '1'],
      ['history', 'blocked-held', '--cursor', 'nope'],
      ['history', 'nope'],
      ['board', '--type', 'task'],
      ['board', '--fields', 'id,title,desc'],
      ['board', '--all', '--sprint', 'sprint-open'],
      ['board', '--sprint', 'nope'],
      // Reads over nothing, and the parser's own refusals.
      ['show', 'nope'],
      ['show', 'task-plain', '--field', 'nope'],
      ['show'],
      ['explain', 'nope'],
      ['show', 'task-plain', '--limit', '1'],
      ['--nope'],
      ['nope'],
      ['status', '--out', 'nope'],
      ['help', 'nope'],
    ],
  },
  {
    name: 'two open sprints',
    build: async (dir) => {
      await baseWorkspace(dir)
      await must(dir, ['sprint', 'open', 'Sprint two', '--id', 'sprint-two', '--end', '2030-02-28'])
      await must(dir, ['sprint', 'commit', 'sprint-two', 'committed-task'])
    },
    provocations: [
      ['sprint', 'commit', 'sprint-open', 'committed-task'],
      ['board'],
    ],
  },
  {
    name: 'a shard at an older schema, which a write refuses',
    build: async (dir) => {
      await baseWorkspace(dir)
      await rewriteSchema(dir, await shards(dir), 0)
    },
    provocations: [['set', 'task-plain', 'title=New']],
  },
  {
    name: 'a shard at a newer schema, which every read refuses',
    build: async (dir) => {
      await baseWorkspace(dir)
      await rewriteSchema(dir, await shards(dir), 2)
    },
    provocations: [['status'], ['backlog']],
  },
  {
    name: 'a workspace file at a newer schema, which the store refuses to open',
    build: async (dir) => {
      await baseWorkspace(dir)
      await rewriteSchema(dir, ['workspace.md'], 2)
    },
    provocations: [['status']],
  },
  {
    name: 'no workspace at all',
    build: async () => {},
    provocations: [['status'], ['backlog'], ['nope']],
  },
  // `status` here prints `treadle init`, which this directory refuses with `init --yes` as its
  // own fix: the line is the right next command from where the reader stands, and the state
  // that makes it refuse is one only `init` can see. It is provoked through `init` directly.
  {
    name: 'a .work directory holding files that is not a workspace',
    build: async (dir) => {
      await mkdir(path.join(dir, '.work'))
      await writeFile(path.join(dir, '.work', 'notes.txt'), 'not a workspace\n')
    },
    provocations: [['init']],
  },
]

/**
 * The shapes the audit found refused as printed, each as the regular expression a collected
 * line has to match. A sweep that stopped reaching one of these would pass over its absence
 * otherwise.
 */
const MUST_SEE: readonly (readonly [string, RegExp])[] = [
  ['a blocker remedied by its next move rather than by done', /^treadle transition imp-draft ready$/],
  ['a held blocker remedied by resume', /^treadle transition imp-hold resume$/],
  ['an open child remedied by its next move', /^treadle transition child-story in_review$/],
  ['a G5 refusal naming the submit', /^treadle transition story-wip in_review$/],
  ['a G2 refusal naming the blocker\'s move and the override', /^treadle transition blocked-ready in_progress --override G2 --reason "<why>"$/],
  ['a page line carrying the filter and the limit', /^treadle backlog --state draft --limit 2 --cursor \S+$/],
  ['a page line carrying the columns', /^treadle backlog --type task --fields id,state --limit 1 --cursor \S+$/],
  ['a page line carrying --for', /^treadle next --for kim --limit 1 --cursor \S+$/],
  ['a history page carrying the limit', /^treadle history blocked-held --limit 1 --cursor \S+$/],
  ['a whole line carrying the filter', /^treadle board --type task --all$/],
  ['a dry-run fix keeping its operands', /^treadle transition task-plain ready --dry-run( --out json)?$/],
  ['a sprint open line carrying --end', /^treadle sprint open "<title>" --end <date> --id <slug>$/],
  ['a hold line carrying --reason', /^treadle transition task-plain on_hold --until <instant> --reason "<why>"$/],
  ['a mark line naming the field the type has', /^treadle mark task-plain --priority <1-5> --reason "<why>"$/],
  ['an unknown field answered with the set syntax', /^treadle set task-plain <field>=<value>$/],
  ['file --sprint refused with a line that files it', /^treadle file bug "<title>" --set severity=<S1-S4> --set repro_steps=<value> --set found_in=<[a-z|]+>$/],
  ['an older schema answered with version, not init', /^treadle version$/],
  ['a refused parent answered with the types that may parent the item', /^treadle backlog --type epic$/],
  ['a field that refuses to clear answered with the write that fills it', /^treadle set bug-cold repro_steps=<value>$/],
]

type Collected = {
  readonly scenario: Scenario
  readonly provocation: readonly string[]
  readonly lines: readonly string[]
}

describe('every line the tool prints for the reader to run is runnable as printed, from the state that printed it', () => {
  const parent = mkdtemp(path.join(tmpdir(), 'treadle-runnable-'))
  const built = new Map<string, string>()
  const collected: Collected[] = []

  /** A fresh copy of a built scenario, without its index, which the next open rebuilds. */
  async function copyOf(scenario: Scenario): Promise<string> {
    const source = built.get(scenario.name) as string
    const dir = await mkdtemp(path.join(await parent, 'copy-'))
    await cp(source, dir, { recursive: true, filter: (from) => path.basename(from) !== '.index' })
    return dir
  }

  before(async () => {
    for (const scenario of SCENARIOS) {
      const dir = await mkdtemp(path.join(await parent, 'scenario-'))
      await scenario.build(dir)
      built.set(scenario.name, dir)
      for (const provocation of scenario.provocations) {
        // A provocation about `--out` itself keeps its own, and its refusal arrives in the line format.
        const rendering = provocation.includes('--out') ? [] : ['--out', 'json']
        const run = await runCli([...provocation, ...rendering], { cwd: await copyOf(scenario), env: ENV })
        collected.push({ scenario, provocation, lines: emittedLines(run) })
      }
    }
  })
  after(async () => { await rm(await parent, { recursive: true, force: true }) })

  it('collects enough lines that a pass means something, and every provocation printed at least one', () => {
    const silent = collected.filter((entry) => entry.lines.length === 0).map((entry) => entry.provocation.join(' '))
    assert.deepEqual(silent, [], 'a provocation that printed no line to run is not provoking anything')
    const distinct = new Set(collected.flatMap((entry) => entry.lines))
    assert.ok(distinct.size >= 90, `only ${distinct.size} distinct lines were collected`)
  })

  it('reaches every shape the audit found refused as printed', () => {
    const lines = collected.flatMap((entry) => entry.lines)
    for (const [what, shape] of MUST_SEE) {
      assert.ok(lines.some((line) => shape.test(line)), `${what}: no collected line matches ${shape}`)
    }
  })

  for (const scenario of SCENARIOS) {
    for (const provocation of scenario.provocations) {
      it(`${scenario.name}: treadle ${provocation.join(' ').slice(0, 80)}`, async () => {
        const entry = collected.find((c) => c.scenario === scenario && c.provocation === provocation) as Collected
        const refused: string[] = []
        for (const line of entry.lines) {
          const words = shellSplit(fill(line))
          assert.equal(words[0], 'treadle', `${line} does not start with the binary name`)
          const run = await runCli(words.slice(1), { cwd: await copyOf(scenario), env: ENV })
          // An exit the inventory declares as a verdict is the command answering, not failing.
          const verdicts = commandNamed(words[1] ?? 'status')?.exits?.map(([code]) => code) ?? []
          if (run.code !== 0 && !verdicts.includes(run.code)) {
            refused.push(`${line}\n    filled: treadle ${words.slice(1).join(' ')}\n    exit ${run.code}: ${run.err.trim().replaceAll('\n', '\n    ')}`)
          }
        }
        assert.deepEqual(refused, [], `printed by treadle ${provocation.join(' ')} and refused as printed:\n  ${refused.join('\n  ')}`)
      })
    }
  }

  /** Walks a list by the cursor lines it prints, returning the first column of every row in order. */
  async function walk(dir: string, first: readonly string[]): Promise<{ readonly ids: string[]; readonly pages: number }> {
    const ids: string[] = []
    let argv = first
    let pages = 0
    for (;;) {
      const run = await runCli([...argv, '--out', 'json'], { cwd: dir, env: ENV })
      assert.equal(run.code, 0, run.err)
      const data = JSON.parse(run.out).data as Record<string, unknown>
      const block = Object.values(data).find((value) => typeof value === 'object' && value !== null && 'rows' in value) as { rows: Record<string, unknown>[] }
      for (const row of block.rows) ids.push(String(Object.values(row)[0]))
      pages += 1
      const page = data['page']
      if (typeof page !== 'string') return { ids, pages }
      argv = shellSplit(page).slice(1)
    }
  }

  it('a filtered backlog walked by its page lines is the same list its filter prints in one page', async () => {
    const dir = await copyOf(SCENARIOS[0] as Scenario)
    const paged = await walk(dir, ['backlog', '--state', 'draft', '--limit', '2'])
    const whole = await walk(dir, ['backlog', '--state', 'draft', '--limit', '100'])
    assert.ok(paged.pages >= 3, `the walk took ${paged.pages} pages, so it proved nothing about continuation`)
    assert.deepEqual(paged.ids, whole.ids)
    assert.equal(new Set(paged.ids).size, paged.ids.length, 'a row was returned twice')
    for (const id of paged.ids) {
      const shown = await runCli(['show', id, '--field', 'state'], { cwd: dir, env: ENV })
      assert.match(shown.out, /^state draft$/m, `${id} reached a page of the draft list and is not draft`)
    }
  })

  it('a ranked list under --for walked by its page lines keeps the scores --for gave it', async () => {
    const dir = await copyOf(SCENARIOS[0] as Scenario)
    const scored = async (argv: readonly string[]): Promise<string[]> => {
      const out: string[] = []
      let next = argv
      for (;;) {
        const run = await runCli([...next, '--out', 'json'], { cwd: dir, env: ENV })
        assert.equal(run.code, 0, run.err)
        const data = JSON.parse(run.out).data as { next: { rows: { id: string; score: number }[] }; page?: string }
        out.push(...data.next.rows.map((row) => `${row.id} ${row.score}`))
        if (data.page === undefined) return out
        next = shellSplit(data.page).slice(1)
      }
    }
    const paged = await scored(['next', '--for', 'kim', '--limit', '1'])
    const whole = await scored(['next', '--for', 'kim', '--limit', '100'])
    assert.ok(paged.length >= 2, `only ${paged.length} rows were ranked, so the page line was never followed`)
    assert.deepEqual(paged, whole)
    const unweighted = await scored(['next', '--limit', '100'])
    assert.notDeepEqual(whole, unweighted, 'the fixture no longer has an item whose score --for kim changes, so the proof is vacuous')
  })

  it('a history walked by its page lines is the whole log, one event per row and none twice', async () => {
    const dir = await copyOf(SCENARIOS[0] as Scenario)
    const paged = await walk(dir, ['history', 'blocked-held', '--limit', '1'])
    const whole = await walk(dir, ['history', 'blocked-held', '--limit', '100'])
    assert.ok(paged.pages >= 3, `the walk took ${paged.pages} pages`)
    assert.deepEqual(paged.ids, whole.ids)
  })

  it('a board\'s whole line keeps the filter the scoped board was asked with', async () => {
    const dir = await copyOf(SCENARIOS[0] as Scenario)
    const scoped = await runCli(['board', '--type', 'impediment', '--out', 'json'], { cwd: dir, env: ENV })
    assert.equal(scoped.code, 0, scoped.err)
    const data = JSON.parse(scoped.out).data as { whole: string }
    assert.equal(data.whole, 'treadle board --type impediment --all')
    const whole = await runCli([...shellSplit(data.whole).slice(1), '--out', 'json'], { cwd: dir, env: ENV })
    assert.equal(whole.code, 0, whole.err)
    const rows = Object.values(JSON.parse(whole.out).data as Record<string, unknown>)
      .filter((value): value is { rows: { type: string }[] } => typeof value === 'object' && value !== null && 'rows' in value)
      .flatMap((block) => block.rows)
    assert.ok(rows.length >= 4, `the whole board shows ${rows.length} rows`)
    assert.deepEqual(rows.filter((row) => row.type !== 'impediment'), [], 'the whole board dropped the type filter')
  })
})
