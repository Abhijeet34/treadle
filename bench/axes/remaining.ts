// SPDX-License-Identifier: Apache-2.0
// The seven axes this rig cannot fill yet, each carrying the method it will be measured by so
// the next task inherits a harness rather than a paragraph.
//
// Every one of them is NOT MEASURED with the reason stated. None is estimated, interpolated
// or left out, because a table with a gap in it reads as a pass to whoever skims it.
//
// A6 is the exception and is PARTIAL: its first scenario is a store resolution, which the
// store seam already owns, so that scenario is really measured here and the other two are
// named as still missing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { resolveWorkspace } from '../../src/adapters/store/index.ts'
import type { Corpus } from '../corpus.ts'
import { notMeasured, type AxisResult } from './axis.ts'

// The command layer landed in #3 while this rig was being built, which is what let axis A3
// move out of this file. What remains needs more than a rendered artefact: a scored question
// set, a driven transition, an attempt per state pair, a metrics layer.
const COMMAND_LAYER = 'the command surface exists since #3, but this axis needs a harness that drives it: nothing here scores it yet'

/**
 * A6's cwd scenario at the seam that owns it. The store is resolved by walking up from a
 * directory and is never created, so a run from a subdirectory must find the same workspace
 * and a run from an unrelated directory must find none rather than inventing one.
 */
export async function runA6(corpus: Corpus): Promise<AxisResult> {
  const unrelated = await mkdtemp(path.join(tmpdir(), 'treadle-a6-'))
  const scenarios = [
    { name: 'from the workspace root', from: corpus.root, expect: corpus.root },
    { name: 'from a subdirectory of the workspace', from: path.join(corpus.root, 'items'), expect: corpus.root },
    { name: 'from an unrelated directory', from: unrelated, expect: undefined },
  ]
  const rows = []
  for (const scenario of scenarios) {
    const resolved = await resolveWorkspace(scenario.from)
    rows.push({
      scenario: scenario.name,
      resolved: resolved ?? null,
      expected: scenario.expect ?? null,
      correct: resolved === scenario.expect,
    })
  }
  await rm(unrelated, { recursive: true, force: true })
  const wrong = rows.filter((r) => !r.correct).length

  return {
    axis: 'A6',
    name: 'Mis-target rate',
    metric: 'commands that write to a store other than the one the human is looking at',
    corpus: 'the cwd scenario plus config-in-parent and env-override scenarios',
    method: 'store resolution from the root, a subdirectory and an unrelated directory; the other two scenarios need a config file and an environment override',
    reference: '1 of 3 scenarios writes elsewhere silently (prior-art E2)',
    target: '0 of 3; every write prints the store identity',
    verdict: 'PARTIAL',
    observed: wrong === 0
      ? `cwd scenario: 3 of 3 resolutions correct, 0 mis-targets. The identity half of the target, and the config and environment scenarios, are NOT MEASURED: they need ${COMMAND_LAYER}`
      : `cwd scenario: ${wrong} of 3 resolutions wrong`,
    operations: rows.length,
    samples: rows.length,
    detail: { rows },
    blockedOn: COMMAND_LAYER,
  }
}

/** The seven axes with nothing this rig can reach yet, each with its method kept. */
export function remainingAxes(): readonly AxisResult[] {
  return [
    notMeasured({
      axis: 'A2', name: 'Question coverage',
      metric: 'questions answerable with one command, out of a fixed 25-question scrum-master set',
      corpus: 'the 25 questions in the prior-art axes table',
      method: 'one command per question, scored full, partial or none',
      reference: '4 full, 6 partial, 15 none',
      target: '25 full',
      reason: `the 25 questions have to be put to the command surface one at a time and scored full, partial or none; ${COMMAND_LAYER}`,
      blockedOn: COMMAND_LAYER,
    }),
    notMeasured({
      axis: 'A7', name: 'Audit answerability',
      metric: '"why is item X in state S" answered with event evidence',
      corpus: '50 items driven through 200 random legal transitions',
      method: 'count items whose current state is explained by an event chain',
      reference: '0 of 50, the reference keeps no history',
      target: '50 of 50',
      reason: `this needs 50 items driven through 200 random legal transitions and each chain read back; ${COMMAND_LAYER}`,
      blockedOn: COMMAND_LAYER,
    }),
    notMeasured({
      axis: 'A8', name: 'Lifecycle enforcement',
      metric: 'illegal transitions refused with a rule name',
      corpus: 'every ordered pair of states',
      method: 'attempt each pair and read the refusal',
      reference: '0 refused of 6 illegal pairs tried (prior-art E8)',
      target: 'every illegal pair refused with a guard id',
      reason: `src/domain/state-machine.ts holds the rule table and test/domain/state-machine.test.ts exercises it, but the axis scores every ordered state pair through the command surface and reads the printed guard id; ${COMMAND_LAYER}`,
      blockedOn: COMMAND_LAYER,
    }),
    notMeasured({
      axis: 'A9', name: 'Metric coverage',
      metric: 'metrics computable with an exact printed formula',
      corpus: 'the fourteen flow metrics in the domain model',
      method: 'run each on a seeded store and compare against a spreadsheet',
      reference: '0 of 14',
      target: '14 of 14, each matching the spreadsheet',
      reason: 'no metric is implemented in this tree; nothing under src computes velocity, cycle time or a burndown series',
      blockedOn: 'the metrics layer, which no landed commit begins',
    }),
    notMeasured({
      axis: 'A10', name: 'Type validation',
      metric: 'invalid creations refused',
      corpus: 'one invalid record per type per rule, eleven rules',
      method: 'attempt each creation and read the refusal',
      reference: '0 of 11 refused, the reference has a single free-text kind',
      target: '11 of 11',
      reason: `src/domain/fields.ts refuses these today and the domain suite covers them, but the axis scores one invalid creation per rule at the surface; ${COMMAND_LAYER}`,
      blockedOn: COMMAND_LAYER,
    }),
    notMeasured({
      axis: 'A11', name: 'Harness neutrality',
      metric: "files under a harness's home directory the tool writes or requires",
      corpus: 'the three harness homes the reference knows',
      method: 'run the full feature set with no harness present and count files written',
      reference: 'setup writes 4 files across 3 harnesses',
      target: '0 required; adapters optional and generated',
      reason: 'this needs the full feature set run with no harness present and the files it wrote counted, and there is no adapter generator to score; the store writes only inside the workspace directory, which is a property this rig does not yet assert',
      blockedOn: COMMAND_LAYER,
    }),
    notMeasured({
      axis: 'A12', name: 'Output contract',
      metric: 'verbs with a machine-readable success object and a structured error on stderr',
      corpus: 'every verb',
      method: 'invoke each verb with a success and a failure input and validate both against the shipped schema',
      reference: 'mutations only; reads refuse the flag with exit 2; errors on stdout (prior-art E9)',
      target: 'every verb, both paths',
      reason: `schemas/ carries eleven schemas since #3 and test/cli/schemas.test.ts validates against them, but the axis scores every verb on both its success and its failure path; ${COMMAND_LAYER}`,
      blockedOn: COMMAND_LAYER,
    }),
  ]
}
