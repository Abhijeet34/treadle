// SPDX-License-Identifier: Apache-2.0
// A pull request may not quietly drop a test that main already has.
//
// #29 was rebased onto a main that carried #28, four service files conflicted, and the
// resolution took the pre-rebase file whole. That threw away #28's code and #28's tests in
// one move, so the suite reported 1132 passing tests and all ten checks were green while four
// landed fixes sat one merge away from being undone. A test only protects a behaviour while
// the test survives, so a suite cannot be asked whether a suite was cut.
//
// The comparison is therefore against a commit on main and never against the branch. The set
// of test titles at the merge base is a fact about main that a resolution cannot edit,
// however completely it rewrites the branch's own files. `strict_required_status_checks_policy`
// in .github/rulesets/main.json is what keeps that merge base at main's tip: a branch behind
// main cannot merge, so the comparison a merge is gated on is always against main as it is.
//
// A removal that is meant is declared in a commit message, one trailer naming one exact
// title, and CONTRIBUTING.md carries the wording. What the mechanism does not see is in
// docs/VERIFICATION.md under "What check-tests-kept does not see".
//
// Usage: node scripts/check-tests-kept.ts [<branch-ref>] [<head-ref>], defaulting to origin/main and HEAD

import { execFileSync } from 'node:child_process'
import process from 'node:process'

/** `describe`, `it` or `test` opening a line, with an optional `.skip`-style modifier. */
const DECLARATION = /^[ \t]*(describe|it|test)(?:\.([A-Za-z0-9_$]+))?[ \t]*\(/

/** The same call anywhere on a line, and not as a property of something else, which is what
 *  keeps `PART.test(cell)` out. Used only to count, never to read a title. */
const ANYWHERE = /(?<![.\w$])(?:describe|it|test)(?:\.[A-Za-z0-9_$]+)?[ \t]*\(/g

/** Node runs everything else, `.only` included. */
const INACTIVE = new Set(['skip', 'todo'])

const TRAILER = 'Removes-test'

type Inventory = {
  /** Title to the files that declare it as a test that runs. A title declared twice is
   *  listed twice, so removing one of a pair is a shortfall of one. */
  readonly active: Map<string, string[]>
  readonly inactive: Map<string, string[]>
  /** Declarations whose title is not a literal, so no name can be compared. */
  readonly dynamic: number
  /** Files carrying a declaration this reader cannot see, which would be a silent gap. */
  readonly unreadable: readonly string[]
  readonly files: number
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** The file with its comments and the inside of its string literals removed, so that neither
 *  prose about a test nor a fixture holding the text of one is counted as a declaration. The
 *  titles themselves are read from the raw line, so nothing is lost by emptying them here.
 *
 *  A `/` that opens a regular expression is read as division, which can swallow a line whose
 *  regex ends with `//`; that undercounts, and undercounting cannot fail this check. */
function codeOnly(source: string): string {
  let out = ''
  let at = 0
  while (at < source.length) {
    const ch = source[at]!
    if (ch === '/' && source[at + 1] === '/') {
      const end = source.indexOf('\n', at)
      at = end === -1 ? source.length : end
      continue
    }
    if (ch === '/' && source[at + 1] === '*') {
      const end = source.indexOf('*/', at + 2)
      at = end === -1 ? source.length : end + 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let end = at + 1
      while (end < source.length && source[end] !== ch) {
        if (source[end] === '\\') end += 1
        end += 1
      }
      out += ch + ch
      at = end + 1
      continue
    }
    out += ch
    at += 1
  }
  return out
}

const NAMED: Readonly<Record<string, string>> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0',
}

/** A title is compared as the string the runner receives, so the two sides of the comparison
 *  agree when only the quoting of a title changes. */
function decode(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, escape: string) => {
    if (escape.startsWith('u{')) return String.fromCodePoint(Number.parseInt(escape.slice(2, -1), 16))
    if (escape.startsWith('u') || escape.startsWith('x')) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
    return NAMED[escape] ?? escape
  })
}

/** The title of a declaration, or undefined when it is not a string literal on this line: an
 *  identifier, or a string that does not close before the newline.
 *
 *  A template's interpolations are collapsed to a bare `${}`, because what identifies the
 *  declaration is the skeleton around them. 58 of this repository's 773 declarations name
 *  their subject that way and would otherwise be invisible to the comparison. */
function titleAt(line: string, from: number): string | undefined {
  let at = from
  while (line[at] === ' ' || line[at] === '\t') at += 1
  const quote = line[at]
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined
  let raw = ''
  for (let i = at + 1; i < line.length; i += 1) {
    const ch = line[i]!
    if (ch === '\\') {
      raw += ch + (line[i + 1] ?? '')
      i += 1
      continue
    }
    if (quote === '`' && ch === '$' && line[i + 1] === '{') {
      let depth = 1
      let end = i + 2
      while (end < line.length && depth > 0) {
        if (line[end] === '{') depth += 1
        else if (line[end] === '}') depth -= 1
        end += 1
      }
      if (depth > 0) return undefined
      raw += '${}'
      i = end - 1
      continue
    }
    if (ch === quote) return decode(raw)
    raw += ch
  }
  return undefined
}

function record(into: Map<string, string[]>, title: string, file: string): void {
  const seen = into.get(title)
  if (seen === undefined) into.set(title, [file])
  else seen.push(file)
}

