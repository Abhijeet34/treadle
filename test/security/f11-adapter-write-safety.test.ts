// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F11: interface A.8 rule 3 has an agent adapter "generated ... written
// where the caller asks", with no diff, backup, idempotence or reversibility contract.
//
// Establish the surface before securing it. treadle generates no adapter, no completion and
// no man page: the thirteen commands in the inventory are the whole surface, and every module
// that can write a byte is the store or the workspace it was pointed at. So F11 closes for the
// same reason F1 does, by having nothing to attack, and this file is the tripwire that fires
// the day it gains something. Its failure message carries the five rules ADR-0012 states, so
// whoever trips it is told the contract rather than sent looking for it.
//
// This is an architecture rule read over source text and the command inventory, not a
// runtime claim: it proves the writer allowlist and the command list hold today, the way
// `f1-f7-no-execution.test.ts` proves F1 and F7's import rule. F1's matching runtime claim,
// that nothing under src/ actually executes a program, is `f1-no-execution-at-runtime.test.ts`;
// F11 has no runtime counterpart because there is no generator to drive.

import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'

import { ROOT, sources, specifiersOf, SRC } from '../helpers/src-scan.ts'
import { COMMANDS } from '../../src/cli/inventory.ts'

/**
 * Every module allowed to touch the filesystem, each one the store or the workspace resolver.
 * A generator needs a writer, so it arrives here first.
 */
const WRITERS: readonly string[] = [
  'src/adapters/store/atomic.ts',
  'src/adapters/store/event-log.ts',
  'src/adapters/store/index-cache.ts',
  'src/adapters/store/lock.ts',
  'src/adapters/store/sharded-store.ts',
  'src/adapters/workspace.ts',
]

const CONTRACT = [
  'ADR-0012: a command that writes a file outside the workspace prints the diff against the',
  'current target, takes a moderate confirmation, writes a timestamped backup of what it',
  'replaces, is a no-op with the `already` marker on a re-run, and prints the command that',
  'reverts it. Add those five, then add this file to the allowlist.',
].join(' ')

const FILESYSTEM = /^node:fs(\/promises)?$/

describe('nothing generates an artefact, which is what closes F11', () => {
  it('has the writers the store needs and no others', () => {
    const found = sources(SRC)
      .filter((file) => specifiersOf(file).some((spec) => FILESYSTEM.test(spec)))
      .map((file) => path.relative(ROOT, file))
      .sort()
    assert.deepEqual(found, [...WRITERS].sort(), CONTRACT)
  })

  it('has no command that generates a file for another program to read', () => {
    const generators = COMMANDS.filter((command) => /adapter|completion|generate|man|install|eject/.test(command.name))
    assert.deepEqual(generators.map((command) => command.name), [], CONTRACT)
  })
})
