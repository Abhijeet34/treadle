// SPDX-License-Identifier: Apache-2.0
// Threat-model findings F1 and F7: DR6 designed a hook as an executable named in a committed
// `workspace.md` and run on every mutation, which is clone-and-run code execution (F1), over a
// path with no traversal, symlink or argv rule (F7). ADR-0012 refuses that contract rather
// than gating it, so both findings close by having no surface, and this is what says so.
//
// A finding closed by absence needs a test more than one closed by a fix does: a fix is
// visible in the diff that made it, while an absence is undone by any later commit that adds
// an import nobody reads twice. The rule this file holds is an architecture rule, over
// source text: no module under src/ names an executing module in an import specifier, no
// module under src/ contains an eval-shaped call, and no module under src/ names a hook
// setting. That proves the rule was followed, not that nothing executes at runtime; the
// runtime claim is `f1-no-execution-at-runtime.test.ts`, which traps every entry point Node
// has for running a program or a string and drives every command with the traps live.
//
// What this does not cover: a generator that writes an executable for something else to run.
// That is F11, in f11-adapter-write-safety.test.ts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { codeOnly, ROOT, sources, specifiersOf, SRC } from '../helpers/src-scan.ts'

/** Every runtime module that can run something. `node:module` is not one: it resolves. */
const EXECUTING_MODULES: readonly string[] = ['child_process', 'worker_threads', 'vm', 'inspector', 'repl']

/** Ways to run a string that need no import at all. */
const EVALUATING: readonly (readonly [RegExp, string])[] = [
  [/\beval\s*\(/, 'evaluates a string'],
  [/\bnew\s+Function\s*\(/, 'compiles a string'],
  [/\bprocess\.binding\b/, 'reaches an internal binding'],
]

/**
 * A hook is configuration before it is an execution, so the setting is refused too. The tool
 * ignores unknown keys in `workspace.md` by design, and this is what keeps one from becoming
 * known again without ADR-0012 being argued with first.
 */
const HOOK_SETTING = /\bhooks?\b/i

const SCANNED = sources(SRC)

describe('no source file under src/ names anything that executes, which is what closes F1 and F7', () => {
  it('has sources to judge, so a pass is not vacuous', () => {
    assert.ok(SCANNED.length >= 20, `found ${SCANNED.length} sources under src/`)
  })

  it('recognises each forbidden shape when it is handed one', () => {
    const sample = "import { execFile } from 'node:child_process'\nconst f = new Function('return 1')\neval(x)\nprocess.binding('fs')\nconst h = config.hooks\n"
    assert.ok(EXECUTING_MODULES.some((mod) => sample.includes(`'node:${mod}'`)))
    for (const [pattern] of EVALUATING) assert.match(sample, pattern)
    assert.match(sample, HOOK_SETTING)
  })

  for (const file of SCANNED) {
    const rel = path.relative(ROOT, file)
    const text = codeOnly(readFileSync(file, 'utf8'))

    it(`${rel} names no executing module in an import specifier`, () => {
      for (const spec of specifiersOf(file)) {
        const bare = spec.startsWith('node:') ? spec.slice('node:'.length) : spec
        assert.ok(
          !EXECUTING_MODULES.includes(bare),
          `${rel} imports ${spec}: ADR-0012 refuses the hook contract, so no source file under src/ may name it`,
        )
      }
    })

    it(`${rel} contains no eval-shaped call and names no hook setting`, () => {
      for (const [pattern, what] of EVALUATING) {
        assert.ok(!pattern.test(text), `${rel} matches ${pattern}: it ${what}`)
      }
      assert.ok(
        !HOOK_SETTING.test(text),
        `${rel} names a hook setting: ADR-0012 removed hooks from v1, and a setting is where F1 starts`,
      )
    })
  }
})

describe('the two exit codes DR5 reserved for hooks stay out of the closed set', () => {
  it('names neither HOOK_REFUSED nor HOOK_FAILED anywhere under src/', () => {
    for (const file of SCANNED) {
      const text = readFileSync(file, 'utf8')
      assert.ok(!/HOOK_REFUSED|HOOK_FAILED/.test(text), `${path.relative(ROOT, file)} names a reserved hook code`)
    }
  })
})
