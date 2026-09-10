// SPDX-License-Identifier: Apache-2.0
// Which operands of a command line name a record, and the one bound on them.
//
// G2: every id-taking command handed the caller's word straight to its service, and a word
// carrying a delimiter came back out of the renderer's own invariant as `err INTERNAL` at
// exit 1 with no rule id - `treadling show $'a\nb'` printed "entity carries \n". That was the
// one path where the contract's promise of a structured, typed error was false, on twelve
// commands at once.
//
// The bound lives here rather than at each call site because the set of id-taking commands
// is the thing that grows, and a rule written in prose is a rule the next command breaks. It
// is read from the usage lines the inventory already publishes, so a command added with
// `<id>` in its usage is bounded the moment it is written.

import { findUnsafeCharacter } from '../domain/index.ts'
import { errorResult, type ResultObject } from '../application/result.ts'
import { commandNamed, type Command } from './inventory.ts'

/**
 * The usage placeholders that name a record, and what a refusal calls each. `<other>` is the
 * far end of a relation, which is an item id like `<id>` and reads better named separately.
 * Every other placeholder is a value held to its own field's rule one layer down, which names
 * that rule better than a line bound would: a title carrying a newline is `V4 title must be a
 * single line`, not a word about ids.
 */
const ENTITY_OPERANDS: ReadonlyMap<string, string> = new Map([
  ['id', 'id'],
  ['other', 'id'],
])

type Slot =
  | { readonly kind: 'literal'; readonly word: string }
  | { readonly kind: 'operand'; readonly name: string }

/** One usage line's operands: its slots in order, and whether the last one repeats. */
type Shape = { readonly slots: readonly Slot[]; readonly repeats: boolean }

/**
 * A usage line's operand shape. Everything from the first flag token on is a flag and its
 * value, and neither is an operand; `[<id> ...]` ends the line by repeating the slot before
 * the marker, which is how a usage line takes any number of trailing ids.
 */
function shapeOf(usage: string, command: string): Shape {
  const tokens = usage.split(' ').filter((token) => token.length > 0)
  const named = tokens[0] === 'treadling' ? tokens.slice(1) : tokens
  const body = named[0] === command ? named.slice(1) : named
  const slots: Slot[] = []
  for (const token of body) {
    if (token.startsWith('--') || token.startsWith('[--')) break
    if (token.startsWith('...')) return { slots, repeats: true }
    const name = token.replaceAll(/[[\]<>]/g, '')
    if (name.length === 0) continue
    // A bracketed token is an optional operand even when it is written without angle
    // brackets, which `evidence add`'s `[label]` is the only instance of. An unbracketed
    // token with no angle brackets is a subcommand word the caller writes verbatim.
    const placeholder = token.startsWith('[') || token.includes('<')
    slots.push(placeholder ? { kind: 'operand', name } : { kind: 'literal', word: name })
  }
  return { slots, repeats: false }
}

/** Every operand shape a command publishes, one per usage line. */
function shapesOf(command: Command): readonly Shape[] {
  return command.usage.map((line) => shapeOf(line, command.name))
}

/** Whether this line writes every subcommand word the usage line spells out. */
function literalsMatch(shape: Shape, operands: readonly string[]): boolean {
  return shape.slots.every((slot, at) => slot.kind !== 'literal' || operands[at] === slot.word)
}

/**
 * The usage line this call is written against: the first whose subcommand words all match.
 * A line that matches none is a line the command refuses on its own verb, and refusing it
 * here first would answer about an operand the caller has not reached yet.
 */
function shapeFor(command: Command, operands: readonly string[]): Shape | undefined {
  return shapesOf(command).find((shape) => literalsMatch(shape, operands))
}

export type EntityOperand = {
  /** Its index among the operands, counting from zero. */
  readonly at: number
  /** What the refusal calls this operand, which is `id`. */
  readonly what: string
  readonly value: string
}

/** The operands of this line that name a record, in the order they were written. */
export function entityOperands(command: string, operands: readonly string[]): readonly EntityOperand[] {
  const known = commandNamed(command)
  if (known === undefined) return []
  const shape = shapeFor(known, operands)
  if (shape === undefined) return []
  const last = shape.slots.at(-1)
  const out: EntityOperand[] = []
  for (const [at, value] of operands.entries()) {
    const slot = shape.slots[at] ?? (shape.repeats ? last : undefined)
    if (slot === undefined || slot.kind !== 'operand') continue
    const what = ENTITY_OPERANDS.get(slot.name)
    if (what !== undefined) out.push({ at, what, value })
  }
  return out
}

