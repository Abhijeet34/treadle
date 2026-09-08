// SPDX-License-Identifier: Apache-2.0
// Conventional Commits, with the type list this project actually uses.
// CONTRIBUTING.md carries the same list in prose; this file is what CI enforces.

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // `build` and not `deps`, decided against the evidence rather than by taste:
    // release-please-config.json maps `build` to a changelog section and has no `deps`
    // section at all, history holds two `build` commits and zero `deps` ones, and
    // Dependabot writes `ci(deps)` and `chore(deps)`, where `deps` is the scope and not
    // the type. A type this file allows and the changelog drops is a commit nobody reads.
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'chore', 'build', 'ci', 'test', 'perf', 'refactor']],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 72],
    'body-max-line-length': [0],
    // A `Removes-test:` trailer has to name the title exactly as the source declared it
    // (ADR-0013), and this project's test titles are sentences. The 100-character default
    // made the two rules contradict each other: a title such as "file --parent on a type
    // nothing may parent offers the line that files it alone, not an id that was never
    // filed" is 110 characters, and its declaration is longer still.
    'footer-max-line-length': [0],
  },
}
