// SPDX-License-Identifier: Apache-2.0
// Axis A12: every verb on both its success and its failure path.
//
// `test/cli/schemas.test.ts` validates golden result objects against the shipped schemas.
// What it does not do is drive the verb: the reference's defect (prior-art E9) was that the
// machine-readable flag existed on mutations only, that reads refused it with exit 2, and
// that errors were written to stdout. All three are properties of an invocation, so each verb
// here is invoked twice and scored on four things at once: which stream carried the object,
// which stream stayed empty, what the exit status was, and whether the object validates
// against the schema this repository ships for it.

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RESULT_CODES } from '../../src/application/result.ts'
import { COMMANDS } from '../../src/cli/inventory.ts'
import { validate } from '../../test/helpers/json-schema.ts'
import { crossCheck, openSurface, type CrossCheck, type Invocation } from './surface.ts'
import type { AxisResult } from './axis.ts'

const SCHEMAS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', 'schemas')

const CODES = new Set<string>(RESULT_CODES)

/** A path that is not a workspace, which is the failure every read verb can be given. */
const ABSENT = '/nonexistent/treadle-a12/.work'

type Case = {
  readonly verb: string
  readonly success: readonly string[]
  readonly failure: readonly string[]
  readonly why: string
}

function cases(empty: string, occupied: string): readonly Case[] {
  return [
    { verb: 'init', success: ['init', '--name', 'a12fresh', '--workspace', path.join(empty, '.work')], failure: ['init', '--workspace', occupied], why: 'a directory that already holds files and is not a workspace' },
    { verb: 'file', success: ['file', 'task', 'A12 filed a task', '--id', 'a12-filed'], failure: ['file', 'bug', 'A12 filed a bug with no severity'], why: 'a bug with none of the fields its type requires' },
    { verb: 'show', success: ['show', 'a12-seed'], failure: ['show', 'a12-absent'], why: 'an id no record carries' },
    { verb: 'backlog', success: ['backlog'], failure: ['backlog', '--fields', 'nosuch'], why: 'a column the list does not have' },
    { verb: 'transition', success: ['transition', 'a12-seed', 'ready'], failure: ['transition', 'a12-seed', 'done', '--reason', 'a12 attempted it'], why: 'a state no edge reaches from this one' },
    { verb: 'mark', success: ['mark', 'a12-seed', '--priority', '2', '--reason', 'a12 raised it'], failure: ['mark', 'a12-seed', '--severity', 'S9', '--reason', 'a12 tried it'], why: 'a severity outside the closed set' },
    { verb: 'evidence', success: ['evidence', 'add', 'a12-seed', 'run', '8813', '664 pass'], failure: ['evidence', 'add', 'a12-seed', 'bogus', '8813'], why: 'an evidence kind outside the closed set' },
    { verb: 'doctor', success: ['doctor'], failure: ['doctor', '--workspace', ABSENT], why: 'a workspace path that is not one' },
    { verb: 'next', success: ['next'], failure: ['next', '--workspace', ABSENT], why: 'a workspace path that is not one' },
    { verb: 'explain', success: ['explain', 'a12-seed'], failure: ['explain', 'a12-absent'], why: 'an id no record carries' },
    { verb: 'status', success: ['status'], failure: ['status', '--workspace', ABSENT], why: 'a workspace path that is not one' },
    { verb: 'help', success: ['help', 'transition'], failure: ['help', 'nosuchverb'], why: 'a topic that is not a command' },
    { verb: 'version', success: ['version'], failure: ['version', '--fields', 'id'], why: 'a flag the verb refuses rather than ignores' },
  ]
}

export type ContractRow = {
  readonly verb: string
  readonly path: 'success' | 'failure'
  readonly command: string
  readonly exit: number
  readonly stream: string
  readonly otherStreamEmpty: boolean
  readonly schema: string
  readonly code: string
  readonly validates: boolean
  readonly failures: readonly string[]
  readonly holds: boolean
}

