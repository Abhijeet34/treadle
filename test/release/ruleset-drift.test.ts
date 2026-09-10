// SPDX-License-Identifier: Apache-2.0
// `.github/rulesets/` described what GitHub was meant to enforce and nothing read back what it
// actually enforced. The two fixtures below are the real responses, recorded on 2026-09-10
// from https://api.github.com/repos/Abhijeet34/treadle/rulesets/{22316869,22314350}, and each
// carries a drift that had been live and unseen: a `required_signatures` rule on the tag
// ruleset that .github/rulesets/tags.json dropped in #97, and a `secret scan` required context
// on main where .github/rulesets/main.json has said `tests kept` since #32.
//
// They are asserted against the real files rather than against copies, so a file edited back
// into disagreement with the recorded drift reddens here.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  canonical,
  compareRuleset,
  driftReport,
  liveRulesets,
  repositoryName,
  rulesetFiles,
  type Ruleset,
} from '../../scripts/check-ruleset-drift.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const file = (name: string): Ruleset =>
  JSON.parse(readFileSync(path.join(ROOT, '.github', 'rulesets', name), 'utf8')) as Ruleset

/** The live tag ruleset as it answered at 2026-09-10T13:00Z, three rules to the file's two. */
const LIVE_TAGS_WITH_SIGNATURES: Ruleset = {
  id: 22316869,
  name: 'release tags',
  target: 'tag',
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include: ['refs/tags/v*'] } },
  rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'required_signatures' }],
}

/** The live main ruleset as it answered at 2026-09-10T13:00Z. Two differences from the file:
 *  the required context, and two `pull_request` parameters the file does not state. */
const LIVE_MAIN: Ruleset = {
  id: 22314350,
  name: 'main',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_signatures' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        required_reviewers: [],
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        require_extra_approval_for_unattributed_changes: true,
        allowed_merge_methods: ['squash'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: 'checks' }, { context: 'secret scan' }],
      },
    },
  ],
}

const drifted = (findings: readonly { severity: string; where: string }[]): readonly string[] =>
  findings.filter((finding) => finding.severity === 'drift').map((finding) => finding.where)

describe('the drift the files could not see', () => {
  it('names the required_signatures rule the tag file dropped and the forge kept', () => {
    const findings = compareRuleset(file('tags.json'), LIVE_TAGS_WITH_SIGNATURES)
    assert.deepEqual(drifted(findings), ['rules.required_signatures'])
    const named = findings.find((finding) => finding.where === 'rules.required_signatures')
    assert.match(named?.detail ?? '', /live ruleset enforces this rule and the file does not/)
  })

  it('names the required context main enforces in place of the one the file states', () => {
    const findings = compareRuleset(file('main.json'), LIVE_MAIN)
    assert.deepEqual(drifted(findings), [
      'rules.required_status_checks.parameters.required_status_checks',
    ])
    const named = findings.find((finding) => finding.where.endsWith('required_status_checks'))
    assert.match(named?.detail ?? '', /tests kept/)
    assert.match(named?.detail ?? '', /secret scan/)
  })

  it('refuses the pair, and the report names the file and the live ruleset it read', () => {
    const report = driftReport(
      [
        { source: '.github/rulesets/main.json', ruleset: file('main.json') },
        { source: '.github/rulesets/tags.json', ruleset: file('tags.json') },
      ],
      [LIVE_MAIN, LIVE_TAGS_WITH_SIGNATURES],
    )
    assert.equal(report.ok, false)
    assert.match(report.lines.join('\n'), /main\.json vs live ruleset 22314350 \("main"\)/)
    assert.match(report.lines.join('\n'), /tags\.json vs live ruleset 22316869/)
  })

  it('accepts a forge that enforces exactly what the tag file states', () => {
    const applied: Ruleset = { ...LIVE_TAGS_WITH_SIGNATURES, rules: [{ type: 'update' }, { type: 'deletion' }] }
    assert.deepEqual(drifted(compareRuleset(file('tags.json'), applied)), [])
    assert.equal(driftReport([{ source: 'tags.json', ruleset: file('tags.json') }], [applied]).ok, true)
  })
})

