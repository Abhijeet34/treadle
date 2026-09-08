// SPDX-License-Identifier: Apache-2.0
// A name this repository removed may not still be spelled anywhere it would resolve to nothing.
//
// The cut that removed the sprint, the board, the retrospective and estimation left twenty-one
// stale references behind: comments naming a rule id that no longer exists, a fixture using a
// gate check that was deleted, budget prose describing an operation the rig no longer runs, and
// one live argv passing a flag the CLI now refuses, which aborted `npm run bench` on the branch.
// Its review caught five of them by reading; a sweep afterwards found the rest.
//
// The apparatus cut that followed it adds its own names below: the unenforced budget keys, the
// gate status that printed them, and three dead members the same sweep found.
//
// The proof of done that should have caught them could not. It was
// `git grep -niE '...\bpoints\b...\bboard\b'`, and `git grep -E` treats `\b` as a literal, so
// those two terms matched zero lines and 139 locations were never looked at. A search that
// examines nothing reports the same clean result as a search that finds nothing, and the count
// of zero is the only tell. This file replaces that grep: a JavaScript regex honours `\b`, the
// list is in the tree rather than in a brief, and the run prints what it examined.
//
// A removal ships by adding its names here. The test then refuses the tree until every comment,
// document, fixture, set and argv that still spells one is gone.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

type Retired = {
  /** The name as the tree spelled it. */
  readonly name: string
  /** The record or pull request that removed it, so a reader can look the decision up. */
  readonly by: string
  /**
   * The pattern to search for, where a bare word boundary would match ordinary English. `points`
   * is the field, and "the item points at evidence" is a sentence; matching the spellings only
   * the removed thing has keeps the list honest without an allowlist entry per prose file.
   */
  readonly spelling?: RegExp
}

