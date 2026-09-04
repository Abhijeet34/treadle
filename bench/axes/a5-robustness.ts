// SPDX-License-Identifier: Apache-2.0
// Axis A5: what a hand edit costs. Two hundred random line edits over the committed record
// files, plus the six damage shapes the prior-art table names as the reference's failures.
//
// The axis counts outcomes, not survivals. The three the target forbids are a silent drop
// (a record vanishes and nothing says so), a whole-store refusal (one bad line costs every
// record) and a crash. A refusal that names the record is the correct outcome and is counted
// as one, and an edit the store simply absorbed is counted separately so the denominator
// stays honest: a run of 200 edits that all landed in prose would prove nothing, and the
// per-outcome counts are what shows whether the corpus of damage bit.

import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { random } from '../../test/helpers/store-fixtures.ts'
import type { Corpus } from '../corpus.ts'
import type { AxisResult } from './axis.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUDIT = path.join(HERE, '..', 'children', 'audit.ts')

export type Outcome =
  | 'absorbed'
  | 'refusal names the record'
  | 'refusal names the file only'
  | 'silent drop'
  | 'whole-store refusal'
  | 'crash'

type Audit = {
  readonly listed: { ok: true; ids: string[] } | { ok: false; code: string; rule: string; message: string }
  readonly findings: readonly { file: string; line: number; rule: string; id?: string; reason: string }[]
  readonly findingsRefused: boolean
}

export type Case = {
  readonly label: string
  readonly file: string
  readonly line: number
  readonly edit: string
  readonly outcome: Outcome
  readonly missing: number
  readonly findings: number
  readonly detail?: string
}

