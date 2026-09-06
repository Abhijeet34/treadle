// SPDX-License-Identifier: Apache-2.0
// Axis A2: the 25-question scrum-master set, put to the command surface one question at a
// time and scored full, partial or none.
//
// The 25 questions are the prior-art axes table's own list, in its own order and its own
// words, so the scoring is reproducible rather than invented. Each row carries four things a
// reader can check: the one command the question was put to, what a full answer would have to
// contain, what the command actually returned, and the verdict that fell out of the two
// predicates. A question with no command in the inventory to aim at scores none with the
// reason, and never a low partial for looking nearly answerable.
//
// The reference scored 4 full, 6 partial, 15 none on this same list.
//
// Every `none` here is a claim that the product cannot do something, and a claim like that
// goes stale the moment a capability lands. Questions 7, 8, 20 and 21 asserted there was no
// sprint, no impediment and no board in this tree for as long as that was true and for one
// release after it was not, and 14 and 15 asserted there was no history verb from #21
// onward. So an absence is put to the tool rather than remembered: a question with a command
// to aim at is aimed at it, including when the expected answer is a refusal, and only a
// question the inventory can offer nothing for carries its verdict in prose.

import { crossCheck, openSurface, resultOf, type CrossCheck, type Invocation, type Surface } from './surface.ts'
import type { AxisResult } from './axis.ts'

type Answer = { readonly code: string; readonly data: Record<string, unknown>; readonly exit: number }

type Predicate = (answer: Answer) => boolean

type Question = {
  readonly n: number
  readonly question: string
  /** The one command the question is put to, or undefined when the inventory has none. */
  readonly argv?: readonly string[]
  /** What a full answer has to contain, in words, beside the predicate that checks it. */
  readonly fullNeeds: string
  readonly full?: Predicate
  readonly partial?: Predicate
  /** Why the verdict is what it is, for the rows a predicate cannot explain on its own. */
  readonly note: string
}

const block = (answer: Answer, key: string): readonly unknown[] => {
  const value = answer.data[key]
  if (typeof value !== 'object' || value === null) return []
  const rows = (value as { rows?: unknown }).rows
  return Array.isArray(rows) ? rows : []
}

const scalar = (answer: Answer, key: string): string =>
  (typeof answer.data[key] === 'string' ? answer.data[key] as string
    : typeof answer.data[key] === 'number' ? String(answer.data[key]) : '')

/** Every row of every board column, which is where the board's own answers live. */
const boardRows = (answer: Answer): readonly Record<string, unknown>[] =>
  ['draft', 'ready', 'in_progress', 'in_review', 'on_hold']
    .flatMap((state) => block(answer, state) as readonly Record<string, unknown>[])

const listed = (key: string): Predicate => (answer) => answer.exit === 0 && block(answer, key).length > 0
const present = (key: string): Predicate => (answer) => answer.exit === 0 && answer.data[key] !== undefined
const never: Predicate = () => false

