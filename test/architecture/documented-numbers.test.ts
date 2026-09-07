// SPDX-License-Identifier: Apache-2.0
// The documents carry numbers about the tool, and nothing noticed them going stale. The
// README said sixteen commands when the inventory had nineteen, six work-item types when
// there were seven, and eight of fifteen backlog items in draft when the workspace held
// seven. Every one of those was true the day it was written. A prose claim about a count is
// the kind of rot a reader cannot detect and a reviewer will not, because the number looks
// like every other number.
//
// So the checkable claims are checked here. What belongs in this file is a documented figure
// derived from something in this tree: a command inventory, a closed set, a table of rule
// ids, the workspace the README points at. What does not belong is a measurement, a wall
// time, a byte count of the tree or a coverage decimal, because those move on a commit that
// changed nothing about the claim; docs/VERIFICATION.md carries those with their dates.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { RENDERINGS } from '../../src/adapters/render/index.ts'
import { COMMANDS } from '../../src/cli/inventory.ts'
import {
  ALLOWED_PARENT_PAIRS,
  DEFAULT_DONE_GATE,
  DEFAULT_READY_GATE,
  RELATION_KINDS,
  WORK_ITEM_STATES,
  WORK_ITEM_TYPES,
} from '../../src/domain/index.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8')

/** The words the documents spell counts with, so a sentence and a set cannot disagree. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
}

/**
 * The number a document spelled in front of `noun`, as in "nineteen commands". Every sentence
 * that spells one is read, and they have to agree: this took the first match alone, so a
 * later sentence in the same section could contradict the first and pass. A match whose word
 * is not a number ("that are `done`") is skipped rather than refused, so a count is one the
 * document spelled and not one this file guessed.
 */
function spelled(text: string, noun: string): number {
  const found = [...text.matchAll(new RegExp(`([A-Za-z]+) ${noun}`, 'gi'))]
    .map((match) => (match[1] ?? '').toLowerCase())
    .filter((word) => word in NUMBER_WORDS)
    .map((word) => NUMBER_WORDS[word] as number)
  assert.ok(found.length > 0, `no sentence in the document reads "<number> ${noun}"`)
  assert.equal(new Set(found).size, 1, `the document spells "${noun}" as ${found.join(' and then ')} in different sentences`)
  return found[0] as number
}

