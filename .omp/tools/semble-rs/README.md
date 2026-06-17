# semble_rs Custom Tools

Project-local oh-my-pi custom tools wrapping `semble_rs` for codebase search, dependency analysis, AST pattern matching, and digest compression.

## Build

From `agents_harness/oh-my-pi`:

```bash
cargo build --release --manifest-path ../semble_rs/Cargo.toml
```

## Runtime environment

- `SEMBLE_RS_BIN=/absolute/path/to/semble_rs` — optional override in this workspace layout, but required when the tool directory is copied to a workspace that is not a sibling of `agents_harness/semble_rs`.
- `SEMBLE_MODEL_PATH=/absolute/path/to/local/model` — required for `semble_search`, `semble_plan`, `semble_find_related`, and `semble_encode`. Must point to a local Model2Vec model; implicit HuggingFace downloads are blocked.

## Discovery

This tool directory is loaded by project `.omp/tools/semble-rs/index.ts` when `omp` runs with cwd inside `agents_harness/oh-my-pi`.

For other workspaces:
1. Copy or symlink this directory into that workspace's `.omp/tools/` or `~/.omp/agent/tools/`.
2. Set `SEMBLE_RS_BIN` unless the copied tool still has the same relative path to `agents_harness/semble_rs`.

## Packaged omp-semble

Packaged installs (via `scripts/build-semble-omp-package.ts` + `install.sh`) place runtime `index.ts` under `~/.omp/agent-semble/tools/semble-rs/index.ts`. The `omp-semble` wrapper sets absolute `SEMBLE_RS_BIN` and `SEMBLE_MODEL_PATH` to the bundle-local helper/model by default — no manual env vars needed on target machines.

Because `semble_rs tree/deps/impact` can still trigger model loading through the underlying library, packaged `omp-semble` always provides `SEMBLE_MODEL_PATH` for all commands. The semantic/non-semantic distinction in the wrapper is about tool-level enforcement; the packaged install eliminates this concern entirely.