/** The 25 questions, in the prior-art table's order. */
const QUESTIONS: readonly Question[] = [
  {
    n: 1, question: 'what is ready',
    argv: ['backlog', '--state', 'ready'],
    fullNeeds: 'a list of the ready items in one call',
    full: (answer) => listed('items')(answer) && scalar(answer, 'filter').includes('ready'),
    note: 'one filter on the list verb answers it whole',
  },
  {
    n: 2, question: 'what is blocked and by what',
    argv: ['board', '--all'],
    fullNeeds: 'a list of the blocked items across the workspace, each with its blockers',
    full: (answer) => answer.exit === 0 && present('blocked')(answer)
      && boardRows(answer).some((row) => typeof row['blocked'] === 'string' && row['blocked'] !== '-'),
    partial: (answer) => boardRows(answer).length > 0,
    note: 'the board carries a blocked column naming the active blockers of every live item, counts them in its blocked scalar and sorts a blocked row to the top of its column; the rows arrive grouped by state rather than as one flat list, and no filter reduces the board to the blocked ones alone',
  },
  {
    n: 3, question: 'why is X blocked',
    argv: ['explain', 'a2-bug'],
    fullNeeds: 'the blockers of X with the reason or impediment behind each',
    // Full needs the blocker's own reason in the same call. An impediment stores what would
    // clear it in `proposed_resolution`, and explain names the blocker without it.
    full: (answer) => scalar(answer, 'blocked').startsWith('yes')
      && /renews the certificate/.test(JSON.stringify(answer.data)),
    partial: (answer) => scalar(answer, 'blocked').startsWith('yes'),
    note: 'the blocker here is an impediment, and explain names it and puts its remedy in every gate rule it fails; what would clear the impediment is stored on it as proposed_resolution and reaches no read surface, so the reason behind the blocker is a second command away',
  },
  {
    n: 4, question: 'what is in progress',
    argv: ['backlog', '--state', 'in_progress'],
    fullNeeds: 'a list of the in-progress items in one call',
    full: (answer) => listed('items')(answer) && scalar(answer, 'filter').includes('in_progress'),
    note: 'the same filter, on the same verb',
  },
  {
    n: 5, question: 'who is working on X',
    argv: ['show', 'a2-doing'],
    fullNeeds: 'the assignee of X',
    full: present('assignee'),
    note: 'the record verb prints the assignee',
  },
  {
    n: 6, question: 'what finished this week',
    argv: ['backlog', '--state', 'done'],
    fullNeeds: 'the done items narrowed to a time window',
    full: (answer) => /week|since|between|after/.test(scalar(answer, 'filter')),
    partial: listed('items'),
    note: 'the done set is one filter away; no verb takes a time window, and no record carries the instant it was finished, so the window half is missing',
  },
  {
    n: 7, question: 'what is the sprint goal',
    argv: ['sprints', 'a2-sprint-31'],
    fullNeeds: 'the goal of the active sprint',
    full: (answer) => present('goal')(answer) && scalar(answer, 'state') === 'open',
    note: 'the one-sprint read prints the goal whole, beside the dates and the tally; the bare sprints listing has no goal column, so a caller who does not know the id pays a call to learn it',
  },
  {
    n: 8, question: 'committed versus capacity',
    argv: ['sprints', 'a2-sprint-31'],
    fullNeeds: 'the committed points of the active sprint against its capacity',
    full: (answer) => present('capacity')(answer),
    partial: (answer) => present('committed')(answer) && present('pts')(answer),
    note: 'the committed half is exact, as a count of items and a done-over-committed points ratio; a sprint stores no capacity, so there is nothing to weigh the commitment against and ADR-0016 left the field out rather than guessing one',
  },
  {
    n: 9, question: 'velocity over the last three sprints',
    argv: ['sprints'],
    fullNeeds: 'a velocity figure per sprint with the formula that produced it',
    full: never,
    partial: (answer) => block(answer, 'sprints').some((row) =>
      typeof (row as { pts?: unknown }).pts === 'string'),
    note: 'the listing carries done-over-committed points for every sprint in one call, which is the numerator of a velocity and the whole of the input; no verb divides it by anything or names a formula, and that is the same absence axis A9 is NOT MEASURED for',
  },
  {
    n: 10, question: 'cycle time of X',
    argv: ['history', 'a2-done'],
    fullNeeds: 'the elapsed time between two named state instants for X',
    full: never,
    partial: (answer) => block(answer, 'events').filter((row) =>
      (row as { op?: unknown }).op === 'item.transition').length >= 2,
    note: 'history puts every state change of one item in one call, each with its instant, so both ends of a cycle time are behind a command rather than in the committed log; no verb subtracts them, and sprints prints a day-of-sprint but nothing per item',
  },
  {
    n: 11, question: 'what is aging',
    argv: ['next'],
    fullNeeds: 'the items ordered by how long they have sat, whatever state they sit in',
    full: never,
    partial: (answer) => block(answer, 'next').some((row) =>
      typeof (row as { parts?: unknown }).parts === 'string' && /a\d+/.test((row as { parts: string }).parts)),
    note: 'the age in days of every ready item is a scored component of the ranking and is printed; items in other states are not aged, and status separately counts what is past its due date',
  },
  {
    n: 12, question: 'is X ready per the definition of ready',
    argv: ['explain', 'a2-bug'],
    fullNeeds: 'a verdict per ready-gate rule for X',
    full: (answer) => block(answer, 'gates').some((row) => (row as { gate?: unknown }).gate === 'ready'),
    note: 'the gate block names each failing rule and what would satisfy it',
  },
  {
    n: 13, question: 'does X meet the definition of done',
    argv: ['explain', 'a2-story'],
    fullNeeds: 'a verdict per done-gate rule for X',
    full: (answer) => block(answer, 'gates').some((row) => (row as { gate?: unknown }).gate === 'done'),
    note: 'the same block carries the done gate beside the ready one',
  },
  {
    n: 14, question: 'what changed on X and when',
    argv: ['history', 'a2-done'],
    fullNeeds: 'the change history of X, each entry with its instant',
    full: (answer) => block(answer, 'events').length > 1
      && block(answer, 'events').every((row) => typeof (row as { at?: unknown }).at === 'string'
        && typeof (row as { what?: unknown }).what === 'string'),
    note: 'the history verb prints every event on one item newest first, each with its instant and what it moved as name=from->to; a side the log did not record printably is one of three markers rather than a blank',
  },
  {
    n: 15, question: 'who changed X',
    argv: ['history', 'a2-done'],
    fullNeeds: 'the actor on the change to X',
    full: (answer) => block(answer, 'events').length > 0
      && block(answer, 'events').every((row) => typeof (row as { by?: unknown }).by === 'string'
        && (row as { by: string }).by !== ''),
    note: 'every row of the history carries the actor that wrote it, so the answer is one call rather than a read of the committed log',
  },
  {
    n: 16, question: 'which items belong to epic E and how far along is it',
    argv: ['show', 'a2-child'],
    fullNeeds: 'the children of E with a rollup of their states',
    full: (answer) => listed('children')(answer),
    partial: present('parent'),
    note: 'the parent edge is writable and printed, which is more than the reference managed; no verb lists the children of an epic and none rolls their states up',
  },
  {
    n: 17, question: 'what is the priority order',
    argv: ['backlog'],
    fullNeeds: 'the items in priority order, with the order stated rather than implied',
    full: (answer) => listed('items')(answer) && scalar(answer, 'sort').startsWith('priority'),
    note: 'the list prints the sort it applied, so the order is a stated fact rather than a convention',
  },
  {
    n: 18, question: 'what duplicates X',
    argv: ['show', 'a2-ready'],
    fullNeeds: 'the items that duplicate X, named against X',
    full: (answer) => block(answer, 'relations').some((row) =>
      (row as { kind?: unknown }).kind === 'duplicated_by' && typeof (row as { other?: unknown }).other === 'string'),
    partial: listed('relations'),
    note: 'the edge is stored once on the copy and the read derives the other direction, so the item being duplicated names its copies without either record holding both halves; backlog --resolution duplicate still counts the set and names no pairing',
  },
  {
    n: 19, question: 'which bug did story X cause',
    argv: ['relation', 'add', 'a2-bug', 'caused-by', 'a2-story'],
    fullNeeds: 'the bugs whose caused-by edge names X',
    full: never,
    note: 'caused_by is one of the six kinds the domain declares, loads and derives an inverse for, and relation add writes three of them: ADR-0015 exposes a kind on a second argued caller rather than by default, so the command refuses this one by name and no edge exists to read back',
  },
  {
    n: 20, question: 'open impediments and their age',
    argv: ['board', '--all', '--type', 'impediment'],
    fullNeeds: 'the open impediments with the days each has stood',
    full: (answer) => boardRows(answer).some((row) => typeof row['age'] === 'string' || typeof row['age'] === 'number'),
    partial: (answer) => boardRows(answer).length > 0,
    note: 'an impediment is a work-item type, so the board filtered to it is every open one in a single call, each with its severity, and a terminal one is out of the columns by construction; no read prints how long one has stood, and the age of a ready item exists only as a scored component inside next',
  },
  {
    n: 21, question: 'is any column over its limit',
    fullNeeds: 'each board column against its work-in-progress limit',
    note: 'the board is real now and prints its five columns with a count on each, so the left half of the question is answered; nothing stores a work-in-progress limit for a column, which is why ADR-0018 leaves guard G3 disarmed rather than evaluating it against no limit',
  },
  {
    n: 22, question: 'what will this command do',
    argv: ['transition', 'a2-story', 'in_progress', '--dry-run'],
    fullNeeds: 'the fields the command would change and the exit status it would return, without changing anything',
    full: (answer) => present('dry_run')(answer) && present('would_exit')(answer),
    note: 'every mutation takes --dry-run, which runs every guard against a store that cannot write, and --preview, which names the store and the guards without evaluating one',
  },
  {
    n: 23, question: 'why did X not appear in ready',
    argv: ['backlog', '--state', 'ready', '--explain-absence', 'a2-doing'],
    fullNeeds: 'the clause that excluded X from that list',
    full: (answer) => present('clause')(answer) && present('absent')(answer),
    note: 'the list verb answers the absence directly, naming the first clause that excluded the id',
  },
  {
    n: 24, question: 'what should I do next and why',
    argv: ['next'],
    fullNeeds: 'a ranked list with the components and the weights that produced the order',
    full: (answer) => listed('next')(answer) && present('weights')(answer),
    note: 'the weights are in the output rather than in the documentation, so two runs are comparable byte for byte',
  },
  {
    n: 25, question: 'is the store healthy',
    argv: ['doctor'],
    fullNeeds: 'a verdict over the whole store, with the count it checked',
    full: (answer) => answer.exit === 0 && answer.data['findings'] !== undefined && answer.data['checked'] !== undefined,
    note: 'doctor reports what the files say that no write path would have accepted, and prints the count it checked so a clean answer over nothing is impossible',
  },
]

