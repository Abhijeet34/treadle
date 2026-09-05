// SPDX-License-Identifier: Apache-2.0
// One registry keyed by `<command>/<version>`, which is the string every result object
// carries. A renderer looks a shape up from here, so its only argument is the result object
// itself; that is what the recording renderer in the conformance suite proves.

import { ERROR_SHAPE, type ResultShape } from './result.ts'
import { BACKLOG_SHAPE, FILE_SHAPE, SHOW_SHAPE } from './services/items.ts'
import { DOCTOR_SHAPE } from './services/doctor.ts'
import { TRANSITION_SHAPE } from './services/lifecycle.ts'
import { EVIDENCE_SHAPE, MARK_SHAPE } from './services/marking.ts'
import { EXPLAIN_SHAPE, NEXT_SHAPE, STATUS_SHAPE } from './services/insight.ts'
import { HELP_SHAPE, VERSION_SHAPE } from './services/meta.ts'
import { INIT_SHAPE } from './services/workspace.ts'

export const SHAPES: readonly ResultShape[] = [
  BACKLOG_SHAPE,
  DOCTOR_SHAPE,
  ERROR_SHAPE,
  EVIDENCE_SHAPE,
  EXPLAIN_SHAPE,
  FILE_SHAPE,
  HELP_SHAPE,
  INIT_SHAPE,
  MARK_SHAPE,
  NEXT_SHAPE,
  SHOW_SHAPE,
  STATUS_SHAPE,
  TRANSITION_SHAPE,
  VERSION_SHAPE,
]

const BY_SCHEMA = new Map(SHAPES.map((shape) => [`${shape.command}/${shape.version}`, shape]))

export function shapeFor(schema: string): ResultShape | undefined {
  return BY_SCHEMA.get(schema)
}
