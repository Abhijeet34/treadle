// SPDX-License-Identifier: Apache-2.0
// Reads the live rulesets off the forge and refuses a repository whose rulesets disagree with
// the files in .github/rulesets/. Those files describe what GitHub is meant to enforce; nothing
// until now read back what it actually enforces.
//
// `.github/rulesets/tags.json` dropped `required_signatures` in #97 and the live tag ruleset
// 22316869 was created and last modified in the same second on 2026-09-05 and never touched
// again, so that edit changed documentation and nothing else. `release-tag` then created an
// unsigned tag as the automation and GitHub refused it, which surfaced as
// `Resource not accessible by integration` and reads like a token problem it is not.
// This check also found a second, older drift nobody was looking for: main.json named only
// `tests kept` beside `checks` since #32, and live ruleset 22314350 also requires `secret scan`,
// which no file named, so the guard ADR-0013 argues for has never been a required context on
// main. A drift check says only that the two sides disagree, not which one is right: the file
// gained `secret scan` rather than losing `tests kept`, because the live rule was the one worth
// keeping. `tests kept` remains the gap this check still reports against the live ruleset.
//
// No credential. Both ruleset endpoints answer an unauthenticated request on a public
// repository, measured at HTTP 200, so this runs under the read-only default workflow token or
// under no token at all. A token is sent when one is in the environment, because one field
// needs it: `bypass_actors` is served only to a reader who administers the repository. Measured
// against cli/cli, where this account is not an administrator, the ruleset response carries
// `conditions`, `rules` and `enforcement` and no `bypass_actors` at all. An added bypass actor
// is therefore invisible to an unprivileged read, and the report says so rather than counting
// the field as matching. docs/RELEASING.md, "Keeping the rulesets and the files in step".
//
// Usage: node scripts/check-ruleset-drift.ts [OWNER/REPO]

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RULESET_DIR = path.join(ROOT, '.github', 'rulesets')

export type Rule = { readonly type?: string; readonly parameters?: Record<string, unknown> }
export type Ruleset = {
  readonly id?: number
  readonly name?: string
  readonly rules?: readonly Rule[]
  readonly [field: string]: unknown
}

/** `drift` fails the check. `note` is something the reader must see and cannot act on by
 *  editing a file: an unstated default, or a field this reader was not allowed to see. */
export type Finding = {
  readonly severity: 'drift' | 'note'
  readonly where: string
  readonly detail: string
}

/** Everything outside `rules` that describes what the ruleset does. `id`, `node_id`, `source`,
 *  `source_type`, `created_at`, `updated_at`, `_links` and `current_user_can_bypass` are the
 *  forge's own bookkeeping, are not sent when the ruleset is applied, and are not compared. */
const COMPARED_FIELDS = ['target', 'enforcement', 'conditions', 'bypass_actors'] as const

/**
 * Sorts every array and every object key, so a comparison is about content and not about the
 * order GitHub happened to serialise in. Every array in a ruleset is a set: the rules, the
 * required contexts, the allowed merge methods, the ref patterns and the bypass actors all mean
 * the same thing in any order, and a check that reddened on a reordered context would be
 * retired within a week.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1))
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key])
    return out
  }
  return value
}

const show = (value: unknown): string => JSON.stringify(canonical(value) ?? null)
const same = (left: unknown, right: unknown): boolean => show(left) === show(right)

/** One rule per type. Two rules of one type is not a shape GitHub produces for these targets,
 *  and quietly keeping the last would hide half of whatever produced it. */
function byType(rules: readonly Rule[] | undefined, source: string): Map<string, Rule> {
  const out = new Map<string, Rule>()
  for (const rule of rules ?? []) {
    const type = rule.type ?? '(untyped)'
    if (out.has(type)) throw new Error(`${source} carries two ${type} rules`)
    out.set(type, rule)
  }
  return out
}

/**
 * Compares the parameters the file states against the parameters the forge reports.
 *
 * Every key the file states must match. A key only the forge reports is a note rather than
 * drift, and the reason is that the file has to be sendable back: GitHub fills defaults into a
 * ruleset it accepts and serves keys its own published API description does not carry, so
 * `require_extra_approval_for_unattributed_changes` is in the live `pull_request` parameters and
 * is absent from `repository-rule-pull-request` in github/rest-api-description. A file that
 * mirrored the response could be refused by the endpoint that applies it.
 */
function compareParameters(type: string, file: Rule, live: Rule): Finding[] {
  const stated = file.parameters ?? {}
  const actual = live.parameters ?? {}
  const findings: Finding[] = []

  for (const key of Object.keys(stated).sort()) {
    if (!same(stated[key], actual[key])) {
      findings.push({
        severity: 'drift',
        where: `rules.${type}.parameters.${key}`,
        detail: `file ${show(stated[key])}, live ${show(actual[key])}`,
      })
    }
  }
  const unstated = Object.keys(actual)
    .filter((key) => !(key in stated))
    .sort()
  if (unstated.length > 0) {
    findings.push({
      severity: 'note',
      where: `rules.${type}.parameters`,
      detail: `live also carries ${unstated.map((key) => `${key}=${show(actual[key])}`).join(', ')}, which the file does not state`,
    })
  }
  return findings
}

