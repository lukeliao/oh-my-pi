#!/usr/bin/env bash
# omp-deploy.sh — deploy an existing bundle to ALL x64 machines (local +
# cnp6s + ser9 + desktop) and run the version consistency check.
# Usage: omp-deploy.sh <bundle_dir>
set -euo pipefail

BUNDLE_DIR="${1:?usage: omp-deploy.sh <bundle_dir>}"
BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"
BUNDLE_NAME="$(basename "$BUNDLE_DIR")"
REMOTES=(liao-cnp6s.tailad91fc.ts.net liao-ser9.tailad91fc.ts.net desktop)

if [ ! -f "$BUNDLE_DIR/install.sh" ]; then
	echo "error: $BUNDLE_DIR is not an omp bundle (no install.sh)" >&2
	exit 1
fi

echo "[1/4] installing locally"
"$BUNDLE_DIR/install.sh" --force

echo "[2/4] deploying to ${REMOTES[*]}"
for host in "${REMOTES[@]}"; do
	echo "  -> $host"
	ssh -o ConnectTimeout=10 "$host" "mkdir -p ~/.local/share/omp-bundles/$BUNDLE_NAME"
	rsync -az --info=progress2 "$BUNDLE_DIR/" "$host:~/.local/share/omp-bundles/$BUNDLE_NAME/"
	ssh -o ConnectTimeout=10 "$host" "cd ~/.local/share/omp-bundles/$BUNDLE_NAME && ./install.sh --force"
done

echo "[3/4] version consistency check (all four must match)"
expected=""
fail=0
for host in local "${REMOTES[@]}"; do
	if [ "$host" = "local" ]; then
		ver=$("$HOME/.local/bin/omp" --version)
	else
		ver=$(ssh -o ConnectTimeout=10 "$host" "$HOME/.local/bin/omp --version")
	fi
	echo "  $host: $ver"
	if [ -z "$expected" ]; then
		expected="$ver"
	elif [ "$ver" != "$expected" ]; then
		echo "  MISMATCH on $host (expected $expected)" >&2
		fail=1
	fi
done

echo "[4/4] done"
if [ "$fail" -ne 0 ]; then
	echo "version mismatch detected — fix the missing/incorrect machine before proceeding" >&2
	exit 1
fi
