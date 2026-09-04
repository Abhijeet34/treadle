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
  },
}
