#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Every commit in the range carries a Signed-off-by trailer matching its author.
# The DCO (https://developercertificate.org/) is a statement that the author wrote the
# change or has the right to submit it; an unmatched trailer is not that statement.
#
# One authored identity cannot sign off under its own address: GitHub mints an App's commit
# address as <numeric-id>+<app-slug>[bot]@users.noreply.github.com, which does not receive
# mail, so Dependabot authors from that address and signs off as <support@github.com>. The
# certificate there is the App's name, and that is what this accepts: an App author's trailer
# must still name the author, only the address may differ. The upstream DCO app answers the
# same case by skipping the commit entirely when the forge reports author.type == "Bot"
# (dcoapp/app lib/dco.js:23), which this cannot see from commit metadata and would not want:
# a trailer that names nobody certifies nothing.
#
# Usage: scripts/check-dco.sh <base-ref> <head-ref>

set -euo pipefail

base="${1:?usage: check-dco.sh <base-ref> <head-ref>}"
head="${2:?usage: check-dco.sh <base-ref> <head-ref>}"

commits=$(git rev-list --no-merges "${base}..${head}")
if [ -z "${commits}" ]; then
  echo "check-dco: no commits in ${base}..${head}"
  exit 0
fi

# True when the author is a GitHub App: the address sits in GitHub's noreply namespace and
# carries the same App name the commit is authored under, so it is minted rather than claimed.
# A commit that merely calls its author a bot does not satisfy this.
is_github_app_identity() {
  local name="$1" email="$2" id
  case "${name}" in *'[bot]') ;; *) return 1 ;; esac
  id="${email%"+${name}@users.noreply.github.com"}"
  [ "${id}" != "${email}" ] || return 1
  case "${id}" in '' | *[!0-9]*) return 1 ;; esac
}

failed=0
count=0
while read -r sha; do
  count=$((count + 1))
  author_name="$(git show -s --format='%an' "${sha}")"
  author_email="$(git show -s --format='%ae' "${sha}")"
  author="${author_name} <${author_email}>"
  subject="$(git show -s --format='%s' "${sha}")"

  app=0
  if is_github_app_identity "${author_name}" "${author_email}"; then
    app=1
  fi

  matched=0
  while IFS= read -r trailer; do
    if [ "${trailer}" = "${author}" ]; then
      matched=1
      break
    fi
    if [ "${app}" -eq 1 ] && [[ "${trailer}" == "${author_name} <"?*">" ]]; then
      matched=1
      break
    fi
  done <<< "$(git show -s --format='%(trailers:key=Signed-off-by,valueonly)' "${sha}")"

  if [ "${matched}" -eq 1 ]; then
    echo "ok    ${sha:0:8}  ${subject}"
  else
    failed=$((failed + 1))
    echo "FAIL  ${sha:0:8}  ${subject}"
    echo "      author is ${author}"
    echo "      no matching Signed-off-by trailer; run: git rebase --signoff ${base}"
  fi
done <<< "${commits}"

echo "check-dco: ${count} commits checked, ${failed} without a matching sign-off"
[ "${failed}" -eq 0 ]
