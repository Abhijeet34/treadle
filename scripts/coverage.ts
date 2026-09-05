#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The coverage gate. `npm run coverage` runs the suite under Node's own coverage, then holds
// the result to the table below and exits non-zero naming every miss with its number.
//
// The table is here rather than on the command line because a gate spread across a dozen
// flags is a gate nobody reads. Node applies `--test-coverage-lines` to the project as a
// whole and has no per-file threshold, and the interesting files are exactly the ones a
// project-wide average hides, so the per-file half is applied here from the lcov report.
//
// Zero dependencies, like everything else: `--experimental-test-coverage` and the built-in
// lcov reporter are the whole toolchain.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** The whole project, from the acceptance table this work was accepted against. */
const OVERALL = { lines: 90, branches: 85 }

/** The files a project-wide average would hide, and the bar each is held to. */
const CRITICAL = { lines: 95, branches: 90 }

/**
 * Each entry names one thing the acceptance table asked for and the file that is it. The
 * parser and the serializer are one file because DR3's grammar is one file in both
 * directions; the escaper is two, the class in the domain and the guards in the renderer.
 */
const CRITICAL_FILES: readonly (readonly [string, string])[] = [
  ['parser and serializer', 'src/adapters/store/grammar.ts'],
  ['state machine', 'src/domain/state-machine.ts'],
  ['escaper: the safe-text class', 'src/domain/text.ts'],
  ['escaper: the line grammar guards', 'src/adapters/render/grammar.ts'],
  ['path resolution: the workspace walk', 'src/adapters/workspace.ts'],
  ['path resolution: the store seam target', 'src/adapters/target.ts'],
  ['lock', 'src/adapters/store/lock.ts'],
]

type Counts = { lines: number; hitLines: number; branches: number; hitBranches: number; functions: number; hitFunctions: number }

function empty(): Counts {
  return { lines: 0, hitLines: 0, branches: 0, hitBranches: 0, functions: 0, hitFunctions: 0 }
}

/** LCOV, only the records this gate reads. `DA` is per line, `BRDA` per branch arm. */
function parseLcov(text: string): Map<string, Counts> {
  const files = new Map<string, Counts>()
  let current: Counts | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      current = empty()
      files.set(line.slice(3).trim(), current)
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('DA:')) {
      const hits = Number(line.slice(3).split(',')[1])
      current.lines += 1
      if (hits > 0) current.hitLines += 1
    } else if (line.startsWith('BRDA:')) {
      const taken = line.slice(5).split(',')[3]
      current.branches += 1
      if (taken !== '-' && Number(taken) > 0) current.hitBranches += 1
    } else if (line.startsWith('FNDA:')) {
      current.functions += 1
      if (Number(line.slice(5).split(',')[0]) > 0) current.hitFunctions += 1
    }
  }
  return files
}

function percent(hit: number, total: number): number {
  return total === 0 ? 100 : (hit * 100) / total
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function figure(hit: number, total: number): string {
  return `${percent(hit, total).toFixed(2).padStart(6)} (${hit}/${total})`
}

const work = mkdtempSync(path.join(tmpdir(), 'treadle-coverage-'))
const report = path.join(work, 'lcov.info')

const run = spawnSync(process.execPath, [
  '--experimental-test-coverage',
  '--test-reporter=dot', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', `--test-reporter-destination=${report}`,
  '--test-coverage-exclude=test/**', '--test-coverage-exclude=scripts/**',
  '--test-timeout=600000',
  '--test', 'test/**/*.test.ts',
], { stdio: 'inherit', encoding: 'utf8' })

if (run.status !== 0) {
  console.error(`\nthe suite failed (exit ${run.status}), so its coverage is not a measurement`)
  rmSync(work, { recursive: true, force: true })
  process.exit(run.status ?? 1)
}

const files = parseLcov(readFileSync(report, 'utf8'))
rmSync(work, { recursive: true, force: true })

const total = empty()
for (const counts of files.values()) {
  total.lines += counts.lines
  total.hitLines += counts.hitLines
  total.branches += counts.branches
  total.hitBranches += counts.hitBranches
  total.functions += counts.functions
  total.hitFunctions += counts.hitFunctions
}

const width = Math.max(...[...files.keys()].map((name) => name.length), 20)
console.log(`\n${pad('file', width)}  ${pad('line %', 16)}  ${pad('branch %', 16)}  func %`)
console.log('-'.repeat(width + 56))
for (const name of [...files.keys()].sort()) {
  const counts = files.get(name) as Counts
  console.log(
    `${pad(name, width)}  ${pad(figure(counts.hitLines, counts.lines), 16)}  ` +
    `${pad(figure(counts.hitBranches, counts.branches), 16)}  ${figure(counts.hitFunctions, counts.functions)}`,
  )
}
console.log('-'.repeat(width + 56))
console.log(
  `${pad('all files', width)}  ${pad(figure(total.hitLines, total.lines), 16)}  ` +
  `${pad(figure(total.hitBranches, total.branches), 16)}  ${figure(total.hitFunctions, total.functions)}`,
)

const misses: string[] = []
const hold = (what: string, counts: Counts, gate: { lines: number; branches: number }): void => {
  const lines = percent(counts.hitLines, counts.lines)
  const branches = percent(counts.hitBranches, counts.branches)
  if (lines < gate.lines) misses.push(`${what}: ${lines.toFixed(2)}% lines, under the ${gate.lines}% gate`)
  if (branches < gate.branches) misses.push(`${what}: ${branches.toFixed(2)}% branches, under the ${gate.branches}% gate`)
}

hold('overall', total, OVERALL)
for (const [what, file] of CRITICAL_FILES) {
  const counts = files.get(file)
  if (counts === undefined) {
    misses.push(`${what} (${file}): not in the coverage report at all`)
    continue
  }
  hold(`${what} (${file})`, counts, CRITICAL)
}

console.log(`\ngate: ${OVERALL.lines}% lines and ${OVERALL.branches}% branches overall, ${CRITICAL.lines}% and ${CRITICAL.branches}% on ${CRITICAL_FILES.length} named files`)
if (misses.length === 0) {
  console.log('every threshold met')
  process.exit(0)
}
for (const miss of misses) console.error(`MISS ${miss}`)
console.error(`\n${misses.length} threshold${misses.length === 1 ? '' : 's'} missed`)
process.exit(1)
