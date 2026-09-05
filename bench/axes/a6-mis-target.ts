// SPDX-License-Identifier: Apache-2.0
// Axis A6: commands that write to a store other than the one the human is looking at.
//
// The reference's failure (prior-art E2) is that one of three scenarios writes elsewhere and
// says nothing. All three are run here as writes at the command surface, with a decoy
// workspace beside the intended one, and the target is checked by reading both stores back
// rather than by trusting what the command printed.
//
// Two of the three had to be adapted, and the adaptation is the finding as much as the
// figure. This product reads no configuration file and no environment variable that can name
// a store, so the config scenario is run as the nearest-workspace rule under a decoy config
// file, and the environment scenario is run as five plausible override variables that must
// each move nothing. A scenario that cannot mis-target because the mechanism does not exist
// is a pass with a reason, not a pass by omission.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { resolveWorkspace } from '../../src/adapters/store/index.ts'
import type { Corpus } from '../corpus.ts'
import { dataOf, openSurface, resultOf, type Invocation } from './surface.ts'
import type { AxisResult } from './axis.ts'

/** Variables a caller might reasonably expect to redirect the store. None is read. */
const OVERRIDE_VARS = ['TREADLE_WORKSPACE', 'TREADLE_HOME', 'TREADLE_STORE', 'TREADLE_DIR', 'WORKSPACE'] as const

export type ScenarioRow = {
  readonly scenario: string
  readonly ran: string
  readonly command: string
  readonly exit: number
  readonly expected: string
  readonly landedIn: string
  readonly misTargeted: boolean
  readonly printedIdentity: string
  readonly printedPath: string
  /** True when the command invented a workspace in a directory that had none. */
  readonly createdAStore: boolean
}

export type SeamRow = {
  readonly scenario: string
  readonly resolved: string | null
  readonly expected: string | null
  readonly correct: boolean
}

export async function runA6(corpus: Corpus): Promise<{
  readonly axis: AxisResult
  readonly rows: readonly ScenarioRow[]
  readonly seam: readonly SeamRow[]
}> {
  const surface = await openSurface('a6')
  const rows: ScenarioRow[] = []
  let driven = 0

  try {
    const intended = surface.root
    const decoy = path.join(surface.parent, 'decoy')
    const nested = path.join(intended, 'src', 'deep')
    const unrelated = path.join(surface.parent, 'elsewhere')
    await mkdir(nested, { recursive: true })
    await mkdir(unrelated, { recursive: true })
    await mkdir(decoy, { recursive: true })
    const madeDecoy = await surface.run(['init', '--name', 'a6decoy'], { cwd: decoy })
    if (madeDecoy.code !== 0) throw new Error(`decoy init failed: ${madeDecoy.err}`)

    // A config file naming the decoy, in the directory above the one the command runs in.
    // Nothing reads it; the row exists so the claim is measured rather than assumed.
    const config = JSON.stringify({ workspace: path.join(decoy, '.work'), store: path.join(decoy, '.work') })
    for (const name of ['treadle.config.json', '.treadlerc']) {
      await writeFile(path.join(intended, name), `${config}\n`)
    }

    const write = async (
      scenario: string, ran: string, id: string,
      options: { cwd: string; env?: Record<string, string>; extra?: readonly string[]; expect?: 'intended' | 'decoy' | 'nowhere' },
    ): Promise<void> => {
      const argv = ['file', 'task', `A6 ${scenario}`, '--id', id, ...(options.extra ?? []), '--out', 'json']
      const call = await surface.run(argv, {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: { TREADLE_ACTOR: 'dana', ...options.env } }),
      })
      const created = (await readdir(options.cwd)).includes('.work')
        && options.cwd !== intended && options.cwd !== decoy
      const expect = options.expect ?? 'intended'
      rows.push({ ...await landing(surface, call, scenario, ran, id, intended, decoy, expect), createdAStore: created })
    }

    await write('cwd, from the workspace root', intended, 'a6-cwd-root', { cwd: intended })
    await write('cwd, from a subdirectory', nested, 'a6-cwd-nested', { cwd: nested })
    await write('cwd, from an unrelated directory', unrelated, 'a6-cwd-unrelated', { cwd: unrelated, expect: 'nowhere' })

    await write('config in parent, run from the subdirectory under a decoy config', nested, 'a6-config-nested', { cwd: nested })
    await write('config in parent, run from the root under a decoy config', intended, 'a6-config-root', { cwd: intended })

    for (const variable of OVERRIDE_VARS) {
      await write(
        `environment override, ${variable} naming the decoy`, intended,
        `a6-env-${variable.toLowerCase().replace(/_/g, '-')}`,
        { cwd: intended, env: { [variable]: path.join(decoy, '.work') } },
      )
    }

    // The one override this product does have. It moves the target on purpose, which is the
    // point of an explicit flag; the row is here so an explicit redirect is measured too.
    await write('the supported --workspace flag, run from the intended root', intended, 'a6-flag-decoy', {
      cwd: intended, extra: ['--workspace', path.join(decoy, '.work')], expect: 'decoy',
    })
    driven = surface.calls()
  } finally {
    await surface.dispose()
  }

  // The cwd scenario at the seam that owns resolution, kept from the earlier run so the
  // surface figure and the seam figure can be compared rather than one replacing the other.
  const seam = await seamRows(corpus)

  const explicit = rows.filter((row) => row.command.includes('--workspace'))
  const implicit = rows.filter((row) => !row.command.includes('--workspace'))
  const misTargets = rows.filter((row) => row.misTargeted)
  const invented = rows.filter((row) => row.createdAStore)
  const silent = rows.filter((row) => row.exit === 0 && row.printedIdentity === '')
  const seamWrong = seam.filter((row) => !row.correct).length
  const met = misTargets.length === 0 && silent.length === 0 && seamWrong === 0 && invented.length === 0

  return {
    rows,
    seam,
    axis: {
      axis: 'A6',
      name: 'Mis-target rate',
      metric: 'commands that write to a store other than the one the human is looking at',
      corpus: `${rows.length} writes at the command surface across the cwd, config-in-parent and environment-override scenarios, with a decoy workspace beside the intended one, plus ${seam.length} resolutions at the store seam`,
      method: 'run a write from each directory and under each override, then read both stores back to see where the record landed, and read the identity out of the result envelope',
      reference: '1 of 3 scenarios writes elsewhere silently (prior-art E2)',
      target: '0 of 3; every write prints the store identity',
      verdict: met ? 'MET' : 'MISSED',
      observed: met
        ? `0 mis-targets in ${implicit.length} writes with no explicit target, across all three scenarios; ${explicit.length} explicit --workspace write landed where it was pointed; ${seam.length} of ${seam.length} seam resolutions correct; no command invented a store; every write that landed printed the workspace identity in its envelope, while the filesystem path is printed by status, doctor and --preview but not by an applied write`
        : `${misTargets.length} of ${rows.length} writes mis-targeted, ${invented.length} invented a store, ${silent.length} printed no identity, ${seamWrong} of ${seam.length} seam resolutions wrong`,
      operations: driven + seam.length,
      samples: rows.length,
      detail: {
        rows,
        seam,
        environmentVariablesTried: OVERRIDE_VARS,
        note: 'this product reads no configuration file and no environment variable that names a store, so the config and environment scenarios are measured as the absence of that mechanism rather than as a redirect that has to be correct',
      },
    },
  }
}