/**
 * The first operand naming a record that no record could be named by, as a refusal.
 *
 * It names the operand and never echoes it: echoing an arbitrary caller string into a
 * line-oriented rendering is how this class of bug is made, and the refusal that reports it
 * is the last place that should repeat the mistake. The character is named by code point, so
 * a caller sees which byte was refused without the byte reaching the stream.
 */
export function operandRefusal(
  command: string | undefined, operands: readonly string[],
): ResultObject | undefined {
  if (command === undefined) return undefined
  for (const { at, what, value } of entityOperands(command, operands)) {
    const found = findUnsafeCharacter(value, 'line')
    if (found === undefined) continue
    return errorResult({
      code: 'VALIDATION', command, workspace: '-', effect: 'read', rule: 'C1',
      cause: `the ${what} in operand ${at + 1} carries ${found.label} at character ${found.at + 1}, and no ${what} holds one: an id is a single line of lowercase letters, digits and hyphens`,
      fix: ['treadling backlog'],
    })
  }
  return undefined
}

/** The count as this tool's prose writes it, which is a word up to five and a numeral after. */
function counted(n: number): string {
  return ['no', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n)
}

/**
 * How many operands a line may write, from the usage lines whose subcommand words it matches.
 * Exported so a suite can build the line that is one operand over each command's own bound,
 * rather than against a hand list that the fifteenth command would not be on.
 *
 * `undefined` means the bound does not apply, for either of two reasons. A usage line ending
 * in `...` takes any number, which is `set`'s assignments. And a line matching no usage line
 * that opens with a subcommand word is the command's own to refuse: `evidence list x` is
 * answered by naming the verb, and a count past a verb the caller never reached answers
 * nothing.
 *
 * A subcommand word is a literal in the FIRST slot, and only there. `transition <id>
 * cancelled --resolution <r>` spells a literal in the second, where it names one target state
 * of the `<target>` slot beside it rather than a verb of its own; reading that as a verb left
 * `transition <id> ready extra` refused and `transition <id> in_progress extra` accepted,
 * which is the bound holding for two of the seven states a caller can name.
 */
export function operandLimit(command: Command, operands: readonly string[]): number | undefined {
  const shapes = shapesOf(command)
  const verbed = shapes.filter((shape) => shape.slots[0]?.kind === 'literal')
  if (verbed.length > 0 && !verbed.some((shape) => literalsMatch(shape, operands))) return undefined
  let most = 0
  for (const shape of shapes.filter((shape) => literalsMatch(shape, operands))) {
    if (shape.repeats) return undefined
    most = Math.max(most, shape.slots.length)
  }
  return most
}

/**
 * An operand past the last one the command's usage publishes, as a refusal.
 *
 * Twelve of the fourteen commands read the operand indices they wanted and dropped the rest
 * without a word: `backlog ready`, written for `backlog --state ready`, listed every item at
 * exit 0, and `show <id> desc` printed the whole record rather than the field. The count is
 * the whole of the answer and no operand is echoed: an extra operand is outside every slot
 * the entity bound above reads, so it is a caller string nothing has held to a line.
 *
 * `remove` is the one command this passes over. It refuses the same shape one layer down with
 * a sentence about what a dropped id would cost - a record left filed - which is the reason
 * this bound exists at all and not a sentence a count can say.
 */
export function arityRefusal(
  command: string | undefined, operands: readonly string[],
): ResultObject | undefined {
  if (command === undefined || command === 'remove') return undefined
  const known = commandNamed(command)
  if (known === undefined) return undefined
  const most = operandLimit(known, operands)
  if (most === undefined || operands.length <= most) return undefined
  return errorResult({
    code: 'VALIDATION', command, workspace: '-', effect: 'read', rule: 'C1',
    cause: `${command} takes ${counted(most)} operand${most === 1 ? '' : 's'} and this line writes ${operands.length}, so operand ${most + 1} would be read by nothing`,
    fix: [`treadling help ${command}`],
  })
}