export type QuestionRow = {
  readonly n: number
  readonly question: string
  readonly command: string
  readonly exit: number | 'no command'
  readonly code: string
  readonly score: 'full' | 'partial' | 'none'
  readonly fullNeeds: string
  readonly note: string
}

export async function runA2(): Promise<{ readonly axis: AxisResult; readonly rows: readonly QuestionRow[] }> {
  const surface = await openSurface('a2')
  const rows: QuestionRow[] = []
  let crossChecked: CrossCheck | undefined

  try {
    await seed(surface)
    for (const question of QUESTIONS) {
      if (question.argv === undefined) {
        rows.push({
          n: question.n, question: question.question, command: 'none in the inventory',
          exit: 'no command', code: '', score: 'none',
          fullNeeds: question.fullNeeds, note: question.note,
        })
        continue
      }
      const call = await surface.run([...question.argv, '--out', 'json'])
      const answer = answerOf(call)
      const score = question.full?.(answer) === true ? 'full'
        : question.partial?.(answer) === true ? 'partial' : 'none'
      rows.push({
        n: question.n, question: question.question, command: question.argv.join(' '),
        exit: call.code, code: answer.code, score,
        fullNeeds: question.fullNeeds, note: question.note,
      })
      if (question.n === 1) crossChecked = await crossCheck(await surface.run(question.argv))
    }
  } finally {
    await surface.dispose()
  }

  const full = rows.filter((row) => row.score === 'full').length
  const partial = rows.filter((row) => row.score === 'partial').length
  const none = rows.filter((row) => row.score === 'none').length

  return {
    rows,
    axis: {
      axis: 'A2',
      name: 'Question coverage',
      metric: 'questions answerable with one command, out of a fixed 25-question scrum-master set',
      corpus: `the 25 questions in the prior-art axes table, put to a seeded workspace of ${SEED_ITEMS} items`,
      method: 'one command per question, scored full when the command answers it whole, partial when it answers part of it, none when no command in the inventory can be aimed at it',
      reference: '4 full, 6 partial, 15 none',
      target: '25 full',
      verdict: full === rows.length ? 'MET' : 'MISSED',
      observed: `${full} full, ${partial} partial, ${none} none, out of ${rows.length}, against the reference's 4 full, 6 partial, 15 none; the ${none} that score none are ${rows.filter((row) => row.score === 'none').map((row) => row.n).join(', ')}, and the note on each says what it stops at`,
      operations: surface.calls(),
      samples: rows.length,
      detail: {
        rows,
        full,
        partial,
        none,
        crossCheck: crossChecked ?? 'NOT MEASURED: question 1 did not run',
      },
    },
  }
}

