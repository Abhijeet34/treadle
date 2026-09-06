// SPDX-License-Identifier: Apache-2.0
// This product's stated purpose is to work with any agent on any harness, and AGENTS.md is
// the cross-harness convention that carries the content. A repository root that also holds a
// file named for one harness, with no equivalent for any other, tells a reader which harness
// the project is really for, whatever AGENTS.md says.
//
// The rule is a test rather than a convention because it has already failed once as a
// convention. `CLAUDE.md` arrived with the scaffold in #1, was deliberately removed in #19,
// and came back in #26 as two insertions in a branch rebuilt after a stranded-branch
// incident. A conflict resolution reverted a decision and nothing was watching.
//
// A test is what closes that, and it is closed by the guard that already lives outside the
// branch: `tests kept` is a required context named in .github/rulesets/main.json, and it
// refuses a pull request that drops a test title main has unless a `Removes-test:` trailer
// declares it. So a resolution that took a pre-rebase tree whole would have to delete these
// titles, and deleting them is the one thing the branch cannot do quietly. No second CI job
// and no second required context buys anything the first one does not already hold.
//
// ADR-0019 argues the rule and the list.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Refused at the repository root, lower-cased for comparison. Each name is a file some named
 * agent product loads by itself from the root of a repository, which is the property that
 * makes it harness-specific; a reader who sees one knows which harness the project expects.
 *
 * The list is closed and grows one line at a time, on purpose. It is not a search for vendor
 * names: .github/ is the forge's own directory and this repository commits GitHub-specific
 * configuration in it deliberately, README.md and CONTRIBUTING.md are addressed to people and
 * no harness loads them, and a rule that read file content for a product name would flag
 * AGENTS.md's own prose and the decision record that argues this rule.
 */
const REFUSED: readonly string[] = [
  'claude.md',
  'gemini.md',
  'qwen.md',
  'agent.md',
  'copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.aiderrules',
  '.goosehints',
  '.continuerules',
]

/** The tracked files at the root, which is every tracked path carrying no separator. */
function trackedRootFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file.length > 0 && !file.includes('/'))
}

describe('no harness-specific instruction file sits at the repository root', () => {
  const root = trackedRootFiles()

  it('found tracked files at the root, so a pass is not vacuous', () => {
    assert.ok(root.length >= 8, `only ${root.length} tracked files at the root`)
  })

  it('AGENTS.md is the one agent-instruction file, and it is present', () => {
    assert.ok(root.includes('AGENTS.md'), 'AGENTS.md is the cross-harness convention and is missing')
  })

  it('names no file a single agent product loads by itself', () => {
    const found = root.filter((file) => REFUSED.includes(file.toLowerCase()))
    assert.deepEqual(
      found,
      [],
      `${found.join(', ')} names one harness at the repository root.\n` +
      'Put the content in AGENTS.md, which every harness can be pointed at, and delete the file.\n' +
      'ADR-0019 argues why, and CLAUDE.md has already been added twice in good faith.',
    )
  })
})
