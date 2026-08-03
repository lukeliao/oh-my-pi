---
name: omp-packaging
description: Build, install, and verify the local omp distribution that bundles a custom-version oh-my-pi binary, semble_rs helper, custom tools, and local Model2Vec model.
---

# OMP Packaging & Deployment

Build a host-native omp bundle that ships all 9 `semble_*` custom tools, the `semble_rs` Rust helper binary, and a local Model2Vec model as a self-contained distribution for all x64 workstations.

## On a machine with the source repo (`agents_harness/oh-my-pi`)

1. Confirm cwd is `agents_harness/oh-my-pi`.
2. Confirm model exists at `${SEMBLE_MODEL_PATH:-$HOME/.cache/semble/models/potion-code-16M}` and contains `config.json`, `model.safetensors`, `modules.json`, `tokenizer.json`.
3. Build the bundle:
   ```bash
   bun scripts/build-semble-omp-package.ts --model-path "$SEMBLE_MODEL_PATH"
   ```
4. Copy the output directory (`/media/liao/storage/omp-bundles/omp-*-linux-x64/`) to the target machine (e.g. via `rsync`, `scp`, USB drive).
5. On the target machine, run `./install.sh --force`.

## On a target machine with only the pre-built bundle

1. Extract/copy the bundle directory to any location.
2. Install:
   ```bash
   ./install.sh --prefix ~/.local/bin --agent-dir ~/.omp/agent --force
   # Or defaults: prefix=~/.local/bin, agent-dir=~/.omp/agent
   ```
3. Verify:
   ```bash
   omp --version   # must include -custom. timestamp
   ```

## What the installer deploys

| Path | Purpose |
|---|---|
| `$PREFIX/omp` | Symlink to bundle's `bin/omp` wrapper |
| `$AGENT_DIR/tools/semble-rs/index.ts` | 9 custom tools |
| `$AGENT_DIR/skills/omp-packaging/SKILL.md` | This skill (user-level, available from any cwd) |
| `$AGENT_DIR/config.yml` | `tools.xdev: true` (default since v17; custom tools mount under `xd://`)
| `~/.omp/cache/fastembed-runtime/<version-key>/` | Pre-seeded mnemopi embedding runtime (fastembed + onnxruntime-node); copied for each missing version-key, avoids first-use network install that can stall the agent |
| `~/.omp/cache/fastembed/<model>/` | Pre-seeded mnemopi embedding model weights (`model_optimized.onnx` + config/tokenizer sidecars); avoids first-use HuggingFace download that can stall the agent |

The `omp` wrapper automatically sets `PI_CODING_AGENT_DIR` to `$AGENT_DIR` and resolves `SEMBLE_RS_BIN` / `SEMBLE_MODEL_PATH` to bundle-local paths.

## Do not do

- Do not run `scripts/release.ts` (commits, tags, pushes — that is the official release path).
- Do not copy `index.test.ts` or `README.md` into runtime tools directories.
- Do not rely on cwd-relative `../semble_rs` on target machines (the wrapper sets absolute `SEMBLE_RS_BIN`).
