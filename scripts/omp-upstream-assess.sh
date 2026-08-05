#!/usr/bin/env bash
# omp-upstream-assess.sh — Phase 1 of the upstream-merge ritual: fetch + assess
# the conflict surface BEFORE rebasing. Read-only; never modifies the worktree.
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

# 1. Fetch
git fetch origin

# 2. Commit count and latest upstream tag
echo "commits ahead of upstream: $(git rev-list --count origin/main ^HEAD)"
echo "latest upstream tag:       $(git describe --tags --abbrev=0 origin/main 2>/dev/null || echo n/a)"

# 3. Files we customize — did upstream touch any of them since merge-base?
OUR_FILES=(
	AGENTS.md
	packages/coding-agent/src/system-prompt.ts
	packages/coding-agent/src/capability/context-file.ts
	packages/coding-agent/src/discovery/agents-md.ts
	packages/coding-agent/src/prompts/system/custom-system-prompt.md
	packages/coding-agent/src/prompts/system/project-prompt.md
	packages/coding-agent/test/system-prompt-dedup.test.ts
	scripts/build-semble-omp-package.ts
	scripts/semble-benchmark.ts
	scripts/session-stats/audit.ts
	.omp/tools/semble-rs/index.ts
	.omp/tools/semble-rs/index.test.ts
	.omp/skills/omp-packaging/SKILL.md
	.omp/skills/omp-upstream-merge/SKILL.md
	docs/semble-benchmark-results.md
)

merge_base=$(git merge-base HEAD origin/main)
echo
echo "customized files that upstream ALSO changed since $merge_base:"
touched=0
for f in "${OUR_FILES[@]}"; do
	if ! git diff --quiet "$merge_base"..origin/main -- "$f" 2>/dev/null; then
		echo "  CONFLICT-RISK  $f"
		touched=$((touched + 1))
	fi
done
if [ "$touched" -eq 0 ]; then
	echo "  (none — rebase should be clean)"
fi

echo
echo "assess done. For each CONFLICT-RISK file, review the upstream diff before rebasing:"
echo "  git diff $merge_base..origin/main -- <file>"
