// SPDX-License-Identifier: Apache-2.0
// G2: an id operand carrying a delimiter was an internal error at exit 1.
//
// `treadle show $'a\nb'` printed `err INTERNAL -` with a render invariant in its cause and
// no rule id, and so did `explain`, `history`, `remove`, `set`, `mark`, `transition`,
// `evidence add` and `relation add`. The contract says every failure is a structured,
// typed, machine-readable error, and that was the one path where it was not, on twelve
// commands at once.
//
// The suite is written against the inventory rather than against that list, because the list
// is what grows: every line below is expanded through `entityOperands`, which reads the
// usage lines the inventory publishes, so a command added with `<id>` in its usage is
// guarded by construction.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { DELIMITERS } from '../../src/adapters/render/grammar.ts'
import { RENDERINGS } from '../../src/adapters/render/index.ts'
import { COMMANDS } from '../../src/cli/inventory.ts'
import { COMMAND_OPTIONS, GLOBAL_OPTIONS } from '../../src/cli/parse.ts'
import { entityOperands } from '../../src/cli/operands.ts'
import { EXIT_OF } from '../../src/cli/exit.ts'
import { runCli } from '../helpers/cli-run.ts'

const ENV = { TREADLE_ACTOR: 'dana' } as const

type Run = { code: number; out: string; err: string }
type Cli = (argv: readonly string[]) => Promise<Run>

function must(run: Run, what: string): Run {
  assert.equal(run.code, 0, `${what}: ${run.err}`)
  return run
}

async function aWorkspace(): Promise<{ root: string; cli: Cli }> {
  const root = await mkdtemp(path.join(tmpdir(), 'treadle-operand-'))
  const cli = (argv: readonly string[]) => runCli(argv, { cwd: root, env: ENV })
  must(await cli(['init', '--name', 'guarded']), 'init')
  must(await cli(['file', 'task', 'A record to name', '--id', 'a-record']), 'file')
  must(await cli(['file', 'task', 'Another record', '--id', 'other-record']), 'file')
  return { root, cli }
}

/**
 * Every character the guard bounds. The first entries are the `agent/1` grammar's own
 * delimiters, read from the grammar so a delimiter added there is poisoned here without an
 * edit; the rest are the wider class the domain refuses in any field of a record, one per
 * Unicode category that class names (Cc, Cf, Cs, Zl, Zp).
 */
