#!/bin/sh
# Brings g2minhle/Newsbee main into the current branch as ordinary changes, without
# upstream's history: that history still holds files this repository removed from its own
# (deploy.txt, Docs/operations-inventory.md, archive/python). Run from the repository root,
# on a fresh branch from origin/main with a clean working tree:
#
#   sh scripts/sync-upstream.sh <upstream commit the last sync included>
#
# Each sync commit records that commit on an "Upstream: <sha>" line.
set -eu
base=${1:?usage: sh scripts/sync-upstream.sh <upstream commit the last sync included>}
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/g2minhle/Newsbee.git
git fetch -q upstream
if [ -n "$(git status --porcelain)" ]; then echo "Commit or stash your changes first." >&2; exit 1; fi

# An upstream commit's tree without the paths this repository leaves out.
without_removed() {
  index=$(mktemp -u)
  GIT_INDEX_FILE=$index git read-tree "$1"
  GIT_INDEX_FILE=$index git rm -r -q --cached --ignore-unmatch archive deploy.txt Docs/operations-inventory.md
  GIT_INDEX_FILE=$index git write-tree
  rm -f "$index"
}
base_tree=$(without_removed "$base")
theirs_tree=$(without_removed upstream/main)
upstream=$(git rev-parse upstream/main)

# Three-way merge of upstream's changes since the last sync onto this branch.
git read-tree -m -u "$base_tree" HEAD "$theirs_tree"
if git merge-index -o -q git-merge-one-file -a; then
  echo "Upstream ${upstream} merged cleanly. Test, then commit with \"Upstream: ${upstream}\" in the message."
else
  echo "Upstream ${upstream} merged with conflicts: fix the files git status lists as unmerged, git add them, then commit with \"Upstream: ${upstream}\" in the message." >&2
  exit 1
fi
