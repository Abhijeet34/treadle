// SPDX-License-Identifier: Apache-2.0
// The synthetic AWS credential AGENTS.md's "Secret scanning" section relies on the gate
// catching. gitleaks' aws-access-token rule - both in the fleet's canonical .gitleaks.toml
// (which extends gitleaks' defaults rather than restating them) and in vanilla gitleaks 8.30.1
// - is
//   (A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}
// a base32-style tail that excludes the digits 0, 1, 8 and 9. A uniform draw from the full
// uppercase-alphanumeric alphabet lands one of those four digits about 85% of the time
// (measured below) and then the line matches no rule at all, not even the generic one: a
// planted AKIA + digit-bearing tail on a line by itself scans clean under this repository's
// own .gitleaks.toml. This file pins the fixture generator to the charset the rule actually
// requires, so a change to either drifts loudly instead of quietly.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { workflowOf, type Job } from '../helpers/workflow.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// The tail gitleaks' aws-access-token rule requires: [A-Z2-7]{16}, never the full
// uppercase-alphanumeric set (which also carries 0, 1, 8, 9).
const AWS_KEY_TAIL_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function syntheticAwsAccessKeyId(): string {
  let tail = ''
  for (let i = 0; i < 16; i++) {
    tail += AWS_KEY_TAIL_CHARSET[Math.floor(Math.random() * AWS_KEY_TAIL_CHARSET.length)]
  }
  return `AKIA${tail}`
}

/**
 * gitleaks is not a runtime dependency of treadling, so a developer's machine without the binary
 * skips the two scans below with this named reason rather than failing the build.
 */
const GITLEAKS_MISSING: string | false = (() => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' })
    return false
  } catch {
    return 'gitleaks is not installed on this machine'
  }
})()

/**
 * That skip was true on every leg: secret-scan.yml installed gitleaks and never ran `npm test`,
 * ci.yml and cross-platform.yml ran `npm test` and installed nothing, so the two tests proving
 * the planted fixture is a shape the rule matches had never executed in any job. ci.yml's
 * `check` job now installs the binary and sets this, and with it set an absent binary fails
 * these tests instead of skipping them - so deleting that install step reddens the job rather
 * than returning them to running nowhere.
 */
const REQUIRED = process.env['TREADLING_REQUIRE_GITLEAKS'] === '1'

const SKIP: string | false = REQUIRED ? false : GITLEAKS_MISSING

async function scan(line: string): Promise<Array<{ RuleID: string }>> {
  assert.equal(
    GITLEAKS_MISSING, false,
    'TREADLING_REQUIRE_GITLEAKS is set, so this job undertook to install gitleaks and did not',
  )
  const dir = await mkdtemp(path.join(tmpdir(), 'treadling-secret-scan-fixture-'))
  try {
    await writeFile(path.join(dir, 'deploy.env'), `${line}\n`)
    const report = execFileSync(
      'gitleaks',
      [
        'dir', dir,
        '--config', path.join(ROOT, '.gitleaks.toml'),
        '--report-format', 'json',
        '--report-path', '-',
        '--exit-code', '0',
        '--no-banner',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )
    return JSON.parse(report) as Array<{ RuleID: string }>
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('the synthetic AWS credential fixture this repository plants to prove the gate fires', () => {
  it('draws its tail only from the charset the aws-access-token rule requires', () => {
    for (let i = 0; i < 200; i++) {
      const key = syntheticAwsAccessKeyId()
      assert.match(key, /^AKIA[A-Z2-7]{16}$/, `${key} is not a shape the aws-access-token rule matches`)
    }
  })

  it(
    'gitleaks flags the generated fixture as aws-access-token, the rule the gate is proven against',
    { skip: SKIP },
    async () => {
      const key = syntheticAwsAccessKeyId()
      const findings = await scan(`AWS_ACCESS_KEY_ID=${key}`)
      assert.ok(
        findings.some((f) => f.RuleID === 'aws-access-token'),
        `expected an aws-access-token finding for ${key}, got ${JSON.stringify(findings.map((f) => f.RuleID))}`,
      )
    },
  )

  it(
    'a tail outside that charset is not a fixture the gate can be proven against: it scans clean',
    { skip: SKIP },
    async () => {
      // A tail with its first character forced to '8' - inside the full uppercase-alphanumeric
      // set a naive generator would draw from, outside the base32-style set the rule requires.
      const key = `AKIA8${syntheticAwsAccessKeyId().slice(5)}`
      const findings = await scan(`AWS_ACCESS_KEY_ID=${key}`)
      assert.deepEqual(
        findings, [],
        `expected ${key} to scan clean (confirming the charset, not the keyword, is what gates the match), got ${JSON.stringify(findings)}`,
      )
    },
  )
})

// The two scans above are worth exactly what runs them, and until 2026-09-10 nothing did:
// `grep -rn gitleaks .github/` named secret-scan.yml alone, and that workflow runs the scanner
// over the repository without ever running `npm test`. This holds the wiring that changed.
function jobOf(file: string, name: string): Job {
  const job = workflowOf(ROOT, file)[name]
  assert.ok(job !== undefined, `${file} declares no ${name} job`)
  return job
}

describe('the job that runs the suite carries the scanner the two scans above need', () => {
  const check = jobOf('ci.yml', 'check')
  const secrets = jobOf('secret-scan.yml', 'secrets')

  it('installs gitleaks in the same job that runs npm test, and refuses to skip without it', () => {
    const installs = check.steps.filter((step) => step.run?.includes('gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz'))
    const suite = check.steps.filter((step) => step.run?.includes('npm test'))
    assert.equal(installs.length, 1, 'the check job does not install gitleaks, so the scans above skip in CI')
    assert.equal(suite.length, 1, 'the check job no longer runs npm test, so nothing here runs the scans above')
    assert.equal(
      check.env['TREADLING_REQUIRE_GITLEAKS'], '"1"',
      'without this a failed or deleted install is a silent skip again, which is the finding',
    )
  })

  it('pins the version and digest secret-scan.yml pins, so the two copies cannot drift apart', () => {
    for (const key of ['GITLEAKS_VERSION', 'GITLEAKS_SHA256']) {
      assert.equal(check.env[key], secrets.env[key], `${key} differs between ci.yml and secret-scan.yml`)
      assert.ok((check.env[key] ?? '').length > 2, `${key} is unset in ci.yml`)
    }
  })
})
