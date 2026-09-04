#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Every commit in the range carries a Signed-off-by trailer matching its author.
# The DCO (https://developercertificate.org/) is a statement that the author wrote the
# change or has the right to submit it; an unmatched trailer is not that statement.
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

failed=0
count=0
while read -r sha; do
  count=$((count + 1))
  author="$(git show -s --format='%an <%ae>' "${sha}")"
  subject="$(git show -s --format='%s' "${sha}")"
  if git show -s --format='%(trailers:key=Signed-off-by,valueonly)' "${sha}" \
    | grep -qxF "${author}"; then
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
