#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The rehearsal for docs/RELEASING.md's "Rolling back" and "The drill" sections. It runs the
# release gate against tags that should be refused and tags that should be accepted, in a
# throwaway clone of this repository, so the procedure in that document is one somebody has
# watched work rather than one somebody wrote.
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
# --no-tags because the drill creates `v<the tree's version>` and the source now carries a real
# release tag of that name: without it the first scenario died at `tag 'v0.1.0' already exists`,
# which is a drill that stops working the moment the thing it rehearses happens once.
git clone --quiet --no-hardlinks --no-tags "$SOURCE" "$CLONE"
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

# The preflight reads the release notes out of the changelog, and the drill supplies its own
# section rather than depending on whatever the clone's changelog happens to carry.
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

# tag.gpgsign is on for this user, so a bare `git tag` produces a signed annotated one. Every
# tag here is built against that default with `-c tag.gpgsign=false`, because the tag the
# release path now sees is the lightweight, unsigned one release-please creates (ADR-0037).
echo "== the tag the release path accepts"
git -c tag.gpgsign=false tag "v$VERSION"
RELEASED=$(git rev-parse "v$VERSION^{}")
check "the lightweight tag release-please creates, at the tree's version, on main" ok \
  --tag "v$VERSION" --commit "$RELEASED" --branch origin/main --notes-out "$WORK/notes.md"
if [ -s "$WORK/notes.md" ]; then echo "      notes: $(head -1 "$WORK/notes.md")"; fi

echo
echo "== the tags it refuses"
git -c tag.gpgsign=false tag v9.9.9
check "a tag naming a version the tree does not declare" "does not name" \
  --tag v9.9.9 --commit "$(git rev-parse v9.9.9)" --branch origin/main

# The clause that replaced the signature: the name was already on the forge, pointing at a
# tree this run never released, and after the fact nothing else tells the two apart.
check "a tag that existed before this run, pointing at a tree it did not release" \
  "must be deleted rather than reused" \
  --tag "v$VERSION" --commit "$(git rev-parse HEAD~1)" --branch origin/main

git checkout --quiet -b sideline
git commit --quiet -s --allow-empty -m "chore: a commit that never reached main"
git -c tag.gpgsign=false tag v8.8.8
SIDELINE=$(git rev-parse v8.8.8)
git checkout --quiet drill-main
check "a tag on a commit that never reached the released branch" "not on the released branch" \
  --tag v8.8.8 --commit "$SIDELINE" --branch origin/main

mv dist/treadle.js "$WORK/treadle.js"
check "a release with no bundle built" "does not exist" \
  --tag "v$VERSION" --commit "$RELEASED" --branch origin/main
mv "$WORK/treadle.js" dist/treadle.js

echo
echo "== the publish refusals, each on a manifest broken to make it fire"
# The tree satisfies every publishing clause today, so each one here is a regression guard and
# not a first setup, and the only way to watch a guard hold is to break what it guards. Each
# scenario edits the clone's manifest, runs the gate, and puts the field back.
#
# `repository` is the expensive one. Trusted publishing generates provenance by default and
# npm's prerequisites require a public repository field, so without it the publish fails at the
# registry with the tag already cut - and .github/rulesets/tags.json forbids deleting or moving
# a `v*` tag, so that costs a version number permanently. Two have been spent that way already.
manifest() {
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync("package.json", "utf8"));
    (new Function("m", process.argv[1]))(m);
    fs.writeFileSync("package.json", JSON.stringify(m, null, 2) + "\n");
  ' "$1"
}
publishes() {
  what="$1"
  want="$2"
  edit="$3"
  cp package.json "$WORK/package.json.kept"
  manifest "$edit"
  check "$what" "$want" --tag "v$VERSION" --commit "$RELEASED" --branch origin/main --publishing
  cp "$WORK/package.json.kept" package.json
}

# `private: true` left the manifest when the first release was cut, so the tree as it stands
# trips nothing here and this scenario had been failing at exit 0 against a preflight that was
# right. What the clause still does is refuse the field coming back.
publishes "publishing a manifest that carries private again" "publication interlock" \
  'm.private = true'
publishes "publishing with no licence npm would accept" "which npm will not publish" \
  'm.license = "UNLICENSED"'
publishes "publishing with the licence field gone" "which npm will not publish" \
  'delete m.license'
publishes "publishing with no files allowlist, which would ship the whole tree" "files allowlist" \
  'delete m.files'
publishes "publishing with no repository, which npm rejects after the tag is cut" "provenance" \
  'delete m.repository'
publishes "publishing a bin that points outside the bundle" "must point into the bundle" \
  'm.bin = { treadle: "bin/treadle.js" }'

# The other half of the same truth, and the reason the release says so on its own page: nothing
# in this gate stops publication any more. NPM_PUBLISH_ENABLED and the npm-publish environment
# are what hold it, and neither is a file this script can read.
check "publishing the manifest as it stands, which this gate no longer refuses" ok \
  --tag "v$VERSION" --commit "$RELEASED" --branch origin/main --publishing

echo
echo "== the hotfix path"
# What docs/RELEASING.md's "Rolling back" section tells a person to do when a release was
# wrong: branch from the tag that was released, land the fix, and cut the next patch from it.
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
git -c tag.gpgsign=false tag "v$patch"
check "a hotfix branched from the released tag, landed, and tagged" ok \
  --tag "v$patch" --commit "$(git rev-parse "v$patch^{}")" --branch origin/main

echo
echo "drill: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