/** Every command named in a backticked list, reading `evidence add` as `evidence`. */
function commandsIn(line: string): readonly string[] {
  const names: string[] = []
  for (const match of line.matchAll(/`([a-z]+)(?: [a-z]+)?`/g)) {
    const name = match[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names.sort()
}

const README = read('README.md')
const INVENTORY = COMMANDS.map((command) => command.name).sort()

describe('the README names the command surface the inventory carries', () => {
  it('lists every command in the sentence that says what bin/treadle.js runs', () => {
    const sentence = README.split('\n').find((line) => line.startsWith('`bin/treadle.js` runs'))
    assert.ok(sentence !== undefined, 'README has no sentence beginning "`bin/treadle.js` runs"')
    assert.deepEqual(commandsIn(sentence), INVENTORY,
      "the README's `bin/treadle.js` runs sentence backticks a different set of commands than src/cli/inventory.ts declares; edit the sentence to the inventory")
    assert.equal(spelled(sentence, 'commands'), INVENTORY.length,
      `the README's \`bin/treadle.js\` runs sentence spells a command count the inventory does not have; src/cli/inventory.ts declares ${INVENTORY.length}`)
  })

  it('lists every command in the Status row that calls them implemented', () => {
    const row = README.split('\n').find((line) => line.startsWith('| Commands: `init`'))
    assert.ok(row !== undefined, 'README has no Status row beginning "| Commands: `init`"')
    assert.deepEqual(commandsIn(row), INVENTORY,
      "the README's Status row backticks a different set of commands than src/cli/inventory.ts declares; edit the row to the inventory")
  })

  it('spells the number of work-item types the domain declares', () => {
    assert.equal(spelled(README, 'work-item types'), WORK_ITEM_TYPES.length,
      `the README spells a work-item type count src/domain does not have; WORK_ITEM_TYPES declares ${WORK_ITEM_TYPES.length}`)
  })
})

describe("the README's figures for treadle's own backlog are what .work holds", () => {
  // Counted off the committed records rather than through `treadle status`, because D1 makes
  // those files authoritative and reading them needs no index and no lock, so this file is
  // not racing another test file for the one workspace the repository keeps.
  const states = new Map<string, number>()
  const items = path.join(ROOT, '.work', 'items')
  for (const file of readdirSync(items)) {
    for (const line of readFileSync(path.join(items, file), 'utf8').split('\n')) {
      const match = /^state: ([a-z_]+)$/.exec(line)
      const state = match?.[1]
      if (state !== undefined) states.set(state, (states.get(state) ?? 0) + 1)
    }
  }
  const total = [...states.values()].reduce((sum, count) => sum + count, 0)
  const section = README.slice(README.indexOf("## treadle's own backlog"))

  it('states the number of items the workspace holds', () => {
    assert.equal(spelled(section, 'items'), total,
      `the README's "treadle's own backlog" section spells an item count .work does not hold; the records under .work/items carry ${total}`)
  })

  for (const state of ['done', 'ready', 'draft', 'cancelled']) {
    it(`states how many items are ${state}, the same in every sentence that says so`, () => {
      assert.equal(spelled(section, `(?:(?:that )?(?:is|are)|in) \`${state}\``), states.get(state) ?? 0,
        `the README's "treadle's own backlog" section spells a ${state} count .work does not hold; the records under .work/items carry ${states.get(state) ?? 0}`)
    })
  }
})

describe('the domain rule table names every rule id the domain raises, and no other', () => {
  // The ids a refusal prints are the closed set docs/DOMAIN.md publishes under "Rule ids".
  // Nothing held the two together: a rule added to the code and not the table, or kept in
  // the table after its code went, read as documentation either way.
  // `I5` is raised by the services, which is where a sprint id meets an item id, so the
  // application layer is scanned with the domain; `C`, `H` and `S` ids belong to other tables.
  const DOMAIN_PREFIXES = /^(G|T|R|P|I|V)\d+$/
  const raised = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      for (const match of readFileSync(full, 'utf8').matchAll(/'([A-Z]+\d+)'/g)) {
        const id = match[1]
        if (id !== undefined && DOMAIN_PREFIXES.test(id)) raised.add(id)
      }
    }
  }
  walk(path.join(ROOT, 'src', 'domain'))
  walk(path.join(ROOT, 'src', 'application'))
  const table = read('docs/DOMAIN.md')
  const start = table.indexOf('## Rule ids')
  const end = table.indexOf('\n## ', start + 1)
  const documented = new Set<string>()
  for (const row of table.slice(start, end).matchAll(/^\| `([A-Z]+\d+)` \|/gm)) {
    const id = row[1]
    if (id !== undefined && DOMAIN_PREFIXES.test(id)) documented.add(id)
  }
  const ordered = (ids: Iterable<string>): string[] => [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

  it('lists every id src/domain raises', () => {
    assert.deepEqual(ordered(raised).filter((id) => !documented.has(id)), [])
  })

  it('lists no id src/domain does not raise', () => {
    assert.deepEqual(ordered(documented).filter((id) => !raised.has(id)), [])
  })

  it('checks a set large enough to mean something', () => {
    assert.ok(raised.size >= 30, `only ${raised.size} domain rule ids were found in src/domain`)
  })
})

describe('the decision records name the rule ids the code raises', () => {
  it('lists every doctor finding the audit raises, and no id it does not', () => {
    const raised = new Set<string>()
    for (const match of read('src/application/services/doctor.ts').matchAll(/rule: '(H\d+)'/g)) {
      const id = match[1]
      if (id !== undefined) raised.add(id)
    }
    const documented = new Set<string>()
    for (const row of read('docs/architecture/adr/README.md').matchAll(/^\| `(H\d+)` \| ([^|]+)\|/gm)) {
      const id = row[1]
      if (id !== undefined && (row[2] ?? '').includes('`doctor`')) documented.add(id)
    }
    assert.deepEqual([...documented].sort(), [...raised].sort(),
      "docs/architecture/adr/README.md's rule table and the `rule: 'H<n>'` ids in src/application/services/doctor.ts name different findings; add the row or drop it")
  })
})

describe('the verification table counts what the suites actually drive', () => {
  it('reports the egress proof over every command in the inventory', () => {
    const row = read('docs/VERIFICATION.md')
      .split('\n')
      .find((line) => line.startsWith('| No network egress |'))
    assert.ok(row !== undefined, 'docs/VERIFICATION.md has no "No network egress" row')
    const commands = /(\d+) commands/.exec(row)?.[1]
    const entries = /(\d+) network entry points/.exec(row)?.[1]
    assert.ok(commands !== undefined, 'the row names no command count')
    assert.ok(entries !== undefined, 'the row names no network entry-point count')
    assert.equal(Number(commands), COMMANDS.length,
      `docs/VERIFICATION.md's "No network egress" row names a command count the inventory does not have; src/cli/inventory.ts declares ${COMMANDS.length}`)
    const traps = (read('test/security/no-egress.test.ts').match(/^ {2}trap\(/gm) ?? []).length
    assert.equal(Number(entries), traps,
      `docs/VERIFICATION.md's "No network egress" row names an entry-point count the suite does not trap; test/security/no-egress.test.ts traps ${traps}`)
  })
})

describe('every document states one runtime floor and one bundle budget', () => {
  const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node
  const floor = /(\d+\.\d+)/.exec(engines)?.[1] ?? engines

  for (const file of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/STABILITY.md']) {
    it(`${file} names Node.js ${floor} as the floor`, () => {
      const stated = [...read(file).matchAll(/Node\.js (\d+\.\d+)/g)].map((match) => match[1])
      assert.ok(stated.length > 0, `${file} states no Node.js version`)
      assert.deepEqual([...new Set(stated)], [floor],
        `${file} names a Node.js version other than package.json's floor of ${floor}; raise engines.node first, then every document that quotes it`)
    })
  }

  it('the README quotes the bundle budget bench/budgets.json arms, and credits its record', () => {
    const budgets = JSON.parse(read('bench/budgets.json')) as {
      absolute: Record<string, { limit: number; source: string } | undefined>
    }
    const bundle = budgets.absolute['bundleBytes']
    assert.ok(bundle !== undefined, 'bench/budgets.json has no absolute.bundleBytes budget')
    const limit = bundle.limit.toLocaleString('en-US')
    assert.ok(README.includes(`${limit} bytes`), `the README does not quote the ${limit} byte budget`)
    const record = /^([A-Z]+\d+)/.exec(bundle.source)?.[1]
    assert.ok(record !== undefined, `the budget's source ${bundle.source} names no design record`)
    assert.ok(
      README.includes(`as ${record}'s`) || README.includes(`${record}'s ${limit} bytes`),
      `the README credits the bundle budget to a record other than ${record}`,
    )
  })
})

// ---------------------------------------------------------------------------------------
// The sections above were written for the numbers that had already gone stale once. They
// left the rest of the surface unheld, which is how the `doctor` finding count and the
// axis count went on being edited by hand in four files apiece. What follows widens the
// same rule to every count in these documents that something in the tree decides.
//
// A count this file cannot reach is named in the report that added it rather than left
// looking checked: the suite's own test count and wall time are the two, because both are
// figures of a run rather than of a tree, and the last test below holds what can be held
// about them, which is that the README never prints one without the run it came from.
// ---------------------------------------------------------------------------------------

/** The line of `text` carrying `marker`, refused rather than skipped when there is none. */
function lineWith(file: string, text: string, marker: string): string {
  const line = text.split('\n').find((candidate) => candidate.includes(marker))
  assert.ok(line !== undefined, `${file} has no line containing ${JSON.stringify(marker)}`)
  return line
}

/** Every number word in one sentence, in the order it spells them. */
function spelledWords(text: string): readonly number[] {
  return [...text.matchAll(/\b([a-z]+)\b/gi)]
    .map((match) => (match[1] ?? '').toLowerCase())
    .filter((word) => word in NUMBER_WORDS)
    .map((word) => NUMBER_WORDS[word] as number)
}

/** Every `.ts` under `bench/` as one string, so an axis id is found wherever it is declared. */
function filesUnderBench(): string {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) parts.push(readFileSync(full, 'utf8'))
    }
  }
  walk(path.join(ROOT, 'bench'))
  return parts.join('\n')
}