/** Every tracked test source at `ref`, read once, in one pass over each file. */
function inventoryOf(ref: string): Inventory {
  const files = git(['ls-tree', '-r', '-z', '--name-only', ref, '--', 'test'])
    .split('\0')
    .filter((file) => file.endsWith('.ts'))

  const active = new Map<string, string[]>()
  const inactive = new Map<string, string[]>()
  const unreadable: string[] = []
  let dynamic = 0

  for (const file of files) {
    const source = git(['show', `${ref}:${file}`])
    let declared = 0
    for (const line of source.split('\n')) {
      const match = DECLARATION.exec(line)
      if (match === null) continue
      declared += 1
      const title = titleAt(line, match[0].length)
      if (title === undefined) {
        dynamic += 1
        continue
      }
      record(INACTIVE.has(match[2] ?? '') ? inactive : active, title, file)
    }
    // A declaration this reader did not see is a hole in the comparison rather than a pass,
    // so it is named here and fails the run.
    const anywhere = (codeOnly(source).match(ANYWHERE) ?? []).length
    if (anywhere > declared) unreadable.push(`${file} (${anywhere - declared} of ${anywhere})`)
  }

  return { active, inactive, dynamic, unreadable, files: files.length }
}

/** Every `Removes-test:` trailer in the range, one entry per trailer. */
function declaredRemovals(base: string, head: string): string[] {
  return git(['log', '--no-merges', `--format=%(trailers:key=${TRAILER},valueonly)`, `${base}..${head}`])
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function total(titles: Map<string, string[]>): number {
  let count = 0
  for (const files of titles.values()) count += files.length
  return count
}

function main(): void {
  const [branch = 'origin/main', head = 'HEAD'] = process.argv.slice(2)

  // The merge base and not the branch tip: a commit that is on main is what the branch cannot
  // edit, and it is main's tip whenever the branch is up to date, which is what the ruleset
  // requires before a merge. Comparing against the tip instead would read a test main gained
  // after the fork as one this branch deleted.
  let base: string
  try {
    base = git(['merge-base', branch, head]).trim()
  } catch {
    console.error(`check-tests-kept: ${branch} and ${head} share no history, so there is no commit to compare against`)
    process.exit(2)
  }

  const before = inventoryOf(base)
  const after = inventoryOf(head)
  const problems: string[] = []

  // A base holding test files that declare nothing means the reader is broken or the ref is
  // wrong, and every later comparison would pass by having nothing to compare. A base holding
  // no test files at all is the first commit of a repository, where there is nothing to keep.
  if (before.files > 0 && total(before.active) === 0) {
    console.error(`check-tests-kept: ${base} has ${before.files} files under test/ and no test in any of them`)
    process.exit(1)
  }

  for (const [ref, side] of [[base, before], [head, after]] as const) {
    for (const file of side.unreadable) {
      problems.push(
        `FAIL  ${file} at ${ref.slice(0, 8)}\n` +
        '      a describe, it or test call here does not open its line\n' +
        '      this check reads a title only where the call starts the line, so it cannot tell you\n' +
        '      when that test disappears; move the call to the start of its line',
      )
    }
  }

  const declared = declaredRemovals(base, head)
  const unclaimed = new Map<string, number>()
  for (const title of declared) unclaimed.set(title, (unclaimed.get(title) ?? 0) + 1)

  const removed: { title: string; files: readonly string[]; shortfall: number; skipped: boolean }[] = []
  for (const [title, files] of before.active) {
    const shortfall = files.length - (after.active.get(title)?.length ?? 0)
    if (shortfall <= 0) continue
    removed.push({
      title,
      files,
      shortfall,
      skipped: (after.inactive.get(title)?.length ?? 0) > (before.inactive.get(title)?.length ?? 0),
    })
  }
  removed.sort((a, b) => a.title.localeCompare(b.title))

  let undeclared = 0
  for (const gone of removed) {
    const covered = Math.min(gone.shortfall, unclaimed.get(gone.title) ?? 0)
    unclaimed.set(gone.title, (unclaimed.get(gone.title) ?? 0) - covered)
    if (covered >= gone.shortfall) {
      console.log(`ok    declared  ${gone.title}`)
      continue
    }
    undeclared += 1
    const where = gone.files.join(', ')
    problems.push(
      `FAIL  ${gone.title}\n` +
      `      ${where} declares it at ${base.slice(0, 8)} and this branch does not\n` +
      (gone.skipped
        ? '      this branch declares it .skip, which runs nothing and asserts nothing\n'
        : '') +
      '      restore the test, or record the removal in a commit message trailer:\n' +
      `        ${TRAILER}: ${gone.title}`,
    )
  }

  for (const [title, left] of unclaimed) {
    if (left <= 0) continue
    problems.push(
      `FAIL  ${TRAILER}: ${title}\n` +
      `      no commit in ${base.slice(0, 8)}..${head.slice(0, 8)} removes a test with that title\n` +
      '      the declaration names nothing; drop the trailer, or correct the title it names',
    )
  }

  for (const problem of problems) console.error(problem)
  console.log(
    `check-tests-kept: ${total(before.active)} tests at ${base.slice(0, 8)}, the merge base of ` +
    `${branch} and ${head}, ${total(after.active)} here, ` +
    `${undeclared} removed without a ${TRAILER} trailer, ${declared.length} declared, ` +
    `${after.dynamic} titles not literal and not compared`,
  )
  process.exitCode = problems.length === 0 ? 0 : 1
}

main()
