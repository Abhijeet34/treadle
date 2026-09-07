// SPDX-License-Identifier: Apache-2.0
// Conventional Commits, with the type list this project actually uses.
// CONTRIBUTING.md carries the same list in prose; this file is what CI enforces.

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'chore', 'deps', 'ci', 'test', 'perf', 'refactor']],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 72],
    'body-max-line-length': [0],
    // A `Removes-test:` trailer has to name the title exactly as the source declared it
    // (ADR-0013), and this project's test titles are sentences. The 100-character default
    // made the two rules contradict each other: the only conforming declaration of
    // "sums the points of non-cancelled descendants and excludes cancelled ones from both
    // sides" is 102 characters long.
    'footer-max-line-length': [0],
  },
}
