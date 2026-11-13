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
| `.omp/tools/semble-rs/index.ts`                                    | 9 custom tools (`semble_*`; `semble_plan` removed 98b49860e3, `semble_savings` added 2026-10-26)                                                             |
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

## Hard lessons (2026-09-29, v18.4.3 merge)

15. **18.4.x settings 全面 registry 化**：`config/settings-schema.ts` 被删除，setting
    定义分散到各 domain 的 `settings.ts`（`register({id,...})` + `all-settings.ts` 聚合），
    `Settings` 实例**没有裸 `get(key)`**——所有 `settings.get("x.y")` 必须改为
    `cfgXy.get(settings)` registry handle。fork 的 `sandbox.forbidRead` /
    `permission.rules` / `bashInterceptor.extraPatterns` 均需在 `exec/settings.ts`
    重新 register。检查器：`bun run check:ts`（会暴露 valueCache/slot 类运行错）。
16. **18.4.x hub 工具整体删除**：拆为专用 `wait` 工具 + `proc://`/`agent://` 协议
    （commit f89a6db15e）。fork 的 hub `timeoutMs` 语义（lesson 12）随 hub 删除作废；
    `test/tools/hub/launch-timeout.test.ts` 引用已删实现，replay 后须显式删除。
17. **18.4.3 起 .node 需要 version stamp**：embed 校验 `PI_NATIVES_VERSION_STAMP:<ver>`；
    `bazel-natives host` 自动打戳，手编 baseline（裸 napi CLI）不会——补
    `bun scripts/stamp-native-version.ts <path>` 后再 build bundle。
18. **18.4.x 把 context/git 渲染从 custom-system-prompt.md 迁到 project-prompt.md**
    （跨目录 Anthropic prompt cache 命中）：fork 的 OKF `<file>` 属性 +
    `<okf-wiki-protocol>` 块要以 project-prompt.md 的新 `<repo-rules>` 区为新家；
    旧 `<project>` 块整体取上游删除侧，否则双重注入 + 破坏静态前缀缓存。
19. **force push 的 lease 要用 `git ls-remote` 的当前值**：上轮推过收尾 commit 后
    `--force-with-lease=main:<旧值>` 会报 stale info；重推前刷新远端 ref。

## Hard lessons (2026-10-06, v18.6.2 merge)

20. **上游自己的代码也可能过不了本地 clippy `-D warnings`**（版本/feature 差异）：
    v18.6.2 的 pi-natives desktop linux 新代码带 9 个 clippy error（collapsed-if、
    unnecessary_wraps、const fn、分号、doc 反引号）。修法：`unnecessary_wraps` 用
    `#[expect(clippy::unnecessary_wraps, reason = "...")]`（裸 `#[allow]` 会被
    `allow_attributes_without_reason` 拦；长 reason 需 rustfmt 多行）。fork 引入的
    prefer-const 级 oxlint error 也会卡 check:tools（warning 不阻塞，error 阻塞）。
21. **build 产物的 `(... &)` 后台启动不可靠**：omp 会话的 shell 退出可能带走子进程，
    log 空 + 产物时间戳不动 = 没跑成。native 构建一律前台 + `> log 2>&1; echo EXIT=$?`。
    另外 napi 写出 modern.node 有瞬间 rename 窗口，build EXIT=0 后立即 stat 可能
    No such file——ls 复核再下结论。

## Hard lessons (2026-10-19, v18.12.2 merge)

22. **代理端口漂移会打挂 Phase 1**：本机 mihomo mixed-port 已从 7890 迁到 7897
    （2026-09-12 起），但 `~/.gitconfig` 的 http(s).proxy 仍钉 7890 → assess/fetch 秒挂。
    已改 7897。再遇 fetch 失败先 `ss -ltn` 查 mihomo 实际端口，勿信文档快照。
23. **噪声历史的 catalog 冲突不可按 commit 中间态解**：v17→v18 间的 merge/清扫 commit 会把
    上游已删的旧布局（parseKnownModel/applyAnthropicCatalogPolicy 等）整包塞回冲突 theirs 侧。
    先算纯 fork 定制（`git diff <fork-base> ORIG_HEAD -- <dir>`）作最终态唯一真源，冲突一律向它收敛。
    本轮 catalog 净定制 = generated-policies.ts 尾部 63 行 pin 块（GLM 1M 含 flash image /
    MiniMax-M3 1M / ollama-cloud omit + minimax-code、opencode-go compat），收尾需逐行对账保真。
