// SPDX-License-Identifier: Apache-2.0
// A workflow's YAML as a model an assertion can name a part of, without a YAML dependency.
//
// DR7 refused one at 686 KB for the record format, and these workflows only ever nest two
// levels deep, so the jobs and their steps are read by indentation. The point is that a test
// asserts about a job or a step rather than about a line found anywhere in the file: the
// `publish` job's permissions, not the word "write" somewhere; the release job's step order,
// not the order two substrings happen to appear in.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export type Step = {
  readonly name?: string
  /** The shell body of a `run:` step, joined, or undefined for a `uses:` step. */
  readonly run?: string
  readonly uses?: string
}

export type Job = {
  ifExpr?: string
  runsOn?: string
  environment?: string
  permissions: Record<string, string>
  uses: string[]
  steps: readonly Step[]
  text: string
}

function field(block: string, key: string): string | undefined {
  return new RegExp(`^ {4}${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim()
}

function permissionsOf(block: string): Record<string, string> {
  const section = /^ {4}permissions:\n((?: {6}.+\n?)+)/m.exec(`${block}\n`)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const line of section.split('\n')) {
    const kv = /^ {6}([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line)
    if (kv) out[kv[1] as string] = (kv[2] as string).trim()
  }
  return out
}

/**
 * The steps of one job, in order. A step opens at `      - `; everything more indented than
 * that belongs to it, which is what keeps a `run: |` body attached to its own step rather
 * than becoming a step of its own.
 *
 * Comment lines are dropped from the body. A comment sitting between two steps is indented
 * like the step above it and belongs to neither, and this repository's workflows put the
 * explanation of a step above that step: without this, `Build the bundle` carried the sentence
 * naming `scripts/release-preflight.ts` and matched a search for the step that runs it.
 */
function stepsOf(block: string): readonly Step[] {
  const at = block.split('\n').findIndex((line) => /^ {4}steps:\s*$/.test(line))
  if (at < 0) return []
  const steps: Step[] = []
  let current: { name?: string; uses?: string; body: string[] } | undefined
  const flush = (): void => {
    if (current === undefined) return
    const run = current.body.join('\n').trim()
    steps.push({
      ...(current.name === undefined ? {} : { name: current.name }),
      ...(current.uses === undefined ? {} : { uses: current.uses }),
      ...(run.length === 0 ? {} : { run }),
    })
  }
  for (const line of block.split('\n').slice(at + 1)) {
    if (/^ {0,5}\S/.test(line) && line.trim().length > 0) break
    const opener = /^ {6}- (.*)$/.exec(line)
    if (opener !== null) {
      flush()
      current = { body: [] }
    }
    if (current === undefined) continue
    const text = opener === null ? line : `        ${opener[1] as string}`
    const name = /^\s*name:\s*(.+)$/.exec(text)
    if (name !== null) { current.name = (name[1] as string).trim().replace(/^["']|["']$/g, ''); continue }
    const uses = /^\s*uses:\s*(\S+)/.exec(text)
    if (uses !== null) { current.uses = uses[1] as string; continue }
    if (text.trim().startsWith('#')) continue
    const run = /^\s*run:\s*(.*)$/.exec(text)
    if (run !== null) { current.body.push((run[1] as string).replace(/^\|-?$/, '')); continue }
    current.body.push(text.trim())
  }
  flush()
  return steps
}

/** A workflow's jobs, keyed by name, from its own YAML rather than a line found anywhere. */
export function parseWorkflow(text: string): Record<string, Job> {
  const jobsAt = text.split('\n').findIndex((line) => line === 'jobs:')
  assert.ok(jobsAt >= 0, 'workflow has no jobs: block')
  const jobs: Record<string, Job> = {}
  let name: string | undefined
  let buf: string[] = []
  const flush = (): void => {
    if (name === undefined) return
    const block = buf.join('\n')
    jobs[name] = {
      ifExpr: field(block, 'if'),
      runsOn: field(block, 'runs-on'),
      environment: field(block, 'environment'),
      permissions: permissionsOf(block),
      uses: [...block.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1] as string),
      steps: stepsOf(block),
      text: block,
    }
  }
  for (const line of text.split('\n').slice(jobsAt + 1)) {
    const header = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line)
    if (header) {
      flush()
      name = header[1]
      buf = []
    } else if (name !== undefined) {
      buf.push(line)
    }
  }
  flush()
  return jobs
}

/** One workflow of this repository, parsed. */
export function workflowOf(root: string, file: string): Record<string, Job> {
  return parseWorkflow(readFileSync(path.join(root, '.github', 'workflows', file), 'utf8'))
}
