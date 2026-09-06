// SPDX-License-Identifier: Apache-2.0
// Threat-model finding F5. DR3 rule 7 rejected five code points, U+202A to U+202E, and
// let through the isolate controls U+2066 to U+2069, the implicit marks U+200E, U+200F and
// U+061C, the zero-width characters, the BOM and the tag block. A stored U+2069 closes the
// directional isolate the tool's own renderer opens, so the wrapper that exists to confine
// reordering is defeated by the content it wraps.
//
// The fix is the class, not the seven names the audit happened to list: every Unicode
// character in the control (Cc), format (Cf) and surrogate (Cs) categories, plus the line
// and paragraph separators. Cf is what makes it whole; it carries every bidi control, the
// zero-width set, U+FEFF and the U+E00xx tag block that hides text from a reader entirely.
//
// This lives in the domain because the class is a field-validation rule, and because one
// home is the only way the store boundary and `validateWorkItem` cannot drift apart.

/**
 * Cc control, Cf format, Cs unpaired surrogate, Zl and Zp separators. One character class,
 * no quantifier at all, so it is linear and cannot backtrack (F8's ReDoS discipline).
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

/** Emoji sequences join with U+200D, which is Cf. Allowed only between two pictographs. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u

const NAMED: ReadonlyMap<number, string> = new Map([
  [0x061c, 'ARABIC LETTER MARK'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
])

export type UnsafeCharacter = {
  /** The offending code point. */
  readonly codePoint: number
  /** Its index in code points, counting from zero. */
  readonly at: number
  /** `U+202E RIGHT-TO-LEFT OVERRIDE`, so a refusal names the token rather than the class. */
  readonly label: string
}

/** `line` allows neither newline nor tab; `text` allows both and nothing else from the class. */
export type TextMode = 'line' | 'text'

function label(codePoint: number): string {
  const point = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
  const name = NAMED.get(codePoint)
  return name === undefined ? point : `${point} ${name}`
}

function allowed(codePoint: number, mode: TextMode): boolean {
  return mode === 'text' && (codePoint === 0x0a || codePoint === 0x09)
}

/**
 * The first character the class refuses, or undefined. The regex runs first so a clean
 * value costs one linear scan; the walk that names the character only runs on a refusal.
 */
export function findUnsafeCharacter(
  value: string,
  mode: TextMode = 'line',
): UnsafeCharacter | undefined {
  if (!UNSAFE.test(value)) return undefined

  const points = [...value]
  for (let at = 0; at < points.length; at += 1) {
    const char = points[at] as string
    const codePoint = char.codePointAt(0) as number
    if (!UNSAFE.test(char) || allowed(codePoint, mode)) continue
    if (codePoint === 0x200d && isEmojiJoin(points, at)) continue
    return { codePoint, at, label: label(codePoint) }
  }
  return undefined
}

function isEmojiJoin(points: readonly string[], at: number): boolean {
  const before = points[at - 1]
  const after = points[at + 1]
  return before !== undefined && after !== undefined
    && PICTOGRAPH.test(before) && PICTOGRAPH.test(after)
}

export function isSafeText(value: string, mode: TextMode = 'line'): boolean {
  return findUnsafeCharacter(value, mode) === undefined
}

/**
 * A noun with its indefinite article: `an epic`, `an impediment`, `a story`. Every closed set
 * a message names a member of is spelled so that the first letter decides, and a message
 * that read `a impediment` was picked without looking.
 */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`
}