24. **natives 构建入口已换代**：`bun --cwd=packages/natives run build` = `bazel-natives.ts host`
    （本地 napi 路径 + 自动 version stamp + dlopen 探测；教训 9/14/17 的手打戳流程作废）；
    baseline 变体走显式 target `bun scripts/bazel-natives.ts linux-x64-baseline --dest packages/natives/native`
    （bazel 冷构建约 12min，需有效代理拉工具链）。embed 校验仍要求 modern+baseline 同版本。
25. **上次合并版本以 bundle/CHANGELOG 为准，勿信教训段**：教训段停在 v18.6.2，但上一轮实际部署过
    v18.8.6（bundle 名 `omp-18.8.6-custom.202610091956` 可查）。判断上次合并到哪，看
    `~/.local/share/omp-bundles/` 最新 bundle 的 VERSION 或各包 CHANGELOG。
26. **上游 catalog 再生成会与 fork 的 models.json 修改撞车**（git 视为二进制，无三方合并）：
    models.json 冲突一律取上游侧（rebase 中 `--ours`），收尾用 jq 审计目标条目（如 `.web` 名册）
    是否已被上游修复——v18.12.6 轮我们的 deepseek 补丁上游已修，取上游侧即净；若上游未修，
    用 `gen:models --provider <id>` 单 provider 再生成补回（只替换该 provider，其余快照不动）。

## Hard lessons (2026-11-04, v18.16.0 merge)

27. **Bun ≥ 1.4.4 是硬门槛（18.13.3 起）**：用 1.3.14 编译的二进制启动即报
    `Bun runtime must be >= 1.4.4`，四机装上去就不可用。`bun upgrade` 可能返回
    `HTTPForbidden`——改走官方脚本：`curl -fsSL https://bun.com/install | bash`（带代理），
    装到 `~/.bun/bin/bun`（不走 sudo）。升级后必须 `bun install` + 重新打包，再部署。
28. **打包脚本的 viewer 生成步被上游改名**：`packages/collab-web` 的 `gen:tool-views` 在
    18.14 已换成 `gen:export-viewer`（且 `--write` 才写文件，默认是陈旧性校验）。
    `bun install` 的 prepare 也会跑该校验，生成物与提交版本不一致时 install 直接失败。
29. **bash 审批路径上游已自带 interception**：v18.16 的 `BashTool#interception()`（返回
    message 字符串）与我们的 WS2 规则/escalation 同处 `approval()` 开头。合并取值：
    保留上游 helper 但改成返回 `InterceptionResult` 对象（含 policyKey/suggestedTool），
    把 extraPatterns 并入其规则集，escalation 计数留在 execute 路径。
30. **死代码随上游删除而失效**：`hub` 工具在 18.4 已删，我们 `validation.ts` 的
    `healMissingHubStartOp`（引用已消失的 `isPlainRecord`）变成死代码——直接删除，
    不要为它补 helper。
31. **`ToolError` 的导入路径以 `@oh-my-pi/pi-tui/tools/tool-errors` 为准**（coding-agent
    的 `tools/tool-errors` 只有 worker 相关导出）。合并测试文件时按上游用法核对，别只取一侧。
32. **18.14 起 provider 限定选择器必须精确命中模型 ID/别名**（近似命中改为报错）：四机
    config.yml 的 `modelRoles`/`web` 链要在部署后实测（`omp search --model web/deepseek`
    与一个 chat 会话各一次）。
33. **`omp-deploy.sh` 支持 `OMP_DEPLOY_REMOTES` 覆盖**（默认仍是三台远端）：某台离线时用
    `OMP_DEPLOY_REMOTES="hostA hostB" ./scripts/omp-deploy.sh <bundle>` 跳过它并在报告里标注。