const SEED_ITEMS = 10

function answerOf(call: Invocation): Answer {
  const result = resultOf(call)
  const data = result?.['data']
  return {
    exit: call.code,
    code: typeof result?.['code'] === 'string' ? result['code'] : '',
    data: typeof data === 'object' && data !== null ? data as Record<string, unknown> : {},
  }
}

/** A workspace with enough shape that a question failing is the tool and not the fixture. */
async function seed(surface: Surface): Promise<void> {
  const must = async (argv: readonly string[]): Promise<void> => {
    const call = await surface.run(argv)
    if (call.code !== 0) throw new Error(`${argv.join(' ')}: ${call.err}`)
  }

  await must(['file', 'epic', 'A2 the epic', '--id', 'a2-epic', '--set', 'outcome=enterprise tenants can sign in'])
  await must(['file', 'story', 'A2 the story', '--id', 'a2-story', '--points', '5', '--priority', '1',
    '--assignee', 'dana', '--set', 'acceptance_criteria=it signs in|it signs out'])
  await must(['file', 'story', 'A2 the child story', '--id', 'a2-child', '--points', '3', '--priority', '2',
    '--parent', 'a2-epic', '--set', 'acceptance_criteria=the child is done'])
  await must(['file', 'task', 'A2 the task in progress', '--id', 'a2-doing', '--points', '2', '--priority', '2', '--assignee', 'kim'])
  await must(['file', 'task', 'A2 the finished task', '--id', 'a2-done', '--points', '1', '--priority', '3'])
  await must(['file', 'bug', 'A2 the defect', '--id', 'a2-bug', '--priority', '1',
    '--set', 'severity=S1', '--set', 'found_in=production', '--set', 'repro_steps=sign in twice'])
  await must(['file', 'task', 'A2 the duplicate', '--id', 'a2-dupe', '--points', '1', '--priority', '4'])
  await must(['file', 'task', 'A2 the overdue task', '--id', 'a2-overdue', '--points', '2', '--priority', '2',
    '--set', 'due=2026-01-05T09:00:00Z'])
  await must(['file', 'task', 'A2 the ready task', '--id', 'a2-ready', '--points', '3', '--priority', '3'])
  await must(['file', 'impediment', 'A2 the expired staging certificate', '--id', 'a2-imped',
    '--set', 'severity=S1', '--set', 'proposed_resolution=platform renews the certificate'])

  // The impediment blocks the bug rather than the story, because a blocker fails DOR3 and
  // the story has to reach `ready` for the sprint to commit it.
  await must(['relation', 'add', 'a2-imped', 'blocks', 'a2-bug'])
  await must(['relation', 'add', 'a2-dupe', 'duplicates', 'a2-ready'])

  await must(['transition', 'a2-story', 'ready'])
  await must(['transition', 'a2-ready', 'ready'])
  await must(['transition', 'a2-doing', 'ready'])
  await must(['transition', 'a2-doing', 'in_progress'])
  await must(['transition', 'a2-done', 'ready'])

  // Two sprints, one closed over a finished item and one open, so the listing a velocity
  // question is put to has more than one row and the open one is unambiguous for the board.
  await must(['sprint', 'open', 'A2 sprint 30', '--id', 'a2-sprint-30',
    '--start', '2026-08-17', '--end', '2026-08-28', '--goal', 'land the sign-in flow'])
  await must(['sprint', 'commit', 'a2-sprint-30', 'a2-done'])
  await must(['transition', 'a2-done', 'in_progress'])
  await must(['transition', 'a2-done', 'done'])
  await must(['sprint', 'close', 'a2-sprint-30'])

  await must(['sprint', 'open', 'A2 sprint 31', '--id', 'a2-sprint-31',
    '--start', '2026-08-31', '--end', '2026-09-11', '--goal', 'ship the token refresh'])
  await must(['sprint', 'commit', 'a2-sprint-31', 'a2-story', 'a2-ready'])

  await must(['transition', 'a2-dupe', 'cancelled', '--resolution', 'duplicate', '--reason', 'a2-ready already covers it'])
}
