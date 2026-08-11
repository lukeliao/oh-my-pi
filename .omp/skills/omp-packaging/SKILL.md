---
name: omp-packaging
description: Build, install, and verify the local omp distribution that bundles a custom-version oh-my-pi binary, semble_rs helper, custom tools, and local Model2Vec model.
---

# OMP Packaging & Deployment

Build a host-native omp bundle that ships the 8 `semble_*` custom tools (`semble_digest`, `semble_search`, `semble_deps`, `semble_impact`, `semble_tree`, `semble_find_related`, `semble_find_pattern`, `semble_encode`), the `semble_rs` Rust helper binary, and a local Model2Vec model as a self-contained distribution for all x64 workstations. (`semble_plan` was removed in 98b49860e3 — benchmark audit showed poor standalone hit-rate vs `semble_search`.)

## On a machine with the source repo (`agents_harness/oh-my-pi`)

1. Confirm cwd is `agents_harness/oh-my-pi`.
2. Confirm model exists at `${SEMBLE_MODEL_PATH:-$HOME/.cache/semble/models/potion-code-16M-v2}` and contains `config.json`, `model.safetensors`, `modules.json`, `tokenizer.json`. (v2 = potion-code-16M-v2, float16; verified 2026-08-04: R@1 72→75%, R@5 90→97%, R@10 95→100%, MRR 0.7871→0.8434 on eval_set_100.)
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
| `$AGENT_DIR/tools/semble-rs/index.ts` | 8 custom tools |
| `$AGENT_DIR/skills/omp-packaging/SKILL.md` | This skill (user-level, available from any cwd) |
| `$AGENT_DIR/config.yml` | `tools.xdev: true` (default since v17; custom tools mount under `xd://`)
| `~/.omp/cache/fastembed-runtime/<version-key>/` | Pre-seeded mnemopi embedding runtime (fastembed + onnxruntime-node); copied for each missing version-key, avoids first-use network install that can stall the agent |
| `~/.omp/cache/fastembed/<model>/` | Pre-seeded mnemopi embedding model weights (`model_optimized.onnx` + config/tokenizer sidecars); avoids first-use HuggingFace download that can stall the agent |

The `omp` wrapper automatically sets `PI_CODING_AGENT_DIR` to `$AGENT_DIR` and resolves `SEMBLE_RS_BIN` / `SEMBLE_MODEL_PATH` to bundle-local paths.

## Do not do

- Do not run `scripts/release.ts` (commits, tags, pushes — that is the official release path).
- Do not copy `index.test.ts` or `README.md` into runtime tools directories.
- Do not rely on cwd-relative `../semble_rs` on target machines (the wrapper sets absolute `SEMBLE_RS_BIN`).
