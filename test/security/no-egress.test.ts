// SPDX-License-Identifier: Apache-2.0
// The tool opens no socket. That claim is worth nothing as a reading of the imports, because
// a transitive call three layers down is exactly what a reading misses, so it is asserted at
// runtime: every entry point in Node that can reach the network is replaced with one that
// records the attempt and throws, and every command in the inventory is then run against a
// real workspace with the trap live.
//
// A trap that cannot fire is the failure mode this file is most exposed to, so the first
// test in it makes the trap fire on purpose and asserts it caught the call. Without that,
// a patch that silently stopped applying would leave the rest of the file green over nothing.

import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, before, after } from 'node:test'

import { COMMANDS } from '../../src/cli/inventory.ts'
import { aDemoWorkspace, type Demo } from '../helpers/cli-fixtures.ts'
import { runCli } from '../helpers/cli-run.ts'

type Attempt = { readonly api: string; readonly argument: string }

/**
 * Replaces every socket-opening entry point with one that records and throws, and returns
 * the undo. Patching the module's own export object is what reaches a caller that did
 * `import http from 'node:http'` three layers down; the prototype patches reach the ones
 * that constructed a socket themselves.
 */
function trapTheNetwork(attempts: Attempt[]): () => void {
  const undo: (() => void)[] = []

  const trap = (holder: Record<string, unknown>, key: string, api: string): void => {
    const original = holder[key]
    holder[key] = (...args: unknown[]) => {
      attempts.push({ api, argument: String(args[0] ?? '') })
      throw new Error(`${api} was called, and this tool opens no socket`)
    }
    undo.push(() => { holder[key] = original })
  }

  trap(net as unknown as Record<string, unknown>, 'connect', 'net.connect')
  trap(net as unknown as Record<string, unknown>, 'createConnection', 'net.createConnection')
  trap(net.Socket.prototype as unknown as Record<string, unknown>, 'connect', 'net.Socket.connect')
  trap(net.Server.prototype as unknown as Record<string, unknown>, 'listen', 'net.Server.listen')
  trap(tls as unknown as Record<string, unknown>, 'connect', 'tls.connect')
  trap(http as unknown as Record<string, unknown>, 'request', 'http.request')
  trap(http as unknown as Record<string, unknown>, 'get', 'http.get')
  trap(https as unknown as Record<string, unknown>, 'request', 'https.request')
  trap(https as unknown as Record<string, unknown>, 'get', 'https.get')
  trap(dgram as unknown as Record<string, unknown>, 'createSocket', 'dgram.createSocket')
  trap(dns as unknown as Record<string, unknown>, 'lookup', 'dns.lookup')
  trap(dns as unknown as Record<string, unknown>, 'resolve', 'dns.resolve')
  trap(dns.promises as unknown as Record<string, unknown>, 'lookup', 'dns.promises.lookup')
  trap(globalThis as unknown as Record<string, unknown>, 'fetch', 'fetch')

  return () => { for (const restore of undo.reverse()) restore() }
}

type Invocation = { readonly argv: readonly string[]; readonly cwd: string }

/** Every command the inventory names, with arguments that reach its real work. */
function invocations(inside: string, elsewhere: string): ReadonlyMap<string, Invocation> {
  const argv = new Map<string, readonly string[]>([
    ['init', ['init', '--name', 'egress']],
    ['file', ['file', 'task', 'A task filed with the network trapped']],
    ['show', ['show', 'auth-refresh']],
    ['backlog', ['backlog', '--state', 'ready']],
    ['transition', ['transition', 'sso-saml', 'in_review']],
    ['mark', ['mark', 'flaky-e2e', '--severity', 'S1', '--reason', 'it fails the release suite']],
    ['evidence', ['evidence', 'add', 'flaky-e2e', 'run', '8813', 'five of five green']],
    ['doctor', ['doctor']],
    ['next', ['next', '--limit', '3']],
    ['explain', ['explain', 'auth-refresh']],
    ['status', ['status']],
    ['help', ['help']],
    ['version', ['version']],
  ])
  assert.deepEqual(
    [...argv.keys()].sort(), COMMANDS.map((command) => command.name).sort(),
    'a command in the inventory is not exercised by the egress test',
  )
  return new Map([...argv].map(([name, args]) => [
    name, { argv: args, cwd: name === 'init' ? elsewhere : inside },
  ]))
}

describe('the network trap fires when something does open a socket', () => {
  it('records the call and throws, so a green run below means something', () => {
    const attempts: Attempt[] = []
    const release = trapTheNetwork(attempts)
    try {
      // The trap throws where the real call would have returned a promise or a socket, so
      // every one of these is a synchronous throw rather than a rejection.
      assert.throws(() => fetch('http://127.0.0.1:1/'), /opens no socket/)
      assert.throws(() => http.get('http://127.0.0.1:1/'), /opens no socket/)
      assert.throws(() => net.connect(1, '127.0.0.1'), /opens no socket/)
      assert.throws(() => new net.Socket().connect(1), /opens no socket/)
      assert.throws(() => dns.lookup('example.invalid', () => undefined), /opens no socket/)
    } finally {
      release()
    }
    assert.deepEqual(
      attempts.map((a) => a.api),
      ['fetch', 'http.get', 'net.connect', 'net.Socket.connect', 'dns.lookup'],
    )
    assert.equal(typeof globalThis.fetch, 'function', 'the trap did not put fetch back')
  })
})

describe('no command opens a socket', () => {
  let demo: Demo
  let cwd: string
  let elsewhere: string

  before(async () => {
    demo = await aDemoWorkspace()
    cwd = path.dirname(demo.root)
    await demo.store.close()
    elsewhere = await mkdtemp(path.join(tmpdir(), 'treadle-egress-'))
  })

  after(async () => {
    await demo.dispose()
    await rm(elsewhere, { recursive: true, force: true })
  })

  it('holds for every command the inventory names', async (t) => {
    const attempts: Attempt[] = []
    const release = trapTheNetwork(attempts)
    let ran = 0
    try {
      for (const [name, invocation] of invocations(cwd, elsewhere)) {
        const run = await runCli(invocation.argv, { cwd: invocation.cwd })
        ran += 1
        assert.ok(run.code < 7, `${name} exited ${run.code}`)
        assert.equal(
          /opens no socket/.test(run.out + run.err), false,
          `${name} tried to reach the network: ${run.err}`,
        )
      }
    } finally {
      release()
    }
    assert.deepEqual(attempts, [], `a command reached the network: ${JSON.stringify(attempts)}`)
    assert.equal(ran, COMMANDS.length)
    t.diagnostic(`${ran} commands run with every network entry point trapped: 0 attempts`)
  })
})