const AGENTS = read('AGENTS.md')
const ARCHITECTURE = read('docs/ARCHITECTURE.md')
const BENCHMARKS = read('docs/BENCHMARKS.md')
const DOMAIN = read('docs/DOMAIN.md')

describe("every document that counts doctor's findings counts what doctor raises", () => {
  // The ADR table is already held to the same ids above. What was unheld is the number the
  // prose spells, which is why README and AGENTS.md both had to be edited by hand when H30
  // landed and why both said eleven for as long as nobody read them together.
  const raised = new Set([...read('src/application/services/doctor.ts')
    .matchAll(/rule: '(H\d+)'/g)].map((match) => match[1] as string))

  it('the README Status row spells the number of findings doctor.ts raises', () => {
    assert.equal(spelled(lineWith('README.md', README, '| `doctor`:'), 'findings'), raised.size,
      `the README's \`doctor\` Status row spells a finding count src/application/services/doctor.ts does not raise; it raises ${raised.size}: ${[...raised].join(', ')}`)
  })

  it('AGENTS.md spells the same number', () => {
    const said = /`doctor` raises ([a-z]+) of them/.exec(AGENTS)?.[1]
    assert.ok(said !== undefined && said in NUMBER_WORDS,
      'AGENTS.md has no sentence reading "`doctor` raises <number> of them"')
    assert.equal(NUMBER_WORDS[said], raised.size,
      `AGENTS.md spells a doctor finding count src/application/services/doctor.ts does not raise; it raises ${raised.size}`)
  })
})