function audit(root: string): { readonly audit?: Audit; readonly crash?: string } {
  const result = spawnSync(process.execPath, [AUDIT, root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
  if (result.error !== undefined) return { crash: result.error.message }
  if (result.status !== 0) return { crash: `exit ${result.status}: ${(result.stderr || '').trim().slice(0, 300)}` }
  const line = (result.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (line === undefined) return { crash: `no report on stdout: ${(result.stdout || '').trim().slice(0, 200)}` }
  return { audit: JSON.parse(line) as Audit }
}

function classify(baseline: ReadonlySet<string>, result: { audit?: Audit; crash?: string }, file: string): Omit<Case, 'label' | 'file' | 'line' | 'edit'> {
  if (result.crash !== undefined) {
    return { outcome: 'crash', missing: -1, findings: -1, detail: result.crash }
  }
  const found = result.audit as Audit
  if (!found.listed.ok) {
    return { outcome: 'whole-store refusal', missing: baseline.size, findings: found.findings.length, detail: `${found.listed.code} ${found.listed.rule}: ${found.listed.message}` }
  }
  const now = new Set(found.listed.ids)
  const missing = [...baseline].filter((id) => !now.has(id))
  if (missing.length === 0) {
    return { outcome: 'absorbed', missing: 0, findings: found.findings.length }
  }
  const named = new Set(found.findings.filter((f) => f.id !== undefined).map((f) => f.id as string))
  const unnamed = missing.filter((id) => !named.has(id))
  if (unnamed.length === 0) {
    return { outcome: 'refusal names the record', missing: missing.length, findings: found.findings.length }
  }
  // A finding at line 1 of the damaged file names the file and not the record it lost. That
  // is a weaker outcome than the target asks for but it is not silent, so it is its own row.
  const fileLevel = found.findings.some((f) => f.file === file && f.id === undefined)
  if (fileLevel) {
    return {
      outcome: 'refusal names the file only',
      missing: missing.length,
      findings: found.findings.length,
      detail: found.findings.find((f) => f.file === file && f.id === undefined)?.reason.slice(0, 200),
    }
  }
  return { outcome: 'silent drop', missing: missing.length, findings: found.findings.length, detail: `${unnamed.length} of ${missing.length} lost records are named by no finding, first: ${unnamed[0]}` }
}

type Edit = { readonly kind: string; readonly apply: (lines: string[], at: number, next: () => number) => void }

const RANDOM_EDITS: readonly Edit[] = [
  { kind: 'delete the line', apply: (lines, at) => { lines.splice(at, 1) } },
  { kind: 'duplicate the line', apply: (lines, at) => { lines.splice(at, 0, lines[at] as string) } },
  { kind: 'truncate the line', apply: (lines, at, next) => { const l = lines[at] as string; lines[at] = l.slice(0, Math.floor(next() * l.length)) } },
  { kind: 'replace one character', apply: (lines, at, next) => { const l = lines[at] as string; if (l.length === 0) return; const i = Math.floor(next() * l.length); lines[at] = `${l.slice(0, i)}§${l.slice(i + 1)}` } },
  { kind: 'insert a junk line', apply: (lines, at) => { lines.splice(at, 0, 'this line was typed by a person and belongs to no field') } },
  { kind: 'blank the line', apply: (lines, at) => { lines[at] = '' } },
  { kind: 'swap two lines', apply: (lines, at) => { if (at + 1 >= lines.length) return; const a = lines[at] as string; lines[at] = lines[at + 1] as string; lines[at + 1] = a } },
]

async function shardFiles(root: string): Promise<readonly string[]> {
  const dir = path.join(root, 'items')
  return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort().map((f) => path.join('items', f))
}

export async function runA5(corpus: Corpus, workDir: string, editCount: number, seed: number): Promise<AxisResult> {
  const pristine = path.join(workDir, 'a5-pristine')
  await rm(pristine, { recursive: true, force: true })
  await cp(corpus.root, pristine, { recursive: true })

  const before = audit(pristine)
  if (before.audit === undefined || !before.audit.listed.ok) {
    return {
      axis: 'A5', name: 'Malformed-input robustness',
      metric: 'silent drops and whole-store refusals across a mutation corpus',
      corpus: `${corpus.itemsInStore} items`, method: 'baseline read of the undamaged copy',
      reference: 'heading rename: silent drop; bad metadata line: whole-store refusal; duplicate id: silent; self-edge: silent; cycle: accepted',
      target: 'zero silent drops, zero whole-store refusals, every refusal names the record',
      verdict: 'NOT MEASURED',
      observed: `NOT MEASURED: the undamaged copy did not read back: ${before.crash ?? 'list refused'}`,
      operations: 0, samples: 0,
    }
  }
  const baseline = new Set(before.audit.listed.ids)
  const files = await shardFiles(pristine)
  const next = random(seed)
  const cases: Case[] = []
  const scratch = path.join(workDir, 'a5-case')

  const run = async (label: string, mutate: (root: string) => Promise<{ file: string; line: number; edit: string }>): Promise<void> => {
    await rm(scratch, { recursive: true, force: true })
    await cp(pristine, scratch, { recursive: true })
    const where = await mutate(scratch)
    cases.push({ label, ...where, ...classify(baseline, audit(scratch), where.file) })
  }

  for (let i = 0; i < editCount; i += 1) {
    await run('random line edit', async (root) => {
      const file = files[Math.floor(next() * files.length)] as string
      const full = path.join(root, file)
      const lines = (await readFile(full, 'utf8')).split('\n')
      const at = Math.floor(next() * lines.length)
      const edit = RANDOM_EDITS[Math.floor(next() * RANDOM_EDITS.length)] as Edit
      edit.apply(lines, at, next)
      await writeFile(full, lines.join('\n'))
      return { file, line: at + 1, edit: edit.kind }
    })
  }

  for (const shaped of shapedCases(files, next)) {
    await run(shaped.label, shaped.mutate)
  }

  await rm(scratch, { recursive: true, force: true })
  await rm(pristine, { recursive: true, force: true })

  const counts = new Map<Outcome, number>()
  for (const c of cases) counts.set(c.outcome, (counts.get(c.outcome) ?? 0) + 1)
  const forbidden = (counts.get('silent drop') ?? 0) + (counts.get('whole-store refusal') ?? 0) + (counts.get('crash') ?? 0)
  const fileOnly = counts.get('refusal names the file only') ?? 0

  return {
    axis: 'A5',
    name: 'Malformed-input robustness',
    metric: 'silent drops and whole-store refusals across a mutation corpus',
    corpus: `${corpus.itemsInStore} items in ${files.length} record files, one damaged copy per case`,
    method: `${editCount} seeded random line edits (seed ${seed}) plus ${cases.length - editCount} shaped cases; each damaged copy read by a separate process and every record that vanished checked against the findings`,
    reference: 'heading rename: silent drop; bad metadata line: whole-store refusal; duplicate id: silent; self-edge: silent; cycle: accepted',
    target: 'zero silent drops, zero whole-store refusals, every refusal names the record',
    verdict: forbidden > 0 ? 'MISSED' : fileOnly > 0 ? 'PARTIAL' : 'MET',
    observed: `${cases.length} damaged stores read: ${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')}`,
    operations: cases.length,
    samples: cases.length,
    detail: {
      counts: Object.fromEntries(counts),
      shaped: cases.filter((c) => c.label !== 'random line edit'),
      offenders: cases.filter((c) => c.outcome === 'silent drop' || c.outcome === 'whole-store refusal' || c.outcome === 'crash').slice(0, 20),
      fileOnlyExamples: cases.filter((c) => c.outcome === 'refusal names the file only').slice(0, 5),
    },
  }
}

/**
 * The five damage shapes the prior-art table names as the reference's failures, plus a
 * truncated file. They are reconstructed from that table's own description of each failure;
 * the reference's transcripts are quarantined and were not read.
 */
function shapedCases(files: readonly string[], next: () => number): readonly {
  readonly label: string
  readonly mutate: (root: string) => Promise<{ file: string; line: number; edit: string }>
}[] {
  const pick = (): string => files[Math.floor(next() * files.length)] as string
  const edit = async (
    root: string, file: string, change: (lines: string[]) => number,
  ): Promise<{ file: string; line: number; edit: string }> => {
    const full = path.join(root, file)
    const lines = (await readFile(full, 'utf8')).split('\n')
    const line = change(lines)
    await writeFile(full, lines.join('\n'))
    return { file, line, edit: 'shaped' }
  }
  const headingAt = (lines: readonly string[], from = 0): number => lines.findIndex((l, i) => i >= from && l.startsWith('# '))

  return [
    {
      label: 'heading renamed out of the grammar',
      mutate: (root) => edit(root, pick(), (lines) => {
        const at = headingAt(lines)
        lines[at] = (lines[at] as string).replace(/^# /, '## ')
        return at + 1
      }),
    },
    {
      label: 'metadata line that parses as no field',
      mutate: (root) => edit(root, pick(), (lines) => {
        const at = headingAt(lines)
        lines.splice(at + 1, 0, 'priority: not a number at all')
        return at + 2
      }),
    },
    {
      label: 'duplicate id in one file',
      mutate: (root) => edit(root, pick(), (lines) => {
        const first = headingAt(lines)
        const second = headingAt(lines, first + 1)
        lines[second] = lines[first] as string
        return second + 1
      }),
    },
    {
      label: 'parent_id pointing at the record itself',
      mutate: (root) => edit(root, pick(), (lines) => {
        const at = headingAt(lines)
        const id = (lines[at] as string).slice(2).split(':')[0]?.trim()
        lines.splice(at + 1, 0, `parent_id: ${id}`)
        return at + 2
      }),
    },
    {
      label: 'two-record parent cycle',
      mutate: (root) => edit(root, pick(), (lines) => {
        const first = headingAt(lines)
        const second = headingAt(lines, first + 1)
        const idOf = (at: number): string => (lines[at] as string).slice(2).split(':')[0]?.trim() as string
        const a = idOf(first)
        const b = idOf(second)
        lines.splice(second + 1, 0, `parent_id: ${a}`)
        lines.splice(first + 1, 0, `parent_id: ${b}`)
        return first + 2
      }),
    },
    {
      label: 'file truncated mid-record',
      mutate: (root) => edit(root, pick(), (lines) => {
        const keep = Math.max(3, Math.floor(lines.length * 0.6))
        lines.length = keep
        return keep
      }),
    },
  ]
}
