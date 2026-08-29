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
| `$AGENT_DIR/skills/<name>/SKILL.md` | All repo-level skills from `.omp/skills/` (omp-packaging, omp-upstream-merge, ...) installed user-level, available from any cwd |
| `$AGENT_DIR/config.yml` | `tools.xdev: true` (default since v17; custom tools mount under `xd://`)
| `~/.omp/cache/fastembed-runtime/<version-key>/` | Pre-seeded mnemopi embedding runtime (fastembed + onnxruntime-node); copied for each missing version-key, avoids first-use network install that can stall the agent |
| `~/.omp/cache/fastembed/<model>/` | Pre-seeded mnemopi embedding model weights (`model_optimized.onnx` + config/tokenizer sidecars); avoids first-use HuggingFace download that can stall the agent |

The `omp` wrapper automatically sets `PI_CODING_AGENT_DIR` to `$AGENT_DIR` and resolves `SEMBLE_RS_BIN` / `SEMBLE_MODEL_PATH` to bundle-local paths.

## Do not do

- Do not run `scripts/release.ts` (commits, tags, pushes — that is the official release path).
- Do not rely on cwd-relative `../semble_rs` on target machines (the wrapper sets absolute `SEMBLE_RS_BIN`).

## Windows MSI distribution (since 2026-08-29)

Build a per-user Windows installer (`.msi`, no admin) containing the fork
exe, `semble_rs.exe`, the model, xd:// tools, and bundled skills:

```bash
# 1. Cross-compile the exe (needs pi_natives.win32-x64-baseline.node — see below)
CROSS_TARGET=windows-x64 bun --cwd=packages/coding-agent run build
# 2. Build the MSI (stages tools/skills/model from a linux bundle, cross-builds semble_rs.exe)
bash scripts/ci-build-msi.sh 18.0.10 \
  packages/coding-agent/dist/omp-windows-x64.exe \
  ~/.local/share/omp-bundles/omp-<ver>-linux-x64 \
  /tmp/omp-windows-x64.msi
```

- Requires `wixl >= 0.105` (Environment support): `micromamba create -y -p ~/.local/msitools-env -c conda-forge 'msitools=0.106'`; script auto-prefers that prefix. Also: `gcc-mingw-w64-x86-64` + `rustup target add x86_64-pc-windows-gnu` (stable; the repo's rust-toolchain.toml would otherwise poison the cross build).
- The win32 pi_natives addon is cross-built from Linux via bazel: `bun scripts/bazel-natives.ts win32-x64-baseline`. Bazel downloads the LLVM/MSVC toolchain — set `HTTPS_PROXY` if GitHub release assets stall, and keep `~/.bazelrc` `startup --output_user_root` on a roomy disk.
- The exe component uses REGISTRY keypaths (not file keypaths): unversioned-file costing skips identical existing exes and the upgrade uninstall then deletes them, leaving no exe. Do not switch back to file keypaths.
- Model is pinned in-repo via git-lfs (`resources/models/potion-code-16M-v2`); CI checks out with `lfs: true` and asserts the safetensors is not an LFS pointer.
- Validated live 2026-08-29 on real Windows (desktop WSL2 host): install / upgrade 18.0.10→18.0.11 (single product, exe recopied) / uninstall (files, env vars, PATH fragment all removed).