const STRUCTURAL: readonly (readonly [string, string])[] = [
  ...DELIMITERS.map((byte) => [byte === '\n' ? 'line feed' : 'carriage return', byte] as const),
  ['null', '\u0000'],
  ['tab', '\u0009'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
  ['right-to-left override', '\u202e'],
  ['pop directional isolate', '\u2069'],
  ['zero width space', '\u200b'],
  ['byte order mark', '\ufeff'],
  ['unpaired surrogate', '\ud800'],
]

/**
 * One runnable line per command that takes an entity operand, with a legal value in every
 * slot. The poison goes into one entity operand at a time, chosen by `entityOperands`, so
 * the positions this file exercises are the positions the guard reads rather than a second
 * copy of them. The coverage test below holds this table against the inventory.
 */
const LINES: readonly (readonly string[])[] = [
  ['show', 'a-record'],
  ['explain', 'a-record'],
  ['history', 'a-record'],
  ['set', 'a-record', 'priority=1'],
  ['mark', 'a-record', '--priority', '1', '--reason', 'it is urgent'],
  ['transition', 'a-record', 'ready'],
  ['remove', 'a-record', '--reason', 'filed twice', '--yes'],
  ['evidence', 'add', 'a-record', 'run', 'https://example.test/1'],
  ['relation', 'add', 'a-record', 'blocks', 'other-record'],
]

/** The argv positions of a line that are operands, in order, skipping flags and their values. */
function operandPositions(line: readonly string[]): readonly number[] {
  const out: number[] = []
  for (const [index, token] of line.entries()) {
    if (index === 0 || token.startsWith('--')) continue
    if (line[index - 1]?.startsWith('--') === true) continue
    out.push(index)
  }
  return out
}

describe('an operand naming a record is bounded before any service reads it', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  for (const line of LINES) {
    const command = line[0] as string
    const positions = operandPositions(line)
    const operands = positions.map((index) => line[index] as string)
    for (const { at } of entityOperands(command, operands)) {
      for (const [name, character] of STRUCTURAL) {
        it(`refuses ${name} in operand ${at + 1} of ${command} ${operands.join(' ')}`, async () => {
          const argv = [...line]
          const poisoned = `a${character}b`
          argv[positions[at] as number] = poisoned
          const run = await cli(argv)
          assert.equal(run.code, EXIT_OF.VALIDATION, `exited ${run.code}: ${run.err}`)
          assert.match(run.err, /^err VALIDATION /, run.err)
          assert.match(run.err, /^rule C1$/m, run.err)
          assert.match(run.err, /^"cause the id in operand \d+ carries U\+[0-9A-F]{4}/m, run.err)
          assert.equal(run.out, '', 'a refusal wrote to stdout')
          // The operand whole, because a refusal is several lines and a line feed is how it
          // separates them: what must not appear is the caller's word, delimiter and all.
          assert.equal(run.err.includes(poisoned), false, 'the refusal echoed the operand it refused')
          assert.equal(run.err.includes('INTERNAL'), false, 'the refusal is untyped')
        })
      }
    }
  }

  it('refuses in every rendering, with no delimiter reaching any of the three streams', async () => {
    for (const rendering of RENDERINGS) {
      for (const [name, character] of STRUCTURAL) {
        const poisoned = `a${character}b`
        const run = await cli(['show', poisoned, '--out', rendering])
        assert.equal(run.code, EXIT_OF.VALIDATION, `${rendering}/${name} exited ${run.code}`)
        assert.equal(run.out, '', `${rendering}/${name} wrote to stdout`)
        assert.equal(run.err.includes(poisoned), false, `${rendering}/${name} echoed the operand`)
        assert.equal(run.err.includes('INTERNAL'), false, `${rendering}/${name} is untyped`)
      }
    }
    const json = await cli(['show', 'a\nb', '--out', 'json'])
    const parsed = JSON.parse(json.err) as { ok: boolean; code: string; data: { rule?: string; cause?: string } }
    assert.equal(parsed.ok, false)
    assert.equal(parsed.code, 'VALIDATION')
    assert.equal(parsed.data.rule, 'C1')
    assert.match(parsed.data.cause ?? '', /^the id in operand 1 carries U\+000A/)
  })

  it('leaves a legal id alone, so the guard refuses the class and not the operand', async () => {
    must(await cli(['show', 'a-record']), 'show')
    // A legal id that names nothing is still the guard passing: it reaches the service and
    // comes back a NOT_FOUND about a record, not a VALIDATION about a character.
    const absent = await cli(['show', 'no-such-record'])
    assert.equal(absent.code, EXIT_OF.NOT_FOUND, absent.err)
    // A space is legal in a scalar line and no id holds one, so it stays a NOT_FOUND about a
    // record rather than becoming a refusal about a character.
    const spaced = await cli(['show', 'a b'])
    assert.equal(spaced.code, EXIT_OF.NOT_FOUND, spaced.err)
  })

  it('leaves the operands that carry prose alone, which set is the one that needs', async () => {
    // A description is `text` rather than `line` and legitimately holds newlines: the guard
    // is on the operands that name a record, and widening it to every operand would refuse
    // this write. It is the one operand in the inventory a delimiter belongs in.
    must(await cli(['set', 'a-record', 'description=first line\nsecond line']), 'set')
    const shown = must(await cli(['show', 'a-record', '--field', 'desc']), 'show --field')
    assert.match(shown.out, /^\|desc 2 \d+$/m, shown.out)
  })
})

describe('no flag of any command answers a delimiter with an internal error', () => {
  let root: string
  let cli: Cli
  before(async () => { ({ root, cli } = await aWorkspace()) })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  // The operand guard's other half. `--id`, `--cursor` and `--explain-absence` each reached a
  // scalar line unbounded on five commands, and each was found by trying it rather than by
  // reading the code, so the sweep is what holds the answer: every command against every flag
  // its own option table gives it, with a delimiter in the value. A refusal is fine and a
  // success is fine; `INTERNAL` at exit 1 is the contract's one broken promise.
  it('sweeps every command against every flag its option table declares', async () => {
    const broken: string[] = []
    for (const command of COMMANDS) {
      const options = { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[command.name] ?? {}) }
      for (const [name, config] of Object.entries(options)) {
        if ((config as { type?: string }).type !== 'string') continue
        const run = await cli([command.name, `--${name}`, 'a\nb'])
        if (run.err.includes('INTERNAL') || run.code === 1) {
          broken.push(`${command.name} --${name} exited ${run.code}: ${run.err.split('\n')[1] ?? ''}`)
        }
      }
    }
    assert.deepEqual(broken, [], 'a flag value reached a rendering that could not carry it')
  })

  it('reads a value that looks like a flag as a value, and not as that flag written twice', async () => {
    // `--title --title` cannot reach the repeat rule: a value starting with a dash is already
    // refused by the parser and has to be written inline, which is one token and one flag.
    const spelled = await cli(['backlog', '--title=--title'])
    assert.equal(spelled.code, 0, spelled.err)
    assert.match(spelled.out, /^filter state open title --title$/m, spelled.out)
    const dashed = await cli(['backlog', '--title', '--state'])
    assert.equal(dashed.code, EXIT_OF.VALIDATION, dashed.err)
    assert.match(dashed.err, /^"cause --title needs a value, and one starting with a dash/m, dashed.err)
  })
})

describe('the guard is read from the usage lines rather than from a list', () => {
  it('reads the entity operands of every command from its usage, and not from a list', () => {
    assert.deepEqual(entityOperands('show', ['x']).map((one) => one.at), [0])
    assert.deepEqual(entityOperands('relation', ['add', 'x', 'blocks', 'y']).map((one) => one.at), [1, 3])
    assert.deepEqual(entityOperands('relation', ['remove', 'x', 'blocks', 'y']).map((one) => one.at), [1, 3])
    assert.deepEqual(entityOperands('file', ['task', 'A title']).map((one) => one.at), [])
    // The verb decides which line the operands are read against, and a verb no line carries
    // reads none: the command refuses its own verb, and a guard here would answer about an
    // operand the caller has not reached.
    assert.deepEqual(entityOperands('relation', ['nonsense', 'x']).map((one) => one.at), [])
  })
})
