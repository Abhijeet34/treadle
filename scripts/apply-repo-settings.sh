#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Applies the repository settings that are not files, from the files that describe them.
# Idempotent: a ruleset whose name already exists is updated in place rather than duplicated,
# which is what makes this safe to re-run after editing one of the JSON files.
#
# Usage: scripts/apply-repo-settings.sh OWNER/REPO
#
# Every step runs even when an earlier one fails, and every failure is named together at the
# end. Stopping at the first refusal exited 1 having applied some settings and not others,
# and the exit code could not say which half happened: on 2026-09-05 a rejected tag ruleset
# silently skipped the repository settings and both Actions permission calls.
#
# docs/RELEASING.md, "The settings that are not files", carries the reasoning; this file
# carries the commands so nobody retypes them.
set -u

REPO="${1:?usage: apply-repo-settings.sh OWNER/REPO}"
cd "$(dirname "$0")/.." || exit 1

failed=''

# Records one step that did not apply, newline separated. The operator needs to know
# precisely what is still unset, not just that something is.
fail() {
  failed="${failed}${failed:+
}$1"
}

apply_ruleset() {
  file="$1"
  if ! name=$(node -p "JSON.parse(require('fs').readFileSync('$file','utf8')).name"); then
    fail "ruleset from $file (its name could not be read)"
    return
  fi
  # The listing is captured on its own rather than inside the id pipeline: a failed list
  # reads as "no ruleset by that name", which would turn an update into a create.
  if ! listing=$(gh-axi api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id"); then
    fail "ruleset $name from $file (the existing rulesets could not be listed)"
    return
  fi
  # A name that matches nothing leaves the tool printing an empty-body notice rather than
  # nothing at all, so the id is taken only if it is all digits.
  id=$(printf '%s\n' "$listing" | tr -d ' ' | grep -E '^[0-9]+$' || true)
  if [ -n "$id" ]; then
    echo "updating ruleset $name ($id) from $file"
    gh-axi api -X PUT "repos/$REPO/rulesets/$id" --input "$file" || fail "ruleset $name from $file"
  else
    echo "creating ruleset $name from $file"
    gh-axi api -X POST "repos/$REPO/rulesets" --input "$file" || fail "ruleset $name from $file"
  fi
}

apply_ruleset .github/rulesets/main.json
apply_ruleset .github/rulesets/tags.json

# Squash only, and keep the commit messages: a Release-As: footer has to survive.
gh-axi api -X PATCH "repos/$REPO" --input .github/settings/repository.json \
  || fail 'repository settings from .github/settings/repository.json'

# Read-only default token, and no unpinned action can come back. `enabled` is required in the
# second body: sending sha_pinning_required on its own is a validation error, not a partial
# update.
gh-axi api -X PUT "repos/$REPO/actions/permissions/workflow" \
  --input .github/settings/actions-workflow-permissions.json \
  || fail 'workflow permissions from .github/settings/actions-workflow-permissions.json'
gh-axi api -X PUT "repos/$REPO/actions/permissions" \
  --input .github/settings/actions-permissions.json \
  || fail 'Actions permissions from .github/settings/actions-permissions.json'

if [ -n "$failed" ]; then
  echo "did NOT apply:" >&2
  printf '%s\n' "$failed" | sed 's/^/  - /' >&2
  echo "everything else was applied. this script is idempotent, so re-run it once these are fixed." >&2
  exit 1
fi

echo "applied. verify:"
echo "  gh-axi api \"repos/$REPO/rulesets\""
echo "  gh-axi api \"repos/$REPO/actions/permissions/workflow\""