/** Where the record actually is, read out of both stores rather than out of the output. */
async function landing(
  surface: { run: (argv: readonly string[], options?: { cwd?: string }) => Promise<Invocation> },
  call: Invocation, scenario: string, ran: string, id: string, intended: string, decoy: string,
  expected: 'intended' | 'decoy' | 'nowhere',
): Promise<Omit<ScenarioRow, 'createdAStore'>> {
  const data = dataOf(call)
  const result = resultOf(call)
  const inIntended = await holds(surface, intended, id)
  const inDecoy = await holds(surface, decoy, id)
  const landedIn = inIntended && inDecoy ? 'both' : inIntended ? 'intended' : inDecoy ? 'decoy' : 'nowhere'

  return {
    scenario,
    ran,
    command: call.argv.join(' '),
    exit: call.code,
    expected,
    landedIn,
    // A refusal that writes nothing is the correct answer outside a workspace; a write that
    // landed anywhere but where it was aimed is the reference's defect.
    misTargeted: landedIn !== expected,
    printedIdentity: typeof result?.['workspace'] === 'string' ? result['workspace'] : '',
    printedPath: typeof data['store'] === 'string' ? data['store'] : '',
  }
}

async function holds(
  surface: { run: (argv: readonly string[], options?: { cwd?: string }) => Promise<Invocation> },
  root: string, id: string,
): Promise<boolean> {
  const shown = await surface.run(['show', id, '--out', 'json'], { cwd: root })
  return shown.code === 0
}

async function seamRows(corpus: Corpus): Promise<readonly SeamRow[]> {
  const unrelated = await mkdtemp(path.join(tmpdir(), 'treadle-a6-seam-'))
  const scenarios = [
    { name: 'from the workspace root', from: corpus.root, expect: corpus.root },
    { name: 'from a subdirectory of the workspace', from: path.join(corpus.root, 'items'), expect: corpus.root },
    { name: 'from an unrelated directory', from: unrelated, expect: undefined },
  ]
  const rows: SeamRow[] = []
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
  return rows
}
