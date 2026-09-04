// SPDX-License-Identifier: Apache-2.0
// Regression tests for threat-model finding F6, prototype pollution.
// The record field-key grammar `[a-z_][a-z0-9_]*` matches `__proto__`, `constructor`
// and `prototype`, so every one of them is a legal-looking key in a committed file.
// buildRecord is the single door parsed input walks through into the domain core.

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  FIELD_KEY_PATTERN,
  FORBIDDEN_FIELD_KEYS,
  buildRecord,
  validateFieldKeys,
} from '../../src/domain/index.ts'
import { errorOf, unwrap } from '../helpers/fixtures.ts'

/** Reads a would-be polluted property without tripping TypeScript's object typing. */
function probe(name: string): unknown {
  return (Object.prototype as unknown as Record<string, unknown>)[name]
}

describe('F6 prototype pollution through record field keys', () => {
  after(() => {
    // If any assertion below silently polluted, every later suite would inherit it.
    assert.equal(probe('polluted'), undefined, 'Object.prototype leaked a key')
    assert.equal(probe('isAdmin'), undefined, 'Object.prototype leaked a key')
  })

  it('confirms the three dangerous keys really do match the field-key grammar', () => {
    for (const key of FORBIDDEN_FIELD_KEYS) {
      assert.ok(
        FIELD_KEY_PATTERN.test(key),
        `${key} must match the grammar, otherwise this finding is about nothing`,
      )
    }
  })

  it('refuses __proto__ as a field key and names it', () => {
    const error = errorOf(buildRecord([['__proto__', 'polluted']]))
    assert.equal(error.code, 'VALIDATION')
    assert.equal(error.rule, 'V2')
    assert.deepEqual(error.entities, ['__proto__'])
    assert.match(error.message, /__proto__/)
  })

  it('refuses constructor and prototype for the same reason', () => {
    for (const key of ['constructor', 'prototype']) {
      assert.equal(errorOf(buildRecord([[key, 'x']])).rule, 'V2', `${key} must be refused`)
    }
  })

  it('does not pollute Object.prototype even while refusing', () => {
    buildRecord([['__proto__', 'polluted']])
    assert.equal(probe('polluted'), undefined)
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
  })

  it('returns a Map, so a hostile key can never reach a prototype chain', () => {
    const record = unwrap(buildRecord([['severity', 'S1'], ['found_in', 'production']]))
    assert.ok(record instanceof Map)
    assert.equal(record.get('severity'), 'S1')
    // The defence in depth: even a key that got past the deny-list is inert in a Map.
    assert.equal(record.get('__proto__'), undefined)
  })

  it('refuses a key that does not match the grammar, naming the key', () => {
    const error = errorOf(buildRecord([['Found-In', 'dev']]))
    assert.equal(error.rule, 'V1')
    assert.deepEqual(error.entities, ['Found-In'])
  })

  it('refuses a duplicate field key rather than letting the last write win', () => {
    const error = errorOf(buildRecord([['severity', 'S1'], ['severity', 'S4']]))
    assert.equal(error.rule, 'V3')
    assert.deepEqual(error.entities, ['severity'])
  })

  it('accepts a well-formed record and preserves insertion order', () => {
    const record = unwrap(buildRecord([['type', 'bug'], ['severity', 'S1']]))
    assert.deepEqual([...record.keys()], ['type', 'severity'])
  })

  it('validateFieldKeys refuses a hand-edited extras map carrying a dangerous key', () => {
    assert.equal(errorOf(validateFieldKeys(new Map([['constructor', 'x']]))).rule, 'V2')
  })
})