34. **版本一致性必须按「用户实际解析到的二进制」校验，不能只看安装软链**：2026-11-04
    desktop 上 `~/.local/bin/omp` 明明指向 18.16.0，但交互式 shell 的 PATH 里
    `~/.bun/bin/omp`（6 月的 npm 全局 **16.0.1**）排在前面，用户跑到的其实是 5 个月前的版本，
    而旧校验只跑 `~/.local/bin/omp --version` 就报了「四机一致」。现在脚本在**登录/交互 shell**
    里取 `command -v omp`、`readlink -f` 解析后要求落在 `omp-bundles/<本次 bundle>/bin/omp`，
    否则 `SHADOWED on <host>` 且部署失败。排查同类问题时第一步永远是
    `bash -ic 'command -v omp; omp --version'`（非交互 ssh 的 PATH 不代表用户 PATH）。
35. **bundle 会堆积成灾难，部署后要 prune**：每个 bundle ~1.3G（231MB 二进制 + natives + 模型 +
    fastembed 缓存），2026-11-04 清出 **128 个 / 130G**（最早到 17.1.8），旧包也是版本误判的来源。
    脚本现在在一致性校验通过后自动清理：保留本次 bundle + 任何仍有活跃进程映射的包
    （`pgrep -f "omp-bundles/<n>/lib/omp"`），其余删除；`OMP_DEPLOY_PRUNE=0` 关闭。
    本机多留的旧包要等对应会话重启后才会在下次部署时被回收。

## Hard lessons (2026-11-09, v18.18.3 merge)

36. **18.18.1 起 `bash.patterns` 的规则形状与授权链都变了**：
    - 规则是 **`{ match: <glob>, approval: "allow"|"prompt"|"deny" }`**（`*` 通配、整串锚定），
      不再是 `{ pattern: <regex> }`——沿用旧形状的规则会被 `getBashApprovalPatternRules`
      静默丢弃（我们的 fleet config 未使用该键，已核 0 处）。
    - `approval()` 里有 `rawPatterns` + `grantAuthority()` 比较（项目层可收紧、不能放宽操作员
      deny/prompt），deny 在 `;`/`|`/`&&` 复合行任意段命中即拦。
    - **合并我们的 WS2 `permission.rules` 时，deny/prompt 的 operator 判定必须先算**：WS2 的
      `ask`/`allow` 只能在其后生效，否则 WS2 allow 会绕过操作员 deny（2026-11-09 实测复现并修复，
      回归测试见 `test/tools/bash-approval-precedence.test.ts` 的 6 条用例）。
    - 另一条易错语义（我们 2026-10-26 的策略）：nudge 类规则（`tool: "read"/"write"` 等）**只在
      命令本身就是那条命令时**触发，复合行不再整行拦截；测试断言要按这个语义写
      （`ls; echo hi > out.txt` 不拦、`echo hi > out.txt` 拦）。
37. **18.18.3 把 `ask` 工具改成 `{html}` 表单**（`questions[]`、QuestionResult、"Other"/"Chat"
    路径全删；`AskToolDetails` 变成 `{answers[], timedOut?}`）。agent 侧调用形态变了：
    文档/skill/提示词里教"用 ask 提 questions 数组"的地方要更新；我们的定制层不依赖它，
    但 8 个自定义工具与 skill 里若出现 ask 用法需同步。
38. **18.17 起交互语义变了**：`wait` 无新结果 5s 返回（空闲退避到 5m），对端回复等待 5 分钟；
    子代理禁止 `write agent://all` 广播；`task.workerThreads`（默认 4）把并发子代理放 worker
    线程；ovnfs 二进制存在时自动启用（grep/glob 走 daemon）。这些不改变我们的合并流程，
    但会影响对"子代理为何等待/卡住"的判断。

## Hard lessons (2026-11-10, v18.18.6 merge)

39. **打包脚本第 3 步只建 host 变体，上游一升版本就卡在 embed**：
    `bun --cwd=packages/natives run build` 是 `bazel-natives host`，只产出
    `pi_natives.linux-x64-modern.node`；而 `packages/natives/scripts/embed-native.ts` 会校验
    **两个** x64 变体的 `PI_NATIVES_VERSION_STAMP:<版本>`。baseline 停在上一版时第 4 步直接报
    `does not carry the @oh-my-pi/pi-natives@X.Y.Z version stamp`（本轮 v18.18.3→v18.18.6 复现，
    整条构建 167s 后失败，前面的 bun/rust 编译白跑）。
    `scripts/build-semble-omp-package.ts` 现已内置 `ensureBaselineNative()`：缺戳时自动跑
    `bun scripts/bazel-natives.ts linux-x64-baseline --dest packages/natives/native`
    （bazel 冷建约 10 分钟，需代理）。**不要**改用 `stamp-native-version.ts` 给陈旧二进制补戳——
    那会把旧版本的 Rust 符号塞进新版本二进制，运行时才炸。
