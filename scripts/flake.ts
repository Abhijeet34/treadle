#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The flake budget is zero, and this is how that is measured: `npm run flake` runs the whole
// suite N times in a row and reports the count that actually completed alongside the count
// that passed. Those two numbers are separate on purpose, because a run that was killed and
// a run that failed are different facts and a single "green" hides which happened.
//
// N defaults to 20 and `npm run flake -- 5` shortens it for a local check.
//
// Every run is a fresh process with a fresh temporary workspace per test, so nothing carries
// between them. If a run fails, its output is printed in full and the loop stops there: the
// first failure is the one worth reading, and nineteen more copies of it are not.

import { spawnSync } from 'node:child_process'

const RUNS = Number(process.argv[2] ?? 20)

if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error(`usage: npm run flake -- [runs]; got ${process.argv[2]}`)
  process.exit(2)
}

type Outcome = { readonly run: number; readonly passed: boolean; readonly ms: number; readonly tests: number }

const outcomes: Outcome[] = []
const started = Date.now()

for (let run = 1; run <= RUNS; run += 1) {
  const at = Date.now()
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-timeout=600000', 'test/**/*.test.ts'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const ms = Date.now() - at
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const tests = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0)
  const failed = Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? -1)
  const passed = result.status === 0 && failed === 0

  outcomes.push({ run, passed, ms, tests })
  console.log(`run ${String(run).padStart(2)} of ${RUNS}: ${passed ? 'pass' : 'FAIL'}  ${tests} tests  ${(ms / 1000).toFixed(1)}s`)

  if (!passed) {
    console.error(`\nrun ${run} failed (exit ${result.status}, ${failed} failing). Its output follows.\n`)
    console.error(output)
    break
  }
}

const completed = outcomes.length
const green = outcomes.filter((outcome) => outcome.passed).length
const counts = new Set(outcomes.map((outcome) => outcome.tests))
const seconds = (Date.now() - started) / 1000

console.log(`\n${completed} of ${RUNS} runs completed, ${green} green, ${completed - green} failed, in ${seconds.toFixed(0)}s`)
console.log(`test count per run: ${[...counts].join(', ')}`)

// A suite whose test count moves between runs is a flake even when every run is green: it
// means something decided at runtime how much to check, and an empty run would pass too.
if (counts.size > 1) {
  console.error('MISS the test count moved between runs, so the suite is not deciding the same work each time')
  process.exit(1)
}
if (green !== RUNS) {
  console.error(`MISS ${RUNS - green} of ${RUNS} runs did not pass`)
  process.exit(1)
}
console.log(`flake budget: 0 failures in ${RUNS} consecutive runs of ${[...counts][0]} tests`)
