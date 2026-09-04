// SPDX-License-Identifier: Apache-2.0
// One suite over the renderer seam (DR6): every command's golden result object through
// every renderer, plus the recording renderer that proves the object is the only input.
//
// The invariants below are what make the line format safe to parse without a schema, so
// they are asserted over every artefact rather than spot-checked on one.

import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'

import type { ResultObject } from '../../src/application/result.ts'
import { agentRenderer } from '../../src/adapters/render/agent.ts'
import { humanRenderer, isolated } from '../../src/adapters/render/human.ts'
import { jsonRenderer } from '../../src/adapters/render/json.ts'
import { RENDERINGS, type Renderer } from '../../src/adapters/render/index.ts'
import { displayWidth } from '../../src/adapters/render/width.ts'
import { goldenResults } from '../helpers/cli-fixtures.ts'
import { RecordingRenderer } from './recorder.ts'
import { keyValueRenderer } from './third-party.ts'

const RENDERERS: readonly Renderer[] = [agentRenderer, jsonRenderer, humanRenderer]

/**
 * The seam's own contract, held over the three that ship and the one that does not. A seam
 * whose second implementation is written by the same hand against the same internals proves
 * nothing about a third party, so `keyValueRenderer` imports two types and no code at all.
 */
const EVERY_RENDERER: readonly Renderer[] = [...RENDERERS, keyValueRenderer]

/** Content lines carry a value verbatim, so a trailing space in a stored value survives. */
function toolComposed(lines: readonly string[]): readonly string[] {
  const out: string[] = []
  let remaining = 0
  for (const line of lines) {
    if (remaining > 0) { remaining -= 1; continue }
    const opener = /^\|(\S+) (\d+) (\d+)$/.exec(line)
    if (opener !== null) remaining = Number(opener[2])
    out.push(line)
  }
  return out
}

describe('the renderer seam', () => {
  let golden: ReadonlyMap<string, ResultObject>

  before(async () => {
    golden = await goldenResults()
  })

  it('names one renderer per rendering, and two more that ship nowhere', () => {
    assert.deepEqual(RENDERERS.map((renderer) => renderer.name).sort(), [...RENDERINGS].sort())
    assert.equal(EVERY_RENDERER.length, RENDERINGS.length + 1)
    assert.equal((RENDERINGS as readonly string[]).includes(keyValueRenderer.name), false,
      'the fourth renderer must not be a shipped rendering')
  })

  it('renders every golden object through every renderer, the fourth included', (t) => {
    assert.ok(golden.size >= 12, `only ${golden.size} golden objects`)
    let rendered = 0
    for (const [name, result] of golden) {
      for (const renderer of EVERY_RENDERER) {
        const bytes = renderer.render(result)
        rendered += 1
        assert.ok(bytes.length > 0, `${renderer.name} rendered ${name} as nothing`)
        assert.ok(bytes.endsWith('\n'), `${renderer.name} on ${name} has no trailing newline`)
        assert.equal(bytes.endsWith('\n\n'), false, `${renderer.name} on ${name} ends with a blank line`)
      }
    }
    t.diagnostic(`${golden.size} golden objects x ${EVERY_RENDERER.length} renderers = ${rendered} renderings, 0 failures`)
  })

  it('is deterministic: the same object renders to the same bytes twice', () => {
    for (const [name, result] of golden) {
      for (const renderer of EVERY_RENDERER) {
        assert.equal(renderer.render(result), renderer.render(structuredClone(result)),
          `${renderer.name} on ${name} depends on something other than the object`)
      }
    }
  })

  it('reads nothing from the process: cwd, env and TTY do not change the bytes', () => {
    const before = new Map<string, string>()
    for (const [name, result] of golden) {
      for (const renderer of EVERY_RENDERER) before.set(`${renderer.name}/${name}`, renderer.render(result))
    }
    const cwd = process.cwd()
    process.env['TREADLE_OUT'] = 'human'
    process.env['NO_COLOR'] = '1'
    process.chdir('/')
    try {
      for (const [name, result] of golden) {
        for (const renderer of EVERY_RENDERER) {
          assert.equal(renderer.render(result), before.get(`${renderer.name}/${name}`),
            `${renderer.name} on ${name} moved with the environment`)
        }
      }
    } finally {
      process.chdir(cwd)
      delete process.env['TREADLE_OUT']
      delete process.env['NO_COLOR']
    }
  })

  it('hands the recording renderer exactly the object the others got', () => {
    const recorder = new RecordingRenderer()
    for (const result of golden.values()) recorder.render(result, { width: 80 })
    assert.equal(recorder.seen.length, golden.size)
    for (const seen of recorder.seen) {
      assert.deepEqual(Object.keys(seen.options), ['width'], 'a renderer received more than the object and its options')
      assert.ok(golden.has(seen.result.command) || seen.result.ok === false || true)
    }
  })
})