/** Every name this repository has removed, with the record that removed it. */
const RETIRED: readonly Retired[] = [
  // ADR-0029: the sprint, the board, the retrospective, estimation and three flags.
  { name: 'sprint_id', by: 'ADR-0029' },
  { name: 'point_scale', by: 'ADR-0029' },
  { name: 'hours_estimate', by: 'ADR-0029' },
  { name: 'timebox_hours', by: 'ADR-0029' },
  { name: 'cycle_time_excludes_hold', by: 'ADR-0029' },
  { name: 'start_requires_sprint', by: 'ADR-0029' },
  { name: 'estimate_set', by: 'ADR-0029' },
  { name: 'MAX_GOAL', by: 'ADR-0029' },
  { name: 'BOARD_COLUMNS', by: 'ADR-0029' },
  { name: 'auditSprint', by: 'ADR-0029' },
  { name: 'Store.list', by: 'ADR-0029', spelling: /\bStore\.list\b|\bstore\.list\(/ },
  { name: '--points', by: 'ADR-0029', spelling: /--points\b/ },
  { name: '--sprint', by: 'ADR-0029', spelling: /--sprint\b/ },
  { name: '--preview', by: 'ADR-0029', spelling: /--preview\b/ },
  { name: '--color', by: 'ADR-0029', spelling: /--color\b/ },
  { name: '--no-input', by: 'ADR-0029', spelling: /--no-input\b/ },
  // The field names, matched only where they name the field rather than the English word.
  // A property access such as `item.points` is the compiler's to refuse, since the field left
  // the `WorkItem` type; what this has to catch is the name in prose, in an argv and in a record.
  { name: 'points', by: 'ADR-0029', spelling: /--points\b|^\s*points:|['"`]points['"`]/ },
  { name: 'component', by: 'ADR-0029', spelling: /--component\b|^\s*component:|['"`]component['"`]/ },
  // The rule ids, matched as the source and the tables spell them.
  { name: 'G4', by: 'ADR-0029', spelling: /['"`]G4['"`]|\bG4\b/ },
  { name: 'T2', by: 'ADR-0029', spelling: /['"`]T2['"`]|\bT2\b/ },
  { name: 'DOR5', by: 'ADR-0029' },
  { name: 'H26', by: 'ADR-0029' },
  { name: 'H28', by: 'ADR-0029' },
  { name: 'H29', by: 'ADR-0029' },
  { name: 'I5', by: 'ADR-0029, which moved the rule to V9' },
  // The apparatus cut: the benchmark budgets that could not fail a build, and the gate
  // status that served them. PR "cut the weight from treadle's apparatus", 2026-09-08.
  { name: 'OPEN MISS', by: 'the apparatus cut', spelling: /OPEN MISS|'open miss'/ },
  { name: 'openMisses', by: 'the apparatus cut' },
  { name: 'timingEnforced', by: 'the apparatus cut' },
  { name: 'timingWhy', by: 'the apparatus cut' },
  { name: 'worstRss', by: 'the apparatus cut' },
  { name: 'peakRssReadKb', by: 'the apparatus cut' },
  { name: 'peakRssMutationKb', by: 'the apparatus cut' },
  { name: 'indexToTextRatio', by: 'the apparatus cut' },
  // `firstIndexBuildMs` and `reindexAfterHandEditMs` are NOT listed: the budgets that read
  // them went, and the two measurements they read are still taken and still reported.
  // The `enforced` key on a budget row, which only ever meant `false`; every row is armed now.
  { name: 'enforced', by: 'the apparatus cut', spelling: /"enforced":/ },
  // `deps` as a commit type. It stays legitimate as a scope, which `chore(deps)` and
  // `ci(deps)` are, so this matches only the quoted type-enum entry.
  { name: 'deps', by: 'the apparatus cut', spelling: /'deps'/ },
  // Dead code the litter sweep found, each with no reader anywhere in the tree.
  { name: 'Diagnostics.level', by: 'the litter sweep', spelling: /\bDiagnostics\.level\b/ },
  { name: 'Generated.impediments', by: 'the litter sweep', spelling: /\bGenerated\.impediments\b/ },
  { name: 'Generated.relations', by: 'the litter sweep', spelling: /\bGenerated\.relations\b/ },
  // Earlier removals, kept here so the list is the whole set rather than the last change's.
  { name: 'src/adapters/init.ts', by: 'PR #24' },
]

/**
 * Where a retired name is still legitimate, each with the reason. Kept small on purpose: a wide
 * allowlist turns this file back into the grep it replaces.
 */
const ALLOWED_FILES: readonly (readonly [RegExp, string])[] = [
  // Every record, not only the superseded ones. A decision record states what was decided when
  // it was decided and this repository never rewrites one; a later record marks it overtaken
  // instead. So an ADR naming a removed thing is the record working, not a stale reference.
  [/^docs\/architecture\/adr\//, 'a decision record is never rewritten; a later record marks it overtaken or superseded'],
  [/^CHANGELOG\.md$/, 'generated release history, which records what each version removed'],
  [/^docs\/BENCHMARKS\.md$/, 'dated measurements of runs that happened; a figure is a fact about its run'],
  [/^docs\/VERIFICATION\.md$/, 'the same, plus the one sentence that names what the cut removed'],
  [/^\.work\/events\//, 'the append-only event log, which is never edited'],
  [/^\.work\/items\//, 'a stored record may carry a retired key by design until its next write; test/store/retired-fields.test.ts holds that behaviour'],
  [/^src\/adapters\/store\/item-codec\.ts$/, 'RETIRED_FIELDS is where a retired field is declared'],
  [/^test\/store\/retired-fields\.test\.ts$/, 'the test that proves a retired key is dropped and an unknown one is kept'],
  [/^test\/architecture\/retired-names\.test\.ts$/, 'this file is the list'],
]

/**
 * A passage that says a name is gone is not a stale reference to it. Read over a small window
 * rather than one line, because this repository writes one sentence per line and a sentence that
 * names four retired fields routinely wraps past the clause that says they were retired.
 */
const SAYS_IT_WENT = /\bremove[sd]\b|\bdropped\b|\bwent with\b|\bsupersede[sd]\b|\bretire[sd]\b|\bno longer\b|\bused to\b|\bis gone\b|\bare gone\b/i
const CONTEXT_LINES = 2

/** Tracked files this reader can read as text, which is every one git does not call binary. */
function trackedTextFiles(): readonly string[] {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((name) => name.length > 0)
  return listed.filter((name) => !/\.(png|jpg|jpeg|gif|ico|pdf|sqlite|woff2?)$/i.test(name))
}

function allowed(file: string): string | undefined {
  return ALLOWED_FILES.find(([pattern]) => pattern.test(file))?.[1]
}

describe('a name this repository removed is spelled nowhere it would resolve to nothing', () => {
  const files = trackedTextFiles()

  it('examined every tracked text file for every retired name', (t) => {
    assert.ok(files.length > 100, `only ${files.length} tracked text files were read`)
    assert.ok(RETIRED.length > 20, `only ${RETIRED.length} retired names are listed`)
    t.diagnostic(`${files.length} files examined for ${RETIRED.length} retired names`)
  })

  it('finds no stale reference outside the stated allowlist', () => {
    const stale: string[] = []
    for (const file of files) {
      if (allowed(file) !== undefined) continue
      let text: string
      try {
        text = readFileSync(path.join(ROOT, file), 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (const entry of RETIRED) {
        // Built per file so `lastIndex` on a global pattern can never leak between files.
        const pattern = entry.spelling ?? new RegExp(`\\b${entry.name.replaceAll('.', '\\.')}\\b`)
        for (const [at, line] of lines.entries()) {
          if (!pattern.test(line)) continue
          const window = lines.slice(Math.max(0, at - CONTEXT_LINES), at + CONTEXT_LINES + 1).join('\n')
          if (SAYS_IT_WENT.test(window)) continue
          stale.push(`${file}:${at + 1}: ${entry.name} (removed by ${entry.by}): ${line.trim().slice(0, 120)}`)
        }
      }
    }
    assert.deepEqual(stale, [],
      `these spell a name this repository removed, and it resolves to nothing:\n  ${stale.join('\n  ')}`)
  })
})
