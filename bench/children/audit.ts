// SPDX-License-Identifier: Apache-2.0
// Reads a possibly-damaged store and reports what it could still serve, for axis A5.
//
// It runs as its own process so that a crash is an observable exit status rather than a
// thrown error that takes the harness with it. An axis counting crashes cannot be measured
// in the process that would crash.
//
// Usage: audit.ts <root>

import { ShardedStore } from '../../src/adapters/store/index.ts'

const [root] = process.argv.slice(2)
const store = new ShardedStore(root as string)

const listed = await store.list({})
const findings = await store.findings()
await store.close()

process.stdout.write(JSON.stringify({
  listed: listed.ok
    ? { ok: true, ids: listed.value.map((i) => i.id) }
    : { ok: false, code: listed.error.code, rule: listed.error.rule, message: listed.error.message },
  findings: findings.ok
    ? findings.value.map((f) => ({ file: f.file, line: f.line, rule: f.rule, id: f.id, reason: f.reason }))
    : [{ file: '', line: 0, rule: findings.error.rule, reason: `findings() refused: ${findings.error.message}` }],
  findingsRefused: !findings.ok,
}) + '\n')