export async function runA12(): Promise<{ readonly axis: AxisResult; readonly rows: readonly ContractRow[] }> {
  const surface = await openSurface('a12')
  const rows: ContractRow[] = []
  const parseLevel: { command: string; exit: number; rendered: string }[] = []
  let crossChecked: CrossCheck | undefined

  try {
    const seeded = await surface.run([
      'file', 'story', 'A12 seed story', '--id', 'a12-seed', '--points', '3', '--priority', '3',
      '--set', 'acceptance_criteria=the contract holds',
    ])
    if (seeded.code !== 0) throw new Error(`seed failed: ${seeded.err}`)

    const empty = path.join(surface.parent, 'a12-empty')
    const occupied = path.join(surface.parent, 'a12-occupied')
    await mkdir(empty, { recursive: true })
    await mkdir(occupied, { recursive: true })
    await writeFile(path.join(occupied, 'README.md'), 'a directory that is not a workspace\n')

    for (const entry of cases(empty, occupied)) {
      rows.push(score(entry.verb, 'success', await surface.run([...entry.success, '--out', 'json'])))
      rows.push(score(entry.verb, 'failure', await surface.run([...entry.failure, '--out', 'json'])))
    }
    // The one row that failed is a refusal the parser raises before the rendering is chosen,
    // so the scope of that is measured here rather than inferred from the single verb that
    // happened to hit it.
    for (const argv of [
      ['version', '--fields', 'id'],
      ['show', 'a12-seed', '--limit', '3'],
      ['nosuchverb'],
    ]) {
      const call = await surface.run([...argv, '--out', 'json'])
      parseLevel.push({
        command: [...argv, '--out', 'json'].join(' '),
        exit: call.code,
        rendered: call.err.startsWith('{') ? 'json, as asked' : 'the default rendering, not the one asked for',
      })
    }
    crossChecked = await crossCheck(await surface.run(['show', 'a12-seed', '--out', 'json']))
  } finally {
    await surface.dispose()
  }

  const notJson = parseLevel.filter((row) => !row.rendered.startsWith('json'))
  const held = rows.filter((row) => row.holds)
  const verbs = new Set(rows.map((row) => row.verb))
  const met = held.length === rows.length && verbs.size === COMMANDS.length

  return {
    rows,
    axis: {
      axis: 'A12',
      name: 'Output contract',
      metric: 'verbs with a machine-readable success object and a structured error on stderr',
      corpus: `all ${verbs.size} verbs in the command inventory, each on both paths, ${rows.length} invocations`,
      method: 'invoke each verb with a success and a failure input under --out json, and check the stream, the empty stream, the exit status and the shipped schema together',
      reference: 'mutations only; reads refuse the flag with exit 2; errors on stdout (prior-art E9)',
      target: 'every verb, both paths',
      verdict: met ? 'MET' : 'MISSED',
      observed: met
        ? `${held.length} of ${rows.length} invocations held the contract across ${verbs.size} verbs: every success object on stdout with exit 0 and an empty stderr, every failure object on stderr with a non-zero exit and an empty stdout, and every object valid against the schema this repository ships for it`
        : `${held.length} of ${rows.length} invocations held the contract across ${verbs.size} verbs; ${rows.filter((row) => !row.holds).map((row) => `${row.verb} ${row.path}`).join(', ')} did not, and ${notJson.length} of ${parseLevel.length} probed parse-level refusals ignored --out json because src/cli/main.ts raises them before the rendering is chosen`,
      operations: surface.calls(),
      samples: rows.length,
      detail: {
        rows,
        verbsInInventory: COMMANDS.length,
        schemasSeen: [...new Set(rows.map((row) => row.schema))].sort(),
        exitStatusesSeen: [...new Set(rows.map((row) => row.exit))].sort((a, b) => a - b),
        parseLevelRefusals: parseLevel,
        crossCheck: crossChecked ?? 'NOT MEASURED: the cross-check invocation did not run',
      },
    },
  }
}

function score(verb: string, which: 'success' | 'failure', call: Invocation): ContractRow {
  const text = which === 'success' ? call.out : call.err
  const other = which === 'success' ? call.err : call.out
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = undefined
  }

  const schema = typeof parsed?.['schema'] === 'string' ? parsed['schema'] : ''
  const code = typeof parsed?.['code'] === 'string' ? parsed['code'] : ''
  const [name, version] = schema.split('/')
  let failures: readonly string[] = ['no result object was written to the expected stream']
  if (name !== undefined && version !== undefined && parsed !== undefined) {
    const file = path.join(SCHEMAS, `${name}.v${version}.json`)
    const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    failures = validate(document, parsed).map((entry) => `${entry.path} ${entry.reason}`)
  }

  const validates = failures.length === 0
  const exitRight = which === 'success' ? call.code === 0 : call.code !== 0
  const shapeRight = which === 'success'
    ? parsed?.['ok'] === true && code === 'OK'
    : parsed?.['ok'] === false && CODES.has(code) && code !== 'OK'
      && typeof (parsed['data'] as Record<string, unknown> | undefined)?.['cause'] === 'string'
      && schema.startsWith('error/')

  return {
    verb,
    path: which,
    command: call.argv.join(' '),
    exit: call.code,
    stream: which === 'success' ? 'stdout' : 'stderr',
    otherStreamEmpty: other === '',
    schema,
    code,
    validates,
    failures,
    holds: validates && exitRight && shapeRight && other === '',
  }
}