40. **构建失败后要手工还原 `packages/utils/package.json`**：第 4 步用「临时改写 version →
    `finally` 写回」的方式注入 custom 版本，失败路径上实测留下
    `"version": "18.18.6-custom.<ts>"` 且整文件被 `JSON.stringify(…, null, 2)` 重新格式化成 2 空格。
    下一轮构建会把这个**被污染的值**当成 `originalVersion`，于是把 custom 版本固化进仓库。
    规则：每次构建前/后跑 `git diff --stat packages/utils/package.json`，有改动就
    `git checkout -- packages/utils/package.json`。

## Hard lessons (2026-11-13, v18.20.0 merge)

41. **18.19–18.20 上游做了一轮"提示词瘦身"**：默认系统提示精简、`read` 的格式选择器与 URI
    子路径语法改为按需读（`xd://read/sources`、`xd://read/urls`）、`task` 描述只留交付规则
    （`proc://`/`job` 过期/`write agent://` 参考随首次 spawn 结果下发）。本轮冲突与解法：
    - `system-prompt.ts`：上游引入 `promptContextFiles`（closeCodeFence 后），我们的 OKF 归一化
      与 backlinks 一律作用在 `promptContextFiles` 上（`normalizeContextFilesForPrompt(promptContextFiles)`、
      `hasOkfContextFile(promptContextFiles)`），不要再用旧的 `contextFiles` 变量。
    - `prompts/tools/bash.md`：保留上游 `In-process builtins, ahead of PATH: {{join builtins ", "}}.`
      与我们的 "Blocked in bash（use the owning tool）" 段；`builtins` 由上游 bash.ts 提供。
    - `task.md`：我们的 `# Delegation` 段与 `# Inputs` 有部分重复（合并前既有状态，本轮未改）。
    - OKF 模板仍只在 `project-prompt.md`（+13/−1）；`custom-system-prompt.md` 无 fork 差异（已核）。
42. **18.18.9 起"显式 bash prompt 规则在 yolo 模式仍生效（即使命中 critical）"**，与我们的
    approval 顺序一致。本轮重放我们自己的 precedence commit 时 `bash.ts` 又冲突一次，
    合并顺序固定为：interception → 操作员 pattern/authority deny → WS2 deny → 操作员 prompt →
    critical（非复合）→ WS2 ask → 复合段 critical 扫描 → WS2 allow / 操作员 allow → exec。
    上游本轮把 critical 检查移到了 prompted 之后，别再按旧顺序写。
43. **18.19/18.20 的移除项我们都没用**（已核 `.omp/` 与四机 config 各 0 处）：`task.file`/
    `taskFile`、todo 的 `blocked` 状态与 `blocker` 注记、`/mcp smithery-search|login|logout`。
    以后写 skill/提示词别再教这些用法。
44. **新增 `systemPromptTemplates`**（18.19）：模型选择器 → Handlebars 模板文件，可为不同模型
    定制系统提示并在切换模型时重渲染。它与我们的 OKF 注入并行、可叠加；本轮未采用，若将来
    要按模型切提示词，注意两者叠加后的顺序与缓存影响。

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
   脚本自动完成：本机 install → rsync + install 到 cnp6s / ser9 / desktop →
   **按登录 shell 真实解析**跑四机版本校验（`command -v omp` + `readlink -f` 必须落在本次
   bundle 上，否则 `SHADOWED` 失败）→ 一致性通过后 **prune 旧 bundle**（保留本次 + 仍有活跃
   进程映射的包）。
   - 某台离线：`OMP_DEPLOY_REMOTES="hostA hostB" ...` 跳过它，报告里单独标注待补装；
   - 不想清理旧包：`OMP_DEPLOY_PRUNE=0`。
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
