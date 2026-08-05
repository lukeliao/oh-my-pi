---
name: omp-upstream-merge
description: Fetch upstream oh-my-pi (can1357) changes, rebase our fork, rebuild omp, and deploy to all x64 workstations. Run weekly or as needed.
---

# OMP Upstream Merge & Deploy

Standard procedure for pulling upstream `can1357/oh-my-pi` into our `lukeliao/oh-my-pi` fork, resolving conflicts, rebuilding the omp bundle, and deploying to all x64 machines.

## Repo Layout

| Remote | URL | Role |
|--------|-----|------|
| `origin` | `https://github.com/can1357/oh-my-pi.git` | Upstream |
| `liao` | `git@github.com:lukeliao/oh-my-pi.git` | Our fork |

Worktree: `~/workspace/act_ai_product/agents_harness/oh-my-pi`

## Our fork changes (files to watch for conflicts)

These files differ from upstream and may conflict on rebase:

| File | What we changed |
|------|----------------|
| `AGENTS.md` | Entirely custom — always keep `--theirs` (our version) in conflicts |
| `packages/coding-agent/src/system-prompt.ts` | OKF frontmatter + context rendering. Conflicts common in `buildSystemPrompt`, `prepDefaults`, `Promise.all` block |
| `packages/coding-agent/src/capability/context-file.ts` | Added `status`, `milestone`, `validation`, `decision_level` frontmatter fields |
| `packages/coding-agent/src/discovery/agents-md.ts` | Parsing for the 4 OKF frontmatter fields |
| `packages/coding-agent/src/prompts/system/custom-system-prompt.md` | OKF field attributes in `<file>` tag + `<okf-wiki-protocol>` block |
| `packages/coding-agent/src/prompts/system/project-prompt.md` | Same OKF additions as custom-system-prompt |
| `packages/coding-agent/test/system-prompt-dedup.test.ts` | OKF frontmatter test coverage |
| `scripts/build-semble-omp-package.ts` | omp packaging: builds `semble_rs`, copies `.omp/tools` + model, generates wrapper with `PI_CODING_AGENT_DIR=~/.omp/agent` |
| `scripts/semble-benchmark.ts` | Model2Vec benchmark script |
| `.omp/tools/semble-rs/index.ts` | 9 custom tools (`semble_*`) |
| `.omp/tools/semble-rs/index.test.ts` | Custom tool tests |
| `.omp/skills/omp-packaging/SKILL.md` | Build/deploy skill |
| `docs/semble-benchmark-results.md` | Benchmark results |

## Conflict resolution rules

1. **`AGENTS.md`** → Always keep ours (`--theirs` in rebase). This is our workspace convention.

2. **`package.json`** → Keep upstream (`--ours` in rebase), except for our added scripts/build steps. Upstream's `catalog` field already covers `pi-catalog`/`pi-wire`/`snapcompact` version pins.

3. **`build-binary.ts`** → Keep upstream (`--ours`). They refactored the `--compile` entries for Bun 1.3.14 compat.

4. **`ci-release-build-binaries.ts`** → Keep upstream (`--ours`). They refactored to `buildCompileCommand()` helper.

5. **`system-prompt.ts`** → Conflicts typically in:
   - `prepDefaults` block — upstream may add new fields (e.g. `gpu`, `activeRepoContext`). Take upstream (`--ours`) then re-apply OKF additions.
   - `Promise.all` destructure — same pattern, take upstream.
   - Our OKF function `renderActiveRepoContextPrompt` — keep ours.
   - `buildSystemPrompt` template data — keep our `normalizeContextFilesForPrompt` + `hasOkfContext`.

6. **`bun.lock`** → Take upstream (`--ours`), regenerate with `bun install` after rebase.

7. **`models.json`** (build artifact) → Discard on conflict, regenerate.

## Procedure

### Phase 1: Fetch & Assess（一条命令）

```bash
cd ~/workspace/act_ai_product/agents_harness/oh-my-pi
./scripts/omp-upstream-assess.sh
```

输出：待合 commit 数、最新上游 tag、冲突风险文件清单（我们定制且上游也改动的文件）。
风险清单为空或只有 `AGENTS.md`（冲突规则固定保留 ours）时，rebase 可放心进行。
有其它风险文件时，先 `git diff <merge_base>..origin/main -- <file>` 逐个评估再进入 Phase 2。

### Phase 2: Rebase

1. Stash any dirty files:
   ```bash
   git stash
   ```

2. Rebase:
   ```bash
   git rebase origin/main
   ```

3. Resolve conflicts per rules above. Common patterns:
   - `AGENTS.md` → `git checkout --theirs AGENTS.md && git add AGENTS.md`
   - `package.json` → `git checkout --ours package.json && git add package.json` (unless our scripts need merging)
   - `system-prompt.ts` → `git checkout --ours <file>` for infrastructure conflicts, keep ours for OKF sections
   - For other our-files with no upstream changes → `git checkout --theirs`

4. Continue until done:
   ```bash
   git rebase --continue
   ```

5. If a commit is obsolete (e.g. a fix that upstream already includes), skip it:
   ```bash
   git rebase --skip
   ```

### Phase 3: Verify

```bash
# Run system-prompt tests (covers OKF changes)
bun test packages/coding-agent/test/system-prompt-dedup.test.ts --bail

# Rust check
bun run check:rs
```

### Phase 4: Rebuild & Deploy omp

1. Build bundle:
   ```bash
   bun scripts/build-semble-omp-package.ts --model-path "$SEMBLE_MODEL_PATH"
   ```

2. Deploy to ALL x64 machines + 版本一致性校验（一条命令）:
   ```bash
   ./scripts/omp-deploy.sh ~/.local/share/omp-bundles/omp-<version>-linux-x64
   ```
   脚本自动完成：本机 install → rsync + install 到 cnp6s / ser9 / desktop → 四机版本一致性校验
   （任一不一致立即失败退出，须先补装再继续）。
   Skip `agx_orin` (ARM64 — needs cross-compile with `CROSS_TARGET=linux-arm64`).

### Phase 5: Commit & Push

```bash
git add -A
git commit -m "chore: merge upstream v<version>, rebuild omp"
git push --force-with-lease liao main
```

## Post-merge cleanup

- Check for new breaking changes in upstream changelogs (`packages/coding-agent/CHANGELOG.md`)
- Update our tool descriptions if upstream renames tools (e.g. `search`→`grep`, `find`→`glob` in v16.2.0)
- Fix any `omp` → `omp` drift in wrapper template
- Ensure `~/.omp/agent/config.yml` has `tools.discoveryMode: "off"`

## Machines

| Machine | Arch | Role | 访问方式 |
|---------|------|------|---------|
| liao-NUC12DCMi9 (本机) | x64 | 主开发机（构建源），用户 liao | 本地直接操作 |
| desktop | x64 | 廖工桌面工作站 DESKTOP-07JFCG5，用户 act_ai_server | `ssh desktop`（Tailscale: desktop-07jfcg5.tailad91fc.ts.net）——**是独立远程机，不是本机**，必须单独部署 |
| cnp6s | x64 | CI/remote build | `ssh cnp6s` |
| ser9 | x64 | CI/remote build | `ssh ser9` |
| agx_orin | ARM64 | Jetson — skip, needs cross-compile | `ssh agx_orin` |

**部署清单 = 本机(本地 install) + cnp6s + ser9 + desktop（三台都走 ssh）**。desktop 与 cnp6s/ser9 并列在同一个 ssh 循环里，唯一例外是本机不走 ssh。
