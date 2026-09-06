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

import { COMMANDS } from '../../src/cli/inventory.ts'
import { WORK_ITEM_TYPES } from '../../src/domain/index.ts'

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