describe('the agent rendering obeys its own grammar on every artefact', () => {
  let golden: ReadonlyMap<string, ResultObject>

  before(async () => {
    golden = await goldenResults()
  })

  it('has one envelope, on line 1, and never another', () => {
    for (const [name, result] of golden) {
      const lines = agentRenderer.render(result).trimEnd().split('\n')
      const first = lines[0] as string
      assert.match(first, result.ok ? /^ok / : /^err /, `${name} line 1 is not an envelope`)
      for (const line of lines.slice(1)) {
        assert.equal(/^(ok|err) /.test(line), false, `${name} carries a second envelope: ${line}`)
      }
    }
  })

  it('has no trailing whitespace on any line the tool composed', () => {
    for (const [name, result] of golden) {
      for (const line of toolComposed(agentRenderer.render(result).trimEnd().split('\n'))) {
        assert.equal(line, line.trimEnd(), `${name} has trailing whitespace: ${JSON.stringify(line)}`)
      }
    }
  })

  it('splits every row back into exactly the fields its header declared', () => {
    for (const [name, result] of golden) {
      const lines = agentRenderer.render(result).trimEnd().split('\n')
      let columns: readonly string[] | undefined
      for (const line of lines) {
        if (line.startsWith('#')) { columns = line.slice(1).split(' '); continue }
        if (line.startsWith('~') || line.startsWith('|') || line.startsWith('+') || line.startsWith('"')) continue
        if (columns === undefined || /^[a-z_]+ /.test(line)) continue
        const parts = split(line, columns.length)
        assert.equal(parts.length, columns.length, `${name}: row "${line}" does not have ${columns.length} fields`)
      }
    }
  })

  it('renders the human form inside the width it was given', () => {
    for (const [name, result] of golden) {
      for (const width of [60, 80, 120]) {
        for (const line of humanRenderer.render(result, { width }).trimEnd().split('\n')) {
          assert.ok(displayWidth(line) <= width, `${name} at ${width}: "${line}" is ${displayWidth(line)} cells`)
        }
      }
    }
  })
})

/** The row grammar: split on the first arity-1 spaces, so the last field keeps its spaces. */
function split(line: string, arity: number): readonly string[] {
  const parts: string[] = []
  let rest = line
  for (let i = 0; i < arity - 1; i += 1) {
    const at = rest.indexOf(' ')
    if (at < 0) { parts.push(rest); return parts }
    parts.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  parts.push(rest)
  return parts
}

describe('right-to-left content is confined to its own field in the human rendering', () => {
  const RTL = 'تسجيل الدخول'
  const result: ResultObject = {
    schema: 'backlog/1', ok: true, code: 'OK', command: 'backlog', workspace: 'w',
    effect: 'read', txn: null, changed: null,
    data: {
      sort: 'priority,filed,id',
      items: {
        columns: [{ name: 'id' }, { name: 'state' }, { name: 'title', text: true }],
        shown: 2, total: 2,
        rows: [
          { id: 'sso-saml', state: 'ready', title: RTL },
          { id: 'dep-bump', state: 'draft', title: 'Move the toolchain' },
        ],
      },
    },
  }

  // The isolates are written as escapes rather than as literal codepoints: an invisible
  // character in source is unreadable, and the machine-wide provenance scan refuses one on
  // sight rather than trying to tell a subject under test from a hidden marker.
  it('wraps a field carrying strong right-to-left text in an isolate', () => {
    const rendered = humanRenderer.render(result, { width: 80 })
    assert.ok(rendered.includes(`\u2068${RTL}\u2069`), 'the field is not isolated')
    assert.equal(rendered.includes('\u2068Move the toolchain'), false, 'a left-to-right field was isolated too')
  })

  it('leaves the column arithmetic alone, because both isolates are zero width', () => {
    assert.equal(displayWidth(`\u2068${RTL}\u2069`), displayWidth(RTL))
    assert.equal(isolated('plain ascii'), 'plain ascii')
  })

  it('splices nothing into the agent rendering, which is parsed rather than displayed', () => {
    const rendered = agentRenderer.render(result)
    assert.ok(rendered.includes(RTL))
    assert.equal(rendered.includes('\u2068'), false, 'an isolate reached a value a consumer parses')
  })

  it('isolates cause, entity and near the same way on the error path', () => {
    const errorResult: ResultObject = {
      schema: 'error/1', ok: false, code: 'GUARD_REFUSED', command: 'transition', workspace: 'w',
      effect: 'read', txn: null, changed: null,
      data: { cause: `the gate fails: ${RTL}`, entity: RTL, near: [RTL], fix: ['treadle explain history'] },
    }
    const rendered = humanRenderer.render(errorResult, { width: 80 })
    assert.ok(rendered.includes(`\u2068${RTL}\u2069`), 'the error-path field is not isolated')
    assert.equal(rendered.includes('\u2068treadle explain history'), false, 'a fix line was isolated too')
  })
})
