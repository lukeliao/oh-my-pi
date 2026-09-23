---
name: omp-upstream-merge
description: Fetch upstream oh-my-pi (can1357) changes, rebase our fork, rebuild omp, and deploy to all x64 workstations. Run weekly or as needed.
---

# OMP Upstream Merge & Deploy

Standard procedure for pulling upstream `can1357/oh-my-pi` into our `lukeliao/oh-my-pi` fork, resolving conflicts, rebuilding the omp bundle, and deploying to all x64 machines.

## Repo Layout

| Remote   | URL                                       | Role     |
| -------- | ----------------------------------------- | -------- |
| `origin` | `https://github.com/can1357/oh-my-pi.git` | Upstream |
| `liao`   | `git@github.com:lukeliao/oh-my-pi.git`    | Our fork |

Worktree: `~/workspace/act_ai_product/agents_harness/oh-my-pi`

## Our fork changes (files to watch for conflicts)

These files differ from upstream and may conflict on rebase:

| File                                                               | What we changed                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                                        | Entirely custom — always keep `--theirs` (our version) in conflicts                                                       |
| `packages/coding-agent/src/system-prompt.ts`                       | OKF frontmatter + context rendering. Conflicts common in `buildSystemPrompt`, `prepDefaults`, `Promise.all` block         |
| `packages/coding-agent/src/capability/context-file.ts`             | Added `status`, `milestone`, `validation`, `decision_level` frontmatter fields                                            |
| `packages/coding-agent/src/discovery/agents-md.ts`                 | Parsing for the 4 OKF frontmatter fields                                                                                  |
| `packages/coding-agent/src/prompts/system/custom-system-prompt.md` | OKF field attributes in `<file>` tag + `<okf-wiki-protocol>` block                                                        |
| `packages/coding-agent/src/prompts/system/project-prompt.md`       | Same OKF additions as custom-system-prompt                                                                                |
| `packages/coding-agent/test/system-prompt-dedup.test.ts`           | OKF frontmatter test coverage                                                                                             |
| `scripts/build-semble-omp-package.ts`                              | omp packaging: builds `semble_rs`, copies `.omp/tools` + model, generates wrapper with `PI_CODING_AGENT_DIR=~/.omp/agent` |
| `scripts/semble-benchmark.ts`                                      | Model2Vec benchmark script                                                                                                |
| `.omp/tools/semble-rs/index.ts`                                    | 8 custom tools (`semble_*`; `semble_plan` removed 98b49860e3)                                                             |
| `.omp/tools/semble-rs/index.test.ts`                               | Custom tool tests                                                                                                         |
| `.omp/skills/omp-packaging/SKILL.md`                               | Build/deploy skill                                                                                                        |
| `docs/semble-benchmark-results.md`                                 | Benchmark results                                                                                                         |

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

## Hard lessons (2026-08-29, v18.1.2 merge)

1. **`rebase --continue` 之后才会提交已 `git add` 的文件——但脚本里 python 修复失败时
   `git add` 仍会执行**（用换行而非 `&&` 分隔时）。结果：含冲突标记的文件被静默 commit。
   规则：解析冲突的 python/sql 修复必须与 `git add`、`git rebase --continue` 用 `&&` 链接，
   失败即中止。
2. **rebase 完成后必须全量 grep 冲突标记**：
   `git grep -n "^<<<<<<< HEAD" HEAD -- packages/` —— v18.1.2 轮有 4 个文件的标记被
   静默 commit（catalog 政策/compat/测试 + 前一轮的文件）。