describe('what counts as drift', () => {
  const FILE: Ruleset = {
    name: 'main',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'deletion' }],
  }
  const LIVE: Ruleset = { ...FILE, id: 1, bypass_actors: [] }

  it('reports enforcement turned down to evaluate', () => {
    const findings = compareRuleset(FILE, { ...LIVE, enforcement: 'evaluate' })
    assert.deepEqual(drifted(findings), ['enforcement'])
  })

  it('reports a rule the forge lost', () => {
    const findings = compareRuleset({ ...FILE, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] }, LIVE)
    assert.deepEqual(drifted(findings), ['rules.non_fast_forward'])
  })

  it('reports a bypass actor the file does not grant, when the reader can see the field', () => {
    const findings = compareRuleset(FILE, {
      ...LIVE,
      bypass_actors: [{ actor_id: 5, actor_type: 'Team', bypass_mode: 'always' }],
    })
    assert.deepEqual(drifted(findings), ['bypass_actors'])
  })

  it('reports a file that names a ruleset the forge does not have at all', () => {
    const report = driftReport([{ source: 'tags.json', ruleset: { name: 'release tags' } }], [LIVE])
    assert.equal(report.ok, false)
    assert.match(report.lines.join('\n'), /never applied/)
  })

  it('reports a live ruleset no file in the tree describes', () => {
    const report = driftReport([{ source: 'main.json', ruleset: FILE }], [LIVE, { id: 9, name: 'someone else' }])
    assert.equal(report.ok, false)
    assert.match(report.lines.join('\n'), /"someone else"\) is enforced and no file/)
  })

  it('is not confused by the order the forge serialises rules and contexts in', () => {
    const contexts = (order: readonly string[]): Ruleset => ({
      ...FILE,
      rules: [
        { type: 'deletion' },
        { type: 'required_status_checks', parameters: { required_status_checks: order.map((context) => ({ context })) } },
      ],
    })
    assert.deepEqual(drifted(compareRuleset(contexts(['a', 'b']), { ...contexts(['b', 'a']), id: 1 })), [])
    assert.equal(JSON.stringify(canonical([2, 1])), '[1,2]')
  })
})

describe('what the check cannot see, and says so', () => {
  const FILE: Ruleset = { name: 'main', target: 'branch', enforcement: 'active', bypass_actors: [], rules: [] }

  it('does not count an absent bypass_actors as a match', () => {
    const findings = compareRuleset(FILE, { name: 'main', target: 'branch', enforcement: 'active', rules: [] })
    assert.deepEqual(drifted(findings), [])
    const note = findings.find((finding) => finding.where === 'bypass_actors')
    assert.equal(note?.severity, 'note')
    assert.match(note?.detail ?? '', /NOT compared/)
    assert.match(note?.detail ?? '', /administrator/)
  })

  it('names a parameter only the forge reports without failing on it', () => {
    // GitHub fills defaults into a ruleset it accepts and serves keys its own published API
    // description does not carry, so a file mirroring the response could be refused by the
    // endpoint that applies it. The reader is told; the check does not redden.
    const findings = compareRuleset(
      { ...FILE, rules: [{ type: 'pull_request', parameters: { require_code_owner_review: false } }] },
      {
        ...FILE,
        rules: [
          {
            type: 'pull_request',
            parameters: {
              require_code_owner_review: false,
              require_extra_approval_for_unattributed_changes: true,
            },
          },
        ],
      },
    )
    assert.deepEqual(drifted(findings), [])
    const note = findings.find((finding) => finding.where === 'rules.pull_request.parameters')
    assert.match(note?.detail ?? '', /require_extra_approval_for_unattributed_changes=true/)
  })
})

describe('how it reads the forge and the tree', () => {
  it('reads each ruleset by id, because the list endpoint carries no rules', async () => {
    const asked: string[] = []
    const answers: Record<string, unknown> = {
      'repos/o/r/rulesets': [{ id: 1, name: 'main' }, { id: 2, name: 'release tags' }],
      'repos/o/r/rulesets/1': { id: 1, name: 'main', rules: [{ type: 'deletion' }] },
      'repos/o/r/rulesets/2': { id: 2, name: 'release tags', rules: [{ type: 'update' }] },
    }
    const live = await liveRulesets('o/r', async (endpoint) => {
      asked.push(endpoint)
      return answers[endpoint]
    })
    assert.deepEqual(asked, ['repos/o/r/rulesets', 'repos/o/r/rulesets/1', 'repos/o/r/rulesets/2'])
    assert.deepEqual(
      live.map((ruleset) => ruleset.rules?.[0]?.type),
      ['deletion', 'update'],
    )
  })

  it('takes the repository from the argument, the environment, then the manifest', () => {
    assert.equal(repositoryName('a/b', { GITHUB_REPOSITORY: 'c/d' }), 'a/b')
    assert.equal(repositoryName(undefined, { GITHUB_REPOSITORY: 'c/d' }), 'c/d')
    assert.equal(repositoryName(undefined, {}), 'Abhijeet34/treadle')
  })

  it('reads every ruleset file in the tree, and each one names itself', () => {
    const files = rulesetFiles()
    assert.deepEqual(
      files.map((entry) => entry.source),
      ['.github/rulesets/main.json', '.github/rulesets/tags.json'],
    )
    for (const entry of files) assert.equal(typeof entry.ruleset.name, 'string')
  })
})
