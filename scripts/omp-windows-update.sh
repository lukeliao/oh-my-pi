#!/usr/bin/env bash
# omp-windows-update.sh — deploy an omp MSI to the desktop Windows machine,
# install it per-user, and verify the result.
#
# Usage: omp-windows-update.sh <msi_path>
#   e.g. omp-windows-update.sh ~/.local/share/omp-bundles/omp-18.0.10-custom.202608291624-windows-x64.msi
#
# The MSI must be built with scripts/ci-build-msi.sh (see the omp-packaging
# skill for the full build flow). Re-running with the same MSI is safe: MSI
# maintenance mode reinstalls in place.
#
# Gotchas encoded here (do not "simplify" them away):
#   - cmd.exe /c "msiexec ... && echo" is used because PowerShell does NOT
#     wait for msiexec (GUI subsystem) — inline PowerShell calls return
#     before the install finishes.
#   - ProductCode changes every build (Guid="*"): never hardcode a GUID for
#     uninstall; query Win32_Product by name instead.
#   - Quoting through bash -> ssh -> cmd/PowerShell is a minefield; the
#     verification step ships a .ps1 over scp instead of inline commands.
#   - Overlapping msiexec runs deadlock silently on the installer mutex —
#     one install at a time.

set -euo pipefail

MSI="${1:?usage: omp-windows-update.sh <msi_path>}"
MSI="$(cd "$(dirname "$MSI")" && pwd)/$(basename "$MSI")"
HOST="desktop"
WIN_DIR="/mnt/c/Users/Public/omp-smoke"
WIN_DIR_WIN="C:/Users/Public/omp-smoke"
SSH_OPTS=(-o ConnectTimeout=10 -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

[ -f "$MSI" ] || { echo "error: no such msi: $MSI" >&2; exit 1; }
MSI_BASENAME="$(basename "$MSI")"

echo "[1/4] Pushing $MSI_BASENAME to $HOST..."
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $WIN_DIR"
scp "${SSH_OPTS[@]}" "$MSI" "$HOST:$WIN_DIR/$MSI_BASENAME" > /dev/null
echo "[2/4] Installing (per-user, quiet)..."
ssh "${SSH_OPTS[@]}" "$HOST" "cd $WIN_DIR && /mnt/c/Windows/System32/cmd.exe /c \"msiexec /i $MSI_BASENAME /qn && echo INSTALL_OK\"" | grep -q INSTALL_OK || {
	echo "error: install failed on $HOST (rerun the ssh msiexec line with /l*v for the log)" >&2
	exit 1
}
CHECK_PS1=$(mktemp /tmp/omp-win-verify-XXXXXX.ps1)
trap 'rm -f "$CHECK_PS1"' EXIT
cat > "$CHECK_PS1" << 'PSEOF'
$ErrorActionPreference = "Continue"
$omp = "C:\Users\hello\AppData\Local\omp"
$prods = @(Get-CimInstance Win32_Product -Filter "Name = 'OMP Coding Agent'")
Write-Output "PRODUCT_COUNT=$($prods.Count)"
Write-Output "REGISTERED=$($prods.Version -join ',')"
Write-Output "OMP_VERSION=$(& "$omp\omp.exe" --version 2>&1)"
Write-Output "SKILLS=$((Get-ChildItem "$omp\agent\skills" -ErrorAction SilentlyContinue).Count)"
Write-Output "TOOLS=$((Test-Path "$omp\agent\tools\semble-rs\index.ts"))"
Write-Output "MODEL=$((Test-Path "$omp\models\potion-code-16M\model.safetensors"))"
Write-Output "SEMBLE_RS=$((Test-Path "$omp\semble_rs.exe"))"
Write-Output "ENV_AGENT=$([Environment]::GetEnvironmentVariable('PI_CODING_AGENT_DIR', 'User'))"
Write-Output "PATH_HAS=$([Environment]::GetEnvironmentVariable('Path', 'User') -like '*AppData\Local\omp*')"
PSEOF
scp "${SSH_OPTS[@]}" "$CHECK_PS1" "$HOST:$WIN_DIR/verify.ps1" > /dev/null
echo "[3/4] Verifying..."
ssh "${SSH_OPTS[@]}" "$HOST" "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${WIN_DIR_WIN}/verify.ps1" | tr -d "\r"

echo "[4/4] Checking assertions..."
RESULTS=$(ssh "${SSH_OPTS[@]}" "$HOST" "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${WIN_DIR_WIN}/verify.ps1" | tr -d "\r")
FAIL=0
echo "$RESULTS" | grep -q "^PRODUCT_COUNT=1$" || { echo "  FAIL: expected exactly 1 registered product" >&2; FAIL=1; }
echo "$RESULTS" | grep -q "^TOOLS=True$" || { echo "  FAIL: tools index.ts missing" >&2; FAIL=1; }
echo "$RESULTS" | grep -q "^MODEL=True$" || { echo "  FAIL: model missing" >&2; FAIL=1; }
echo "$RESULTS" | grep -q "^SEMBLE_RS=True$" || { echo "  FAIL: semble_rs.exe missing" >&2; FAIL=1; }
echo "$RESULTS" | grep -q "^ENV_AGENT=C:" || { echo "  FAIL: PI_CODING_AGENT_DIR not set" >&2; FAIL=1; }
echo "$RESULTS" | grep -q "^PATH_HAS=True$" || { echo "  FAIL: PATH entry missing" >&2; FAIL=1; }
echo "$RESULTS" | grep -q "^OMP_VERSION=omp/" || { echo "  FAIL: omp.exe does not run" >&2; FAIL=1; }
[ "$FAIL" -eq 0 ] && echo "UPDATE VERIFIED" || exit 1