3. **catalog 冲突优先取上游**：v17.2.5 时代的 GLM/MiniMax/wafer/opencode-go 政策块引用的
   helper（isMimoModelIdOrName、resolveWaferServerlessThinkingFormat）在上游 18.x 已被
   KDL 规则系统（compat/rules/providers/*.kdl）取代——整块取上游，再核对 GLM 1M pin
   是否仍由 generated-policies 保留（zhipu-coding-plan 用户依赖它）。
4. **agents-md.ts 上游重构进了 helpers.loadStandaloneContextFiles（单文件名/调用）**：
   我们的 OKF frontmatter + index.md 双文件发现重新接线 = 两次 helper 调用合并 +
   attachFrontmatter（**必须 `content: body` 剥离 frontmatter**，漏剥会让
   system-prompt-dedup 测试的 content 断言拿到带 frontmatter 的原文）。
5. **测试失败先读 bun 的原始输出**（`-t <name>` + grep error/Received）——line number
   会对不上号，靠断言的 Received/Expected 实值定位才是唯一可靠路径。

## Hard lessons (2026-09-07, v18.1.13 merge)

6. **线性 rebase 会静默丢弃经 merge commit 进入 fork 的文件**：designer/librarian
   agent `.md` 与 `agents.ts` 条目历史上来自 merge commit（27f53cadf5），rebase 只重放
   非 merge commit → 文件凭空消失且无冲突提示。规则：rebase 后核对
   `packages/coding-agent/src/prompts/agents/` 全部 9 个文件 + agents.ts 的 import 与
   EMBEDDED_AGENT_DEFS 完整性；缺失时从 `ORIG_HEAD` 恢复（scout→designer→reviewer→
   security-reviewer→librarian→theorist），双侧扩列表（如 capability 测试）取并集。
7. **无冲突 ≠ 类型正确：rebase 后必须跑 `bun run check:ts`（需先 `bun install`）**。
   自动合并可产出语法合法但语义坏的杂合体——本轮 agents-md.ts 缺
   `LoadContext/LoadResult` import + warnings 可选展开、generated-policies.ts 残留
   v17.2.5 旧布局块（parseKnownModel/applyAnthropicCatalogPolicy 等，v18 已由 KDL
   取代；deepseek xhigh→high 由 deepseek.kdl 覆盖，该自定义块冗余可删）。bun test
   不做类型检查，抓不住这些。
8. **发布通道**：本机 SSH 到 GitHub 大流量被限速（377MiB 推 15 分钟仅 1.4MB），小
   commit（~30KB）40 秒直推无碍。大 payload 走 cnp6s 中继：rsync 整个 `.git`（LAN
   ~100MB/s）→ cnp6s `git --git-dir=... -c core.hooksPath=/dev/null push`。注意：
   空 bare 仓中继会拒 shallow 发送方（"shallow update not allowed"），GitHub 不会拒
   （shallow 根都在其现有 tip 之下）；cnp6s 无 git-lfs，bypass hooks 前先 `ls-tree`
   比对 LFS pointer 未变；被 timeout 杀掉的 push 可能已被服务端完成，重推前先
   `git ls-remote` 确认。

## Hard lessons (2026-09-12, v18.2.1 merge)

9. **native 双变体是 embed 的硬门槛**：`build:native` 只产 host 变体（本机 AVX2 →
   modern），而 embed 校验 modern+baseline 两个 `.node` 的版本哨兵
   （`__piNativesV18_2_1`）——baseline 陈旧会 build 失败。baseline 构建路径：
   `bun packages/node_modules/@napi-rs/cli/dist/cli.js build --manifest-path
crates/pi-natives/Cargo.toml --package-json-path packages/natives/package.json
--platform --no-js -o <dir> --profile local` + `RUSTFLAGS="-C target-cpu=x86-64-v2"`，
   产物改名 `pi_natives.linux-x64-baseline.node` 放回 native/。
10. **rustup 组件"installed"但二进制缺失**：重装 dated nightly 后 rustfmt/clippy
    可能标记 installed 却没有 cargo-fmt/cargo-clippy（半安装状态，报 "not
    applicable"）。修法：`rustup component remove <c> --toolchain <tc>` + `add` 强制
    重新解包。症状：check:rs 在 fmt/clippy 步骤报 binary not applicable。
11. **bundle 构建失败要留全量日志**：`--filter`/`sed` 会吞掉 "Bundle:" 行之前的
    报错，失败后只剩空输出。规则：重定向到文件 + echo exit code，成功判据是
    bundle 目录含 `install.sh` + `lib/` + `tools/` 完整结构，而非命令退出码。
    构建脚本会临时改写 `packages/utils/package.json` 的 version，进程被杀时
    finally 不执行 → version 叠层污染（`--version` 显式传干净值可解）。另：
    18.2.0 起编译二进制默认内嵌 bytecode，与 semble bundle 的 JSON import 组合
    会在 Bun 1.3.14 启动崩溃（`Expected CommonJS module...`）——
    `OMP_DISABLE_BYTECODE=1` 构建（compile-binary.ts 已加 env gate）。
12. **hub `timeoutMs` 语义收窄**：上游 18.1.22 把 messaging/job 等待改自适应窗口
    并删除 `timeoutMs`；我方保留的 schema 字段仅对 **process ops** 生效
    （`resolveProcessTimeout` 的 ms→s fallback），schema 描述已收窄，勿再宣传
    messaging 用途。launch-timeout.test.ts 锁定该语义。

## Hard lessons (2026-09-24, v18.2.11 merge)

13. **LFS pre-push hook 在重写历史上会误判重传并挂死，报误导性 `missing object`**：
    push 失败 `ref "main":: missing object: <blob>` 时先分诊——
    (a) `git cat-file -t <oid>` 确认本地存在；(b) `git ls-remote liao main` 确认服务端
    ref 没被动过；(c) `git lfs push --dry-run liao main` 看是否卡在上传（v18.2.11 轮：
    LFS 遍历 b12cffc176..new 范围时把未变的 `model.safetensors` pointer 当作待上传，
    SSH 链路 LFS 传输挂起 120s+ 后报 missing object）。三方比对 pointer
    （`git ls-tree HEAD <path>` / `git show liao/main:<path>` / `git lfs ls-files -l`，
    `*` 标记 = 本地对象在）确认未变后，`git -c core.hooksPath=/dev/null push` 绕过
    ——绕过后 push 本体仅数秒。禁止对 changed pointer 绕过（须先真实上传 LFS 对象）。
14. **napi CLI 输出名变了**：baseline 变体产物名为 `pi_natives.linux-x64-gnu.node`
    （非旧记录的 `pi_natives.linux-x64.node`），且 napi cli 实际路径是
    `node_modules/@napi-rs/cli/dist/cli.js`（非 `packages/node_modules/...`）。
    构建脚本的 whitespace 污染若被 `git add -A` 裹进 merge commit，恢复后 commit
    会变空——直接 `git reset HEAD^` 丢弃，不要 amend（会报 would-be-empty）。

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
- 确认旧 discovery 键未回流：上游 18.2.x 已删除 BM25 工具发现，`tools.discoveryMode`/
  `tools.essentialOverride`/`mcp.discoveryMode`/`mcp.discoveryDefaultServers` 随之废弃，
  settings.ts 迁移器会主动删除死键——config.yml 里没有它们是**预期行为**，
  不要再写回（2026-09-24 之前旧版 skill 曾错误要求确保 `tools.discoveryMode: "off"`）

## Machines

| Machine                | Arch  | Role                                               | 访问方式                                                                                                |
| ---------------------- | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| liao-NUC12DCMi9 (本机) | x64   | 主开发机（构建源），用户 liao                      | 本地直接操作                                                                                            |
| desktop                | x64   | 廖工桌面工作站 DESKTOP-07JFCG5，用户 act_ai_server | `ssh desktop`（Tailscale: desktop-07jfcg5.tailad91fc.ts.net）——**是独立远程机，不是本机**，必须单独部署 |
| cnp6s                  | x64   | CI/remote build                                    | `ssh cnp6s`                                                                                             |
| ser9                   | x64   | CI/remote build                                    | `ssh ser9`                                                                                              |
| agx_orin               | ARM64 | Jetson — skip, needs cross-compile                 | `ssh agx_orin`                                                                                          |

**部署清单 = 本机(本地 install) + cnp6s + ser9 + desktop（三台都走 ssh）**。desktop 与 cnp6s/ser9 并列在同一个 ssh 循环里，唯一例外是本机不走 ssh。