/** Every way one file and the live ruleset of the same name can disagree. */
export function compareRuleset(file: Ruleset, live: Ruleset): readonly Finding[] {
  const findings: Finding[] = []

  for (const field of COMPARED_FIELDS) {
    // Absent is not empty. An unprivileged read omits bypass_actors entirely, and calling that
    // a match would report "no drift" over the one field an attacker would edit.
    if (field === 'bypass_actors' && !(field in live)) {
      findings.push({
        severity: 'note',
        where: 'bypass_actors',
        detail:
          `not in the response, so it was NOT compared against the file's ${show(file[field] ?? [])}; ` +
          'only a read by a repository administrator carries this field',
      })
      continue
    }
    if (!same(file[field], live[field])) {
      findings.push({
        severity: 'drift',
        where: field,
        detail: `file ${show(file[field])}, live ${show(live[field])}`,
      })
    }
  }

  const stated = byType(file.rules, `${file.name}.json`)
  const actual = byType(live.rules, `the live "${live.name}" ruleset`)
  for (const [type, rule] of stated) {
    const counterpart = actual.get(type)
    if (counterpart === undefined) {
      findings.push({
        severity: 'drift',
        where: `rules.${type}`,
        detail: 'the file states this rule and the live ruleset does not enforce it',
      })
      continue
    }
    findings.push(...compareParameters(type, rule, counterpart))
  }
  for (const type of actual.keys()) {
    if (stated.has(type)) continue
    findings.push({
      severity: 'drift',
      where: `rules.${type}`,
      detail: 'the live ruleset enforces this rule and the file does not state it',
    })
  }
  return findings
}

export type Report = {
  readonly ok: boolean
  readonly lines: readonly string[]
}

/**
 * Both directions. A file naming a ruleset the forge does not have has never been applied, and a
 * live ruleset no file describes is a rule this tree cannot account for; each is drift on its
 * own. The name is the join, because the name is what scripts/apply-repo-settings.sh matches on.
 */
export function driftReport(
  files: readonly { readonly source: string; readonly ruleset: Ruleset }[],
  live: readonly Ruleset[],
): Report {
  const lines: string[] = []
  let ok = true
  const seen = new Set<string>()

  for (const { source, ruleset } of files) {
    const name = ruleset.name ?? '(unnamed)'
    seen.add(name)
    const counterpart = live.find((candidate) => candidate.name === name)
    if (counterpart === undefined) {
      ok = false
      lines.push(`${source}: no live ruleset is named "${name}", so this file has never applied`)
      continue
    }
    const findings = compareRuleset(ruleset, counterpart)
    const drifted = findings.filter((finding) => finding.severity === 'drift')
    if (drifted.length > 0) ok = false
    lines.push(
      `${source} vs live ruleset ${counterpart.id ?? '?'} ("${name}"): ` +
        (drifted.length === 0 ? 'matches' : `${drifted.length} difference(s)`),
    )
    for (const finding of findings) {
      lines.push(`  ${finding.severity === 'drift' ? 'DRIFT' : 'note '} ${finding.where}: ${finding.detail}`)
    }
  }

  for (const ruleset of live) {
    if (seen.has(ruleset.name ?? '(unnamed)')) continue
    ok = false
    lines.push(
      `live ruleset ${ruleset.id ?? '?'} ("${ruleset.name}") is enforced and no file in ` +
        '.github/rulesets/ describes it',
    )
  }
  return { ok, lines }
}

/** The files, read in a stable order so two runs report the same thing. */
export function rulesetFiles(
  dir: string = RULESET_DIR,
): readonly { readonly source: string; readonly ruleset: Ruleset }[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => ({
      source: `.github/rulesets/${entry}`,
      ruleset: JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as Ruleset,
    }))
}

/** The list endpoint omits `rules` and `conditions` for every caller, so each ruleset is read
 *  again by id. That second read is also the only one that can carry `bypass_actors`. */
export async function liveRulesets(
  repo: string,
  request: (endpoint: string) => Promise<unknown>,
): Promise<readonly Ruleset[]> {
  const listed = ((await request(`repos/${repo}/rulesets`)) ?? []) as readonly Ruleset[]
  return Promise.all(
    listed.map(async (entry) => (await request(`repos/${repo}/rulesets/${entry.id}`)) as Ruleset),
  )
}

/** `OWNER/REPO` from the argument, then the environment Actions sets, then the manifest, so the
 *  command a person runs takes no argument at all. */
export function repositoryName(argument: string | undefined, env: NodeJS.ProcessEnv): string {
  if (argument !== undefined && argument !== '') return argument
  if (env['GITHUB_REPOSITORY']) return env['GITHUB_REPOSITORY']
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    repository?: { url?: string }
  }
  const url = manifest.repository?.url ?? ''
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
  if (match?.[1] === undefined) throw new Error(`no repository could be read from ${url || 'package.json'}`)
  return match[1]
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const repo = repositoryName(process.argv[2], process.env)
  const apiUrl = process.env['GITHUB_API_URL'] ?? 'https://api.github.com'
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']

  const request = async (endpoint: string): Promise<unknown> => {
    const response = await fetch(`${apiUrl}/${endpoint}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`GET ${endpoint} answered ${response.status}: ${body}`)
    return body ? (JSON.parse(body) as unknown) : null
  }

  console.log(`${repo}, read ${token ? 'with' : 'without'} a token`)
  const report = driftReport(rulesetFiles(), await liveRulesets(repo, request))
  for (const line of report.lines) console.log(line)
  if (!report.ok) {
    console.error(
      '::error::the live rulesets and .github/rulesets/ disagree. ' +
        'scripts/apply-repo-settings.sh sends the files to the forge; ' +
        'docs/RELEASING.md, "Keeping the rulesets and the files in step"',
    )
  }
  process.exitCode = report.ok ? 0 : 1
}
