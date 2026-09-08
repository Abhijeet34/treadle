// SPDX-License-Identifier: Apache-2.0
// N1: from PR #66 until this file existed, every push to main failed the Release workflow at
// startup with GitHub's own message, "The nested job 'codeql' is requesting
// 'security-events: write', but is only allowed 'security-events: none'." A called workflow's
// permission requests are validated against the caller's grant before any `if` is evaluated,
// so the `if: github.event_name != 'workflow_call'` guard on that job stopped nothing: the run
// never started, `release-pr` never ran, and release-please stopped maintaining the release
// pull request.
//
// actionlint does not check this, and nothing else in the tree read one workflow against
// another. So the caller-to-called permission arithmetic is done here, over the real files.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { parseWorkflow } from '../helpers/workflow.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKFLOWS = path.join(ROOT, '.github', 'workflows')

/** GitHub's three levels, ordered, so "does the grant cover the request" is one comparison. */
const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 }

type Grant = Record<string, string>

function read(file: string): string {
  return readFileSync(path.join(WORKFLOWS, file), 'utf8').replaceAll('\r\n', '\n')
}

/**
 * A workflow's top-level `permissions:`. `read-all` and `write-all` are returned as the two
 * sentinels below rather than expanded: no workflow here uses them, and a wrong expansion of
 * GitHub's scope list would be a silent hole in this gate rather than a visible gap.
 */
function workflowPermissions(text: string): Grant | 'all' | undefined {
  const inline = /^permissions:[ \t]*(\S.*)$/m.exec(text)?.[1]?.trim()
  if (inline === 'read-all' || inline === 'write-all') return 'all'
  if (inline !== undefined) return {}
  const block = /^permissions:\n((?:[ \t]+\S.*\n)+)/m.exec(`${text}\n`)?.[1]
  if (block === undefined) return undefined
  const out: Grant = {}
  for (const line of block.split('\n')) {
    const kv = /^\s+([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line)
    if (kv) out[kv[1] as string] = (kv[2] as string).trim()
  }
  return out
}

/** Every `uses: ./.github/workflows/<file>` in a job, which is what a workflow call looks like. */
function calls(uses: readonly string[]): readonly string[] {
  return uses
    .filter((ref) => ref.startsWith('./.github/workflows/'))
    .map((ref) => path.basename(ref.split('@')[0] as string))
}

describe('a called workflow cannot request more than its caller grants', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))

  it('checks every local workflow call in the tree', () => {
    const pairs: string[] = []
    for (const file of files) {
      const text = read(file)
      const caller = workflowPermissions(text)
      for (const [job, model] of Object.entries(parseWorkflow(text))) {
        for (const called of calls(model.uses)) {
          pairs.push(`${file}:${job} -> ${called}`)

          // The job's own block wins; without one the called workflow gets the caller
          // workflow's grant. A caller that declares neither leaves this unknowable from the
          // tree alone, because the repository's default token permission decides it.
          //
          // `permissions: {}` on one line grants nothing, and the block parser reports it the
          // same way it reports an absent block, so it is read off the job's own text: without
          // this, the strictest grant a caller can write would fall through to the loosest.
          const inlineOnJob = /^ {4}permissions:[ \t]*\S/m.test(model.text)
          const declared =
            Object.keys(model.permissions).length > 0 || inlineOnJob ? model.permissions : caller
          assert.notEqual(
            declared,
            undefined,
            `${file} job '${job}' calls ${called} and neither the job nor the workflow declares permissions:`,
          )
          if (declared === 'all') continue
          const grant = declared as Grant

          const target = read(called)
          const requests: { readonly where: string; readonly scopes: Grant }[] = []
          const top = workflowPermissions(target)
          if (top !== undefined && top !== 'all') requests.push({ where: called, scopes: top })
          for (const [nested, nestedModel] of Object.entries(parseWorkflow(target))) {
            requests.push({ where: nested, scopes: nestedModel.permissions })
          }

          for (const request of requests) {
            for (const [scope, want] of Object.entries(request.scopes)) {
              const allowed = grant[scope] ?? 'none'
              assert.ok(
                (LEVEL[want] ?? 2) <= (LEVEL[allowed] ?? 0),
                // GitHub's own wording, so a failure here reads as the startup failure it
                // prevents rather than as a test with an opinion.
                `The nested job '${request.where}' is requesting '${scope}: ${want}', but is only ` +
                  `allowed '${scope}: ${allowed}'. ${file} job '${job}' calls ${called}.`,
              )
            }
          }
        }
      }
    }
    assert.ok(pairs.length > 0, 'no local workflow call was found, so this gate checked nothing')
    console.log(`checked ${pairs.length} workflow call(s) across ${files.length} workflows: ${pairs.join(', ')}`)
  })
})
