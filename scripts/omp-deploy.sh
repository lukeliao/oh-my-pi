#!/usr/bin/env bash
# omp-deploy.sh — deploy an existing bundle to ALL x64 machines (local +
# cnp6s + ser9 + desktop) and run the version consistency check.
# Usage: omp-deploy.sh <bundle_dir>
set -euo pipefail

BUNDLE_DIR="${1:?usage: omp-deploy.sh <bundle_dir>}"
BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"
BUNDLE_NAME="$(basename "$BUNDLE_DIR")"
# Override to deploy a subset (e.g. when a machine is offline):
#   OMP_DEPLOY_REMOTES="liao-cnp6s.tailad91fc.ts.net liao-ser9.tailad91fc.ts.net" ./scripts/omp-deploy.sh <bundle>
read -r -a REMOTES <<<"${OMP_DEPLOY_REMOTES:-liao-cnp6s.tailad91fc.ts.net liao-ser9.tailad91fc.ts.net desktop}"

# Timeouts (seconds) bounding every remote operation. ConnectTimeout only
# bounds the SSH handshake — the remote mkdir/install.sh/version commands and
# the rsync transfer itself each need an explicit `timeout` so a hung remote
# never stalls the deploy.
SSH_CONNECT_TIMEOUT=10
SSH_CMD_TIMEOUT=120     # bounds mkdir / install.sh / omp --version on the remote
RSYNC_TIMEOUT=1800      # bounds the bundle transfer
SSH_OPTS=(-o ConnectTimeout="$SSH_CONNECT_TIMEOUT" -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

if [ ! -f "$BUNDLE_DIR/install.sh" ]; then
	echo "error: $BUNDLE_DIR is not an omp bundle (no install.sh)" >&2
	exit 1
fi

echo "[1/4] verifying bundle integrity, then installing locally"
(cd "$BUNDLE_DIR" && sha256sum -c --quiet SHA256SUMS) || {
	echo "error: bundle integrity check FAILED — refusing to install a corrupted bundle" >&2
	exit 1
}
"$BUNDLE_DIR/install.sh" --force

echo "[2/4] deploying to ${REMOTES[*]}"
for host in "${REMOTES[@]}"; do
	echo "  -> $host"
	timeout "$SSH_CMD_TIMEOUT" ssh "${SSH_OPTS[@]}" "$host" "mkdir -p ~/.local/share/omp-bundles/$BUNDLE_NAME"
	timeout "$RSYNC_TIMEOUT" rsync -az --info=progress2 "$BUNDLE_DIR/" "$host:~/.local/share/omp-bundles/$BUNDLE_NAME/"
	timeout "$SSH_CMD_TIMEOUT" ssh "${SSH_OPTS[@]}" "$host" "cd ~/.local/share/omp-bundles/$BUNDLE_NAME && sha256sum -c --quiet SHA256SUMS" || {
		echo "error: integrity check FAILED on $host — bundle corrupted in transfer, not installing" >&2
		exit 1
	}
	timeout "$SSH_CMD_TIMEOUT" ssh "${SSH_OPTS[@]}" "$host" "cd ~/.local/share/omp-bundles/$BUNDLE_NAME && ./install.sh --force"
done

echo "[3/4] version consistency check (all four must match, resolved through the login shell)"
expected=""
fail=0
check_host() { # $1 = label, $2 = "local" | ssh host
	local out path ver resolved
	if [ "$2" = "local" ]; then
		out=$(bash -ic 'p=$(command -v omp); printf "%s\n" "$p"; omp --version; readlink -f "$p"' 2>/dev/null || true)
	else
		# single-quoted: $HOME/PATH must expand on the REMOTE host (desktop runs
		# as act_ai_server with a different home than the local user)
		out=$(timeout "$SSH_CMD_TIMEOUT" ssh "${SSH_OPTS[@]}" "$2" 'bash -ic "p=\$(command -v omp); printf \"%s\n\" \"\$p\"; omp --version; readlink -f \"\$p\"" 2>/dev/null' || true)
	fi
	path=$(printf '%s\n' "$out" | sed -n '1p')
	ver=$(printf '%s\n' "$out" | sed -n '2p')
	resolved=$(printf '%s\n' "$out" | sed -n '3p')
	[ -n "$resolved" ] || resolved="$path"
	if [ -z "$path" ] || [ -z "$ver" ]; then
		echo "  $1: NO omp RESOLVED in a login shell" >&2
		fail=1
		return
	fi
	echo "  $1: $ver  ($path -> $resolved)"
	# Resolve symlinks: ~/.local/bin/omp is a symlink to the bundle wrapper, so a
	# stale ~/.bun/bin/omp or a distro package would shadow the deployed bundle
	# and the version string alone still looks right.
	case "$resolved" in
		*"/omp-bundles/$BUNDLE_NAME/bin/omp") : ;;
		*)
			echo "  SHADOWED on $1: 'omp' resolves to $resolved, not omp-bundles/$BUNDLE_NAME/bin/omp" >&2
			fail=1
			;;
	esac
	if [ -z "$expected" ]; then
		expected="$ver"
	elif [ "$ver" != "$expected" ]; then
		echo "  MISMATCH on $1 (expected $expected)" >&2
		fail=1
	fi
}
for host in local "${REMOTES[@]}"; do
	check_host "$host" "$host"
done

echo "[4/4] done"
if [ "$fail" -ne 0 ]; then
	echo "version mismatch detected — fix the missing/incorrect machine before proceeding" >&2
	exit 1
fi
