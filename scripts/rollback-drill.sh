#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The rehearsal for docs/ROLLBACK.md. It runs the release gate against tags that should be
# refused and tags that should be accepted, in a throwaway clone of this repository, so the
# procedure in that document is one somebody has watched work rather than one somebody wrote.
#
# It creates tags. It creates them in a clone under a temporary directory and pushes nothing,
# which is why it is safe to run at any time and why it is not a workflow: a drill that could
# touch the real repository is not a drill.
#
# Usage: scripts/rollback-drill.sh
set -eu

SOURCE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/treadle-rollback-drill.XXXXXX")
cleanup() {
  [ -n "${WORK:-}" ] && [ -d "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT

CLONE="$WORK/treadle"
git clone --quiet --no-hardlinks "$SOURCE" "$CLONE"
cd "$CLONE"
# The preflight asks whether the tagged commit is on the released branch, and names that
# branch `origin/main`. In the clone that ref points at the source's main, which is not the
# branch under test, so the drill points it at what it is actually rehearsing.
git update-ref refs/remotes/origin/main HEAD
git switch --quiet -c drill-main
git config user.name "$(git -C "$SOURCE" config user.name)"
git config user.email "$(git -C "$SOURCE" config user.email)"

VERSION=$(node -p "require('./package.json').version")
npm ci --silent --ignore-scripts >/dev/null
npm run --silent build >/dev/null

# The preflight reads the release notes out of the changelog, and this clone's is empty
# because nothing has been released. The drill supplies the section a release would have.
printf '# Changelog\n\n## %s (2026-01-01)\n\n### Features\n\n* the drill wrote this\n' "$VERSION" > CHANGELOG.md

pass=0
fail=0

# Runs the preflight and asserts the outcome. `want` is `ok` or a fragment the refusal must
# name, so a scenario that fails for the wrong reason is not counted as a pass.
check() {
  what="$1"
  want="$2"
  shift 2
  out=$(node scripts/release-preflight.ts "$@" 2>&1) && rc=0 || rc=$?
  if [ "$want" = ok ]; then
    if [ "$rc" -eq 0 ]; then
      echo "PASS  $what"
      pass=$((pass + 1))
      return
    fi
  else
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "$want"; then
      echo "PASS  $what"
      pass=$((pass + 1))
      return
    fi
  fi
  echo "FAIL  $what (exit $rc, wanted $want)"
  printf '%s\n' "$out" | sed 's/^/      /'
  fail=$((fail + 1))
}

echo "== the tag the release path accepts"
git tag -s -m "release $VERSION" "v$VERSION"
check "a signed annotated tag at the tree's version, on main" ok \
  --tag "v$VERSION" --branch origin/main --notes-out "$WORK/notes.md"
if [ -s "$WORK/notes.md" ]; then echo "      notes: $(head -1 "$WORK/notes.md")"; fi

echo
echo "== the tags it refuses"
# tag.gpgsign is on for this user, so a bare `git tag` would produce a signed annotated one.
# Both of these have to be built deliberately against that default.
git -c tag.gpgsign=false tag "v$VERSION-light"
git -c tag.gpgsign=false tag -a -m "unsigned" unsigned-tag

check "a lightweight tag, which is what a GitHub Release creates" lightweight \
  --tag "v$VERSION-light" --branch origin/main
check "an annotated tag nothing signed" "no signature" \
  --tag unsigned-tag --branch origin/main

git tag -s -m "wrong version" v9.9.9
check "a tag naming a version the tree does not declare" "does not name" \
  --tag v9.9.9 --branch origin/main

git checkout --quiet -b sideline
git commit --quiet -s --allow-empty -m "chore: a commit that never reached main"
git tag -s -m "off main" v8.8.8
git checkout --quiet drill-main
check "a tag on a commit that never reached the released branch" "not on the released branch" \
  --tag v8.8.8 --branch origin/main

mv dist/treadle.js "$WORK/treadle.js"
check "a release with no bundle built" "does not exist" --tag "v$VERSION" --branch origin/main
mv "$WORK/treadle.js" dist/treadle.js

echo
echo "== the publication interlock"
check "publishing while the name has not been cleared" "publication interlock" \
  --tag "v$VERSION" --branch origin/main --publishing

echo
echo "== the hotfix path"
# What docs/ROLLBACK.md tells a person to do when a release was wrong: branch from the tag
# that was released, land the fix, and cut the next patch from it.
git checkout --quiet -b "hotfix/v$VERSION" "v$VERSION"
patch="$(node -p "const [a,b,c]=require('./package.json').version.split('.'); [a,b,Number(c)+1].join('.')")"
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("package.json", "utf8"));
  m.version = process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(m, null, 2) + "\n");
' "$patch"
printf '# Changelog\n\n## %s (2026-01-02)\n\n### Bug Fixes\n\n* the hotfix\n' "$patch" > CHANGELOG.md
git commit --quiet -s -a -m "fix: the hotfix this drill rehearses"
git checkout --quiet drill-main
git merge --quiet --no-ff -m "chore: land the hotfix" "hotfix/v$VERSION"
git update-ref refs/remotes/origin/main HEAD
git tag -s -m "release $patch" "v$patch"
check "a hotfix branched from the released tag, landed, and tagged" ok \
  --tag "v$patch" --branch origin/main

echo
echo "drill: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
