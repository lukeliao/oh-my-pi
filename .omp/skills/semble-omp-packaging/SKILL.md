---
name: semble-omp-packaging
description: Build, install, and verify the local omp-semble distribution that bundles a custom-version oh-my-pi binary, semble_rs helper, custom tools, and local Model2Vec model without confusing it with official omp.
---

# Semble OMP Packaging & Deployment

Build a host-native omp-semble bundle that ships all 9 `semble_*` custom tools, the `semble_rs` Rust helper binary, and a local Model2Vec model as a self-contained distribution for other workstations.

## On a machine with the source repo (`agents_harness/oh-my-pi`)

1. Confirm cwd is `agents_harness/oh-my-pi`.
2. Confirm model exists at `${SEMBLE_MODEL_PATH:-$HOME/.cache/semble/models/potion-code-16M}` and contains `config.json`, `model.safetensors`, `modules.json`, `tokenizer.json`.
3. Build the bundle:
   ```bash
   bun scripts/build-semble-omp-package.ts --model-path "$SEMBLE_MODEL_PATH"
   ```
4. Copy the output directory (`/media/liao/storage/omp-semble-bundles/omp-semble-*-linux-x64/`) to the target machine (e.g. via `rsync`, `scp`, USB drive).
5. On the target machine, run `./install.sh --force`.

## On a target machine with only the pre-built bundle

1. Extract/copy the bundle directory to any location.
2. Install:
   ```bash
   ./install.sh --prefix ~/.local/bin --agent-dir ~/.omp/agent-semble --force
   # Or defaults: prefix=~/.local/bin, agent-dir=~/.omp/agent-semble
   ```
3. Verify:
   ```bash
   omp-semble --version   # must include -semble.
   omp --version          # official omp, unchanged
   ```

## What the installer deploys

| Path | Purpose |
|---|---|
| `$PREFIX/omp-semble` | Symlink to bundle's `bin/omp-semble` wrapper |
| `$AGENT_DIR/tools/semble-rs/index.ts` | 9 custom tools |
| `$AGENT_DIR/skills/semble-omp-packaging/SKILL.md` | This skill (user-level, available from any cwd) |
| `$AGENT_DIR/config.yml` | `tools.discoveryMode: off` (keeps custom tools visible) |

The `omp-semble` wrapper automatically sets `PI_CODING_AGENT_DIR` to `$AGENT_DIR`, isolating sessions and config from official `omp`.

## Do not do

- Do not run `scripts/release.ts` (commits, tags, pushes — that is the official release path).
- Do not overwrite `~/.bun/bin/omp` (official omp installer path).
- Do not copy `index.test.ts` or `README.md` into runtime tools directories.
- Do not rely on cwd-relative `../semble_rs` on target machines (the wrapper sets absolute `SEMBLE_RS_BIN`).