describe('every document that counts the threat model counts the register', () => {
  // test/security/findings.test.ts is the register: a finding with a `test` is closed, one
  // with only a `waitingOn` is open. Four documents quote both numbers and none was held.
  const register = read('test/security/findings.test.ts')
  const findings = [...register.matchAll(/^ {2}\{ id: 'F\d+',(.*)$/gm)].map((match) => match[1] as string)
  const closed = findings.filter((entry) => entry.includes(" test: '"))

  for (const file of ['README.md', 'SECURITY.md', 'docs/PROVENANCE.md', 'AGENTS.md']) {
    it(`${file} spells the number of findings the register holds`, () => {
      const text = read(file)
      const line = text.split('\n').find((candidate) =>
        candidate.includes('threat model') && candidate.includes('findings'))
      assert.ok(line !== undefined, `${file} has no sentence about the threat model's findings`)
      assert.ok(spelledWords(line).includes(findings.length),
        `${file} counts the threat model's findings as ${spelledWords(line).join(' and ')}; test/security/findings.test.ts registers ${findings.length}`)
    })
  }

  it('the README says how many of them are closed', () => {
    const said = /([a-z]+) of the ([a-z]+) findings in the project's threat model are closed/i.exec(README)
    assert.ok(said !== null, "the README has no \"<n> of the <n> findings in the project's threat model are closed\" sentence")
    assert.deepEqual(
      [NUMBER_WORDS[(said[1] as string).toLowerCase()], NUMBER_WORDS[(said[2] as string).toLowerCase()]],
      [closed.length, findings.length],
      `the README says ${said[1]} of ${said[2]} threat-model findings are closed; the register has ${closed.length} of ${findings.length} naming a regression test`)
  })
})

describe('every document that counts the benchmark axes counts the rig', () => {
  // The axis set is whatever the rig emits an `axis:` for, measured or not; `remaining.ts`
  // is the not-measured half and reports through `notMeasured`, so the two numbers the
  // documents quote, the total and how many are measured, both come off the source.
  const axes = new Set([...filesUnderBench().matchAll(/axis: '(A\d+)'/g)].map((match) => match[1] as string))
  const unmeasured = [...read('bench/axes/remaining.ts').matchAll(/notMeasured\(\{/g)].length

  it('the acceptance bar in docs/BENCHMARKS.md is stated over every axis', () => {
    assert.equal(spelled(lineWith('docs/BENCHMARKS.md', BENCHMARKS, 'The acceptance bar for treadle'), 'axes'),
      axes.size, `docs/BENCHMARKS.md states the bar over an axis count the rig does not emit; bench/ emits ${axes.size}: ${[...axes].join(', ')}`)
  })

  it('every axis-table heading in docs/BENCHMARKS.md names the same total', () => {
    const headings = [...BENCHMARKS.matchAll(/^#{2,4} The ([a-z]+) (?:comparison )?axes$/gm)]
      .map((match) => (match[1] as string))
    assert.ok(headings.length > 0, 'docs/BENCHMARKS.md has no "The <number> axes" heading')
    assert.deepEqual([...new Set(headings.map((word) => NUMBER_WORDS[word]))], [axes.size],
      `an axis-table heading in docs/BENCHMARKS.md names a count the rig does not emit; bench/ emits ${axes.size}`)
  })

  it('docs/BENCHMARKS.md says how many of them were measured', () => {
    const said = /([a-z]+) of the ([a-z]+) are measured here/i.exec(BENCHMARKS)
    assert.ok(said !== null, 'docs/BENCHMARKS.md has no "<n> of the <n> are measured here" sentence')
    assert.deepEqual(
      [NUMBER_WORDS[(said[1] as string).toLowerCase()], NUMBER_WORDS[(said[2] as string).toLowerCase()]],
      [axes.size - unmeasured, axes.size],
      `docs/BENCHMARKS.md says ${said[1]} of ${said[2]} axes are measured; bench/axes/remaining.ts leaves ${unmeasured} of ${axes.size} unmeasured`)
  })

  it("the README's Status row counts the measured axes and the ones that are not", () => {
    const said = /([a-z]+) of the ([a-z]+) comparison axes measured, ([a-z]+) not/.exec(README)
    assert.ok(said !== null, 'the README has no "<n> of the <n> comparison axes measured, <n> not" row')
    assert.deepEqual(
      [1, 2, 3].map((group) => NUMBER_WORDS[(said[group] as string).toLowerCase()]),
      [axes.size - unmeasured, axes.size, unmeasured],
      `the README's Benchmarks row counts axes the rig does not emit; bench/ emits ${axes.size}, of which ${unmeasured} report NOT MEASURED`)
  })

  it('AGENTS.md counts the axes and the two that stay NOT MEASURED', () => {
    const total = /of the ([a-z]+) comparison axes/.exec(AGENTS)
    assert.ok(total !== null, 'AGENTS.md has no "<n> of the <n> comparison axes" sentence')
    assert.equal(NUMBER_WORDS[(total[1] as string).toLowerCase()], axes.size,
      `AGENTS.md names an axis count the rig does not emit; bench/ emits ${axes.size}`)
    const stays = /([A-Za-z]+) axes stay `NOT MEASURED`/.exec(AGENTS)
    assert.ok(stays !== null, 'AGENTS.md has no "<n> axes stay `NOT MEASURED`" sentence')
    assert.equal(NUMBER_WORDS[(stays[1] as string).toLowerCase()], unmeasured,
      `AGENTS.md names a NOT MEASURED count bench/axes/remaining.ts does not report; it reports ${unmeasured}`)
  })

  it('the README Documentation list names the same axis count', () => {
    assert.equal(spelled(lineWith('README.md', README, 'docs/BENCHMARKS.md](docs/BENCHMARKS.md)'), 'axes'),
      axes.size, `the README's Documentation entry for docs/BENCHMARKS.md names an axis count the rig does not emit; bench/ emits ${axes.size}`)
  })
})

describe('every document that counts the renderings counts the renderer seam', () => {
  it('the README and docs/ARCHITECTURE.md spell what RENDERINGS declares', () => {
    assert.equal(spelled(lineWith('README.md', README, '`bin/treadle.js` runs'), 'forms'), RENDERINGS.length,
      `the README's \`bin/treadle.js\` runs sentence names a rendering count src/adapters/render does not ship; RENDERINGS declares ${RENDERINGS.length}`)
    assert.equal(spelled(ARCHITECTURE, 'renderers'), RENDERINGS.length,
      `docs/ARCHITECTURE.md names a renderer count src/adapters/render does not ship; RENDERINGS declares ${RENDERINGS.length}`)
  })
})

describe('every document that counts the seams counts the seam table', () => {
  // The table in docs/ARCHITECTURE.md is the register; three documents quote its length.
  const section = ARCHITECTURE.slice(ARCHITECTURE.indexOf('\n## The '), ARCHITECTURE.indexOf('\n## Storage'))
  const seams = [...section.matchAll(/^\| [^|]+ \((?:built|not built|evaluator built)\) \|/gm)].length

  it('the table has as many rows as its own heading spells', () => {
    assert.ok(seams > 0, 'docs/ARCHITECTURE.md has no seam table')
    assert.equal(spelled(lineWith('docs/ARCHITECTURE.md', ARCHITECTURE, '## The '), 'seams'), seams,
      `docs/ARCHITECTURE.md's seam heading spells a number its own table does not carry; the table has ${seams} rows`)
  })

  for (const file of ['README.md', 'AGENTS.md', 'docs/ARCHITECTURE.md', 'docs/architecture/adr/README.md']) {
    it(`${file} spells the number of seams the table carries`, () => {
      assert.equal(spelled(read(file), 'seams'), seams,
        `${file} names a seam count docs/ARCHITECTURE.md's table does not carry; it has ${seams} rows`)
    })
  }
})

describe('the decision-record index names every record in the directory', () => {
  // A record added without a row reads as undecided, and a row left behind after a rename
  // is a dead link. Neither is visible in a diff of the other file.
  const dir = path.join(ROOT, 'docs', 'architecture', 'adr')
  const files = readdirSync(dir).filter((name) => /^\d{4}-.*\.md$/.test(name)).sort()
  const index = read('docs/architecture/adr/README.md')
  const linked = [...index.matchAll(/^\| \[ADR-\d{4}\]\(([^)]+)\)/gm)].map((match) => match[1] as string).sort()

  it('links every record file, and no file it does not hold', () => {
    assert.deepEqual(linked, files,
      'docs/architecture/adr/README.md links a different set of records than the directory holds; add the row or drop it')
  })
})

describe('docs/DOMAIN.md counts the closed sets the domain declares', () => {
  it('spells the number of states WORK_ITEM_STATES declares', () => {
    assert.equal(spelled(lineWith('docs/DOMAIN.md', DOMAIN, 'it flows through the same'), 'states'),
      WORK_ITEM_STATES.length,
      `docs/DOMAIN.md spells a state count src/domain does not declare; WORK_ITEM_STATES declares ${WORK_ITEM_STATES.length}`)
  })

  it('spells the number of parent pairs ALLOWED_PARENT_PAIRS declares', () => {
    assert.equal(spelled(DOMAIN, 'allowed type pairs'), ALLOWED_PARENT_PAIRS.length,
      `docs/DOMAIN.md spells a parent-pair count src/domain does not declare; ALLOWED_PARENT_PAIRS declares ${ALLOWED_PARENT_PAIRS.length}`)
  })

  it('spells the number of relation kinds RELATION_KINDS declares, and lists each with its inverse', () => {
    assert.equal(spelled(lineWith('docs/DOMAIN.md', DOMAIN, 'each with a defined inverse'), 'kinds'),
      RELATION_KINDS.length,
      `docs/DOMAIN.md spells a relation-kind count src/domain does not declare; RELATION_KINDS declares ${RELATION_KINDS.length}`)
    const section = DOMAIN.slice(DOMAIN.indexOf('| Kind | Inverse | Directional |'))
    const rows = [...section.slice(0, section.indexOf('\n\n')).matchAll(/^\| `([a-z_]+)` \| `[a-z_]+` \|/gm)]
      .map((match) => match[1] as string)
    assert.deepEqual(rows.sort(), [...RELATION_KINDS].sort(),
      "docs/DOMAIN.md's relation table names a different set of kinds than RELATION_KINDS declares")
  })

  for (const [gate, name] of [[DEFAULT_READY_GATE, 'ready'], [DEFAULT_DONE_GATE, 'done']] as const) {
    it(`lists every rule id the default ${name} gate carries, and no other`, () => {
      const heading = `Default ${name} gate:`
      const start = DOMAIN.indexOf(heading)
      assert.ok(start !== -1, `docs/DOMAIN.md has no "${heading}" table`)
      const end = DOMAIN.indexOf('\n\n', DOMAIN.indexOf('|---|', start))
      const documented = [...DOMAIN.slice(start, end).matchAll(/^\| `(DO[RD]\d+)` \| ([a-z]+) \|/gm)]
        .map((match) => [match[1] as string, match[2] as string] as const)
      assert.deepEqual(documented, gate.rules.map((rule) => [rule.id, rule.scope] as const),
        `docs/DOMAIN.md's default ${name} gate table names different rules or scopes than src/domain/gates.ts evaluates`)
    })
  }
})

describe('the README never prints a suite figure without the run it came from', () => {
  // The test count and the wall time are figures of a run, not of the tree: a count moves
  // with a parameterised loop and the seconds move with the machine, so no assertion here
  // can hold either against this checkout. What can be held is that they stay attributable,
  // which is the property that makes a stale one detectable by a reader instead of by luck.
  it('names the runtime and the date beside the count', () => {
    const line = lineWith('README.md', README, 'The suite ran ')
    assert.match(line, /The suite ran [\d,]+ tests in \d+ seconds on Node \d+\.\d+\.\d+ on \d{4}-\d{2}-\d{2}\b/,
      'the README states a suite figure without the runtime and the date it was measured on; a measurement this file cannot check has to carry its own conditions')
  })
})
