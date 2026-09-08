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
 * gitleaks is not a runtime dependency of treadle: the `check` job that runs `npm test` does
 * not install it, only the shared secret-scan workflow's own job does. A machine without the
 * binary skips the tests below with this named reason rather than failing the build.
 */
const GITLEAKS_MISSING: string | false = (() => {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' })
    return false
  } catch {
    return 'gitleaks is not installed on this machine'
  }
})()

async function scan(line: string): Promise<Array<{ RuleID: string }>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'treadle-secret-scan-fixture-'))
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
    { skip: GITLEAKS_MISSING },
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
    { skip: GITLEAKS_MISSING },
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
