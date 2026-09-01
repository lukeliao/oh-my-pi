---
name: omp-windows-deploy
description: Update omp on the desktop Windows machine (DESKTOP-07JFCG5, Windows user hello) — deploy an MSI, install per-user, verify. Use when the user asks to update/install omp on desktop's Windows side.
---

# OMP Windows Deploy (desktop)

Deploy an omp MSI to the desktop Windows machine and verify. The MSI is built
locally; see the `omp-packaging` skill (Windows MSI section) for the build
flow (cross-compile, bazel win32 natives, wixl >= 0.105).

## Quick path (MSI already built)

```bash
cd ~/workspace/act_ai_product/agents_harness/oh-my-pi
bash scripts/omp-windows-update.sh <path-to.msi>
```

One command: push to `C:\Users\Public\omp-smoke\` → `msiexec /i /qn` →
verify (single product, omp.exe runs, 7 skills, tools/model/semble_rs,
env vars, PATH) → prints UPDATE VERIFIED or per-item FAIL lines.

## What "installed" means on desktop

| Item | Value |
|---|---|
| Windows user | `hello` (profile `C:\Users\hello`) |
| Install root | `C:\Users\hello\AppData\Local\omp\` |
| Agent dir | `<install root>\agent` (via user env `PI_CODING_AGENT_DIR`) |
| Env vars (user) | `SEMBLE_RS_BIN`, `SEMBLE_MODEL_PATH`, `PI_CODING_AGENT_DIR`; PATH gains the install dir |
| Upgrade | `msiexec /i` a newer MSI — MajorUpgrade removes the old product automatically |
| Uninstall | `msiexec /x <ProductCode> /qn` — removes files, env vars, PATH fragment |

## Hard-won gotchas (verified live 2026-08-29)

1. **PowerShell does not wait for msiexec** (GUI subsystem). Drive installs
   through `cmd.exe /c "msiexec ... && echo OK"` from WSL, or
   `Start-Process -Wait`. An inline `powershell -Command "msiexec ..."`
   returns before the install finishes.
2. **ProductCode changes every build** (`Guid="*"`). Never hardcode a GUID;
   query `Win32_Product` by name. `msiexec /x <msi-file>` also works.
3. **`Win32_Product` queries are slow (~10 s)** and PowerShell quoting through
   bash→ssh→PowerShell breaks easily — ship a `.ps1` over scp and execute it
   (`-ExecutionPolicy Bypass -File`), never inline nested quotes.
4. **Overlapping msiexec runs deadlock silently** on the installer mutex —
   one install at a time; if a run hangs, check `tasklist | findstr msiexec`.
5. **`-File C:\path` through ssh loses backslashes** (remote bash eats them):
   use forward slashes (`C:/Users/...`) — PowerShell accepts them.
6. **Double-click of the MSI** shows only a basic progress dialog that closes
   itself (no full UI). "Flashed and exited" is usually SUCCESS — check
   `AppData\Local\omp\omp.exe --version` before assuming failure. Unsigned
   MSI may additionally hit SmartScreen on double-click; quiet installs over
   ssh bypass that.
7. **`Get-Command dsh` resolves to `dsh.ps1`** (npm-global ships .ps1/.cmd/no-ext
   shims; PowerShell prefers .ps1) and `Start-Process` on a .ps1 OPENS IT IN AN
   EDITOR instead of executing — dsh never starts, smoke "fails", editor windows
   pile up hidden. Always resolve `dsh.cmd` explicitly (see
   scripts/omp-windows-update.sh and the kit's Get-DshLauncher).
8. **Never install agent files under `%USERPROFILE%\.omp` via MSI**:
   `ProfileFolder` resolves to the shell ProfilesDirectory root (`D:\` on
   this machine), not the user profile. Everything lives under
   `%LOCALAPPDATA%\omp` with `PI_CODING_AGENT_DIR` pointing at the bundled
   agent dir.

## Current state pin

- 2026-08-29: omp 18.0.10-custom.202608291624 installed (ProductCode
  `{03894C60-FA5E-4FC6-8A3A-3448381B2DF1}` at time of install), validated
  install/upgrade/uninstall lifecycle end-to-end.
- Model providers (zhipu GLM + deepseek) live in
  `C:\Users\hello\AppData\Local\omp\agent\models.yml` — NOT in the MSI
  (contains API keys; never ship keys inside a distributable installer).
  After a fresh install or agent-dir wipe, mirror it from the workstation:
  `scp ~/.omp/agent/models.yml desktop:/mnt/c/Users/hello/AppData/Local/omp/agent/models.yml`
  (workstation file has more providers; the Windows copy currently carries
  only zhipu + deepseek). Verify with `omp models list`.
