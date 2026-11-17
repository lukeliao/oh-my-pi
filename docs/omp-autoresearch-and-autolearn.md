# omp 的两个"自我推进"构件：autoresearch 与 autolearn

> 阅读对象：需要长期无人值守推进任务的人。文中结论都标了源码位置，可直接核对。
> 对照版本：omp 18.20.0-custom（上游 can1357/oh-my-pi v18.18.6+）。
> 权威说明：`docs/autoresearch.md`（169 行，写的是契约，不是实现）；本文补实现细节与坑。

---

## 0. 一句话区分

| | 改什么 | 产物 | 判据 |
|---|---|---|---|
| **autoresearch** | 改**代码**（外部产物） | git 分支 + SQLite 账本 + benchmark.log | 你自己写的 `METRIC`；keep/discard 由模型自报 |
| **autolearn** | 改**自己的知识**（内部产物：记忆 + skill） | `learned.md` / mnemopi / `~/.omp/agent/managed-skills/*/SKILL.md` | 无判据，靠人工抽查 |

两者都不改模型权重。它们合起来接近"递归自我改进"（RSI）的工程形态：一个改代码、一个改指令，都是**在会话内**发生的，没有离线训练环节。

---

## 1. autoresearch

### 1.1 它是怎么被装进来的

- 内置扩展 `createAutoresearchExtension`（`packages/coding-agent/src/autoresearch/index.ts`，541 行），不是插件，也不在 npm。
- `sdk.ts` 在**每个没有 `restrictToolNames` 的会话**上注册它。子代理走 `runCommands: false`，所以**子代理无法自己开启 autoresearch**。
- 注册内容：
  - 4 个工具：`init_experiment` / `run_experiment` / `log_experiment` / `update_notes`，全部 `defaultInactive`（未进入模式时对模型不可见，进入后挂载、退出后卸载）。
  - 1 个命令：`/autoresearch [goal|off|clear]`（带 `off`/`clear` 补全）。
  - 2 个快捷键：`ctrl+x` 展开/收起 dashboard widget，`ctrl+shift+x` 打开 overlay。
  - 5 个会话事件：`session_start` / `session_switch` / `session_branch` / `session_tree` → `rehydrate()`；`session_shutdown` → 清理。
  - 2 个 turn 钩子：`before_agent_start`（注入阶段提示词、每轮重算状态）、`agent_end`（发续跑消息）。
- 持久化控制位：session 里追加 `autoresearch-control` 条目 `{ mode: "on"|"off"|"clear", goal? }`，`reconstructControlState()` 在 resume 时 replay。这是"模式能跨重启恢复"的唯一来源。

### 1.2 三个阶段

**Phase 0 — 进入（`/autoresearch <goal>`）**

git 门禁按序（`autoresearch/git.ts` 的 `ensureAutoresearchBranch`）：

1. 纯 jj 工作区（有 `.jj/` 无 `.git/`）→ **拒绝**。
2. 完全没有 git 仓库 → 接受但警告（无分支隔离、无基线重置、无自动提交）。
3. 已在 `autoresearch/*` 分支 → 直接用。
4. 工作区脏 → **拒绝**，要求先 commit/stash。
5. 否则建并切换 `autoresearch/<goal-slug>-<YYYYMMDD>`（重名加 `-2`、`-3`）。

然后写 control 条目、挂上四个工具；有 goal 就把 goal 当第一条 user message 发出去。

**Phase 1 — 建 harness（`prompt-setup.md`）**

模型被要求：读源码 → 写 `./autoresearch.sh` → 用普通 `bash` 工具自测（必须 exit 0 且至少打印一行 `METRIC`）→ 调 `init_experiment` 快照基线。提示词明确禁止此阶段调 `run_experiment` / `log_experiment` / `update_notes`，也禁止把"只编译通过"当作 benchmark。

**Phase 2 — 迭代循环（`prompt.md`）**

一次迭代 = 改代码 → `run_experiment` → `log_experiment(keep|discard|crash|checks_failed)` → 这一轮 `agent_end` → 钩子发一条**隐藏**消息（`customType: "autoresearch-resume"`，`display: false`，`deliverAs: "nextTurn"`，`triggerTurn: true`）→ 下一轮。

续跑由"arm"驱动：`init_experiment` / `run_experiment` / `log_experiment` 都会 arm；如果这一轮什么也没 arm、也没有"跑完但没记账"的 run，`agent_end` 不续跑，循环自然停下。

### 1.3 四个工具的契约

| 工具 | 关键参数 | 副作用 |
|---|---|---|
| `init_experiment` | `name`、`goal?`、`primary_metric`、`metric_unit?`、`direction?`(默认 lower)、`secondary_metrics?`、`scope_paths?`、`off_limits?`、`constraints?`、`max_iterations?`、`new_segment?` | 开/改会话；首次与 `new_segment: true` 时要求 `autoresearch.sh` 已存在，并**自动 commit** 脏树作为 harness 基线（仅在 `autoresearch/*` 分支上；提交失败仅警告）；基线 commit 只在开新段时改写 |
| `run_experiment` | 只有 `timeout_seconds?`（默认 600） | 命令**固定**为 `bash autoresearch.sh`（Windows 换成宿主 POSIX shell），不可覆盖；先放弃上一个未记账 run，再插入 pending 行，流式写 `runs/NNNN/benchmark.log`，解析 `METRIC` / `ASI` |
| `log_experiment` | `metric`、`status`、`description`、`metrics?`、`asi?`、`commit?`、`justification?`、`flag_runs?` | **先提交再警告**：`keep` 在 `autoresearch/*` 分支上 stage+commit 改动文件，然后才写 scope deviation 警告；`discard`/`crash`/`checks_failed` 执行回滚（见 1.6）；重算 confidence |
| `update_notes` | `body?`（整体替换）、`append_idea?`（追加到 `## Ideas`） | notes 每轮都注入 system prompt，是唯一"必然被下一轮读到"的通道 |

`ASI <key>=<value>` 是自由元数据（布尔/数字/JSON/文本），给模型自己记账用，不参与判定。

### 1.4 账本在哪、怎么写的

- SQLite：`~/.omp/autoresearch/<project-key>.db`（可用 `OMP_AUTORESEARCH_DB_DIR` 改根；`project-key` 由 repo root 路径编码，`/a/b` 与 `/a-b` 会撞）。
- 一个 repository root 一个库，**所有会话共享**；会话之间靠 `sessions.branch` 区分，`getActiveSessionForBranch` 取该分支最近一个未关闭的实验。**同分支同 root 的两个会话会驱动同一个实验**，子系统不做并发仲裁。
- `runs` 一行一次 `run_experiment`，分三笔写：开始插入（segment/命令/预跑脏路径/日志路径）→ 进程退出补完（耗时、退出码、超时标志、解析出的指标与 ASI）→ `log_experiment` 定稿（status/描述/commit/改动路径/越界/justification/confidence）。`status IS NULL AND abandoned_at IS NULL` 的那行就是"待记账 run"。
- 只 `CREATE TABLE IF NOT EXISTS`，`user_version` 只抬不迁；删除靠 `closed_at` / `abandoned_at` / `flagged` 标记，行和日志会一直堆。

### 1.5 指标解析与置信度

- `METRIC` 名称匹配 `[\w.µ-]+`，值必须是有限数字；关键字与 `name=value` 之间允许跨行；同名后者覆盖；`__proto__`/`constructor`/`prototype` 被拒。退出码 0 且未超时 = 通过。
- confidence（`state.ts` 的 `computeConfidence`）：取当前 segment 中未 flagged、metric>0 的 run，算中位数 `median` 与中位数绝对偏差 `mad = median(|x - median|)`；`mad === 0` 或可用 run < 3 → `null`。公式是 **`|best_kept - baseline| / mad`**（`best_kept` 按 `direction` 选最优的 keep run；没有 keep 或等于 baseline 也返回 `null`）。`log_experiment` 把它渲染成 `>=2 likely real` / `>=1 marginal` / `<1 within noise` 三档（`log-experiment.ts` 的 confidence 文案）。
  注意：它是**噪声底**，不是显著性检验，更不校验 harness 是否公平。

### 1.6 keep/discard 的真实语义（最容易误解的地方）

`docs/autoresearch.md` 原文：**"Scope, off-limits, constraints and the reported status are records, not gates."**

- 越界路径、benchmark 非零退出、指标与解析值不一致——都**不会阻止** `keep`。`log_experiment` 是先 commit 再写 deviation 警告。
- `constraints` 存了但从不渲染进迭代提示词（prompt 模板没有这个字段），等于只留档。
- `status` 是模型自报：**错的 status 会被记录，不会被发现**。
- `discard` / `crash` / `checks_failed` 在 `autoresearch/*` 分支上执行 `git reset --hard HEAD` + `git clean`：**丢掉工作区里所有已跟踪改动和非忽略的未跟踪文件**——包括尚未提交的 `autoresearch.sh`。忽略文件与嵌套仓库幸存（`clean` 用默认参数）。
- 不在 `autoresearch/*` 分支时：`keep` 只警告不提交，回滚也只针对"运行改动的文件"，行为不同。

结论：**它是记账与回滚工具，不是质量门。** 验收门必须另配（现有 bench、`ctest -R`、plan 的净距/限位断言等）。

### 1.7 停止条件与预算

| 条件 | 是否终结 |
|---|---|
| 用户插入消息（`hasPendingMessages()`） | **否**，只是暂停；下次 `log_experiment` 会重新 arm |
| 迭代上限（`max_iterations`，**按 segment** 计） | 是，直到 `new_segment` 或改上限 |
| 显式 `off` / `clear` | 是 |
| 这一轮什么也没 arm | 是（安静停下） |

- **不自带预算**：不统计 token、不统计成本、不统计墙钟。`run_experiment` 只有单次超时；会话级的 `--max-time` / cost gate 仍然生效。
- `max_iterations` 的坑：每次 `init_experiment` 都会**重写**它（包括不带该参数的重新配置调用，等于清空上限）；到顶后 `/autoresearch` 再进入只买到"再跑一次"，因为 segment 计数没变。

### 1.8 已知缺陷与陷阱（文档自己承认的）

1. **`/autoresearch clear` 选会话不看分支**：它走 `getActiveSession`，在 A 分支上可能关闭 B 分支的实验并把工作区 reset 到 B 的基线。文档标注为疑似缺陷，是子系统里最危险的路径。
2. **切分支不停止但会打乱**：目标分支没有实验 → 回到 Phase 1 提示词，三个工具都报 `no active autoresearch session`；目标分支有实验 → 直接接管那一个。
3. `OMP_AUTORESEARCH_DB_DIR` 的三种畸形写法（相对路径、字面 `~`、前导空格）会导致库与日志分家、甚至"看起来没有实验"；不校验、不报错。
4. `clear` 会删除固定清单的遗留文件（`autoresearch.sh`、`autoresearch.md`、`autoresearch.checks.sh`、`.autoresearch/` 等），`--keep-tree` 只挡 git reset，**不挡删除**。
5. `run_experiment` 命令固定为 `bash autoresearch.sh`，不能换语言入口；要换就包一层 shell。

### 1.9 实操流程（最短路径）

```text
1) 进入专用工作区（建议独立 worktree，别在主干跑，见 §3）
2) /autoresearch "把 <bench 名> 的通过数从 N 提到 N+x"
3) Phase 1：模型写 autoresearch.sh（打印 METRIC passed=<n>），自测通过后 init_experiment
4) 循环开始，每轮看 dashboard：基线 / 最佳 / 置信度 / 近三次
5) 收工：/autoresearch off（保留分支与账本）
   清场：/autoresearch clear --keep-tree（关会话+删遗留文件，不动工作区）
6) 查账：python3 -c "import sqlite3;..." 或直接看 ~/.omp/autoresearch/<key>/runs/*/benchmark.log
```

---

## 2. autolearn

### 2.1 三个设置（`autolearn/settings.ts`）

| 键 | 默认 | 作用 |
|---|---|---|
| `autolearn.enabled` | **false** | 总开关（实验性）。关着时整个子系统惰性，但控制器仍安装 |
| `autolearn.autoContinue` | **false** | 开则在 stop 后自动跑一次"私有捕获轮"（会花额外 token） |
| `autolearn.minToolCalls` | **5** | 本轮工具调用数低于此值不触发（避免对闲聊捕获） |

### 2.2 控制器怎么工作（`autolearn/controller.ts`）

- 每个**顶层会话**（`taskDepth 0`）安装一次，与 `enabled` 无关；每次 stop 现读设置，所以中途改配置下一轮就生效。
- 订阅会话事件：`agent_start`（记录"本轮是否在 goal mode 下开始"）、`tool_execution_end`（计数）、`agent_end`（判定）。
- `agent_end` 的门禁顺序（任一不满足就返回）：
  1. 最后一条 assistant 的 `stopReason === "aborted"` → 跳过（ESC/取消不捕获）。
  2. `autolearn.enabled` 为假 → 跳过。
  3. 本轮工具调用数 < `minToolCalls` → 跳过。
  4. 处于 plan mode → 跳过（不打断计划审阅）。
  5. 本轮**开始于** goal mode，或当前仍在 goal mode → 跳过（不和 goal 续跑抢）。
  6. `autoContinue` 为假 → 到这就返回：**被动模式只保留 system prompt 里的常驻 guidance**（这是刻意的：往对话里插隐藏消息会破坏 Anthropic 的 prompt cache 前缀）。
  7. 都满足 → 起一次捕获轮；正在捕获时又来一次合格 stop，则合并成一次待跑（`#capturePending`）。

### 2.3 两个产出通道

**A. `learn` → 长期记忆**

- 必填 `memory`（"可复用的自包含教训：是什么/何时用/为什么"），可选 `context`、`scope`（`project`|`global`）、`skill`。
- 后端由 `memory.backend` 决定：`mnemopi`（SQLite/远端，需已初始化）、`hindsight`（需已配置）、`local`（文件后端，落到项目 `learned.md`）。
- `local` 后端的 `learned.md` 规则（`memories/index.ts`）：最多 **100 条**、最新在前、单条正文 ≤**2000** 字符、context ≤**400**；写入与读取都过 `neutralizeInjection`（去控制字符、尖括号、反引号、`~~~`），因为它会被原样渲染进 system prompt。
- `global` scope 只在 `mnemopi` / `hindsight` 下可用，`local` 会直接报错。

**B. `manage_skill` / `learn(skill=…)` → managed skill**

- 落地目录：`~/.omp/agent/managed-skills/<name>/SKILL.md`（`getManagedSkillsDir`），由扩展发现机制以普通 skill 身份暴露给后续会话。
- 名字必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`（`sanitizeSkillName` 归一）；正文上限 **64,000** 字节；frontmatter 只生成 `name` + `description`；provider id 标记为 `omp-managed`，用于把"自动生成"和"人手写"区分开。
- **硬隔离**：写入前校验根目录与目标文件——根是坏符号链接、指向非目录、目标是符号链接/非普通文件/有硬链接，一律拒绝写入。它永远不碰 `~/.omp/agent/skills` 或 `.omp/skills`。
- 常驻提示词（`autolearn-guidance.md`）的措辞要点：*"Capture sparingly, specifically: skill requires reuse; prefer enhancing existing managed skill to creating near-duplicate."*

### 2.4 `learn` 工具的可用条件（`tools/learn.ts`）

只有同时满足才暴露给模型：

1. `autolearn.enabled === true`；
2. `memory.backend` ∈ {`hindsight`, `mnemopi`, `local`}；
3. 后端就绪（`hindsight` 已配置 / `mnemopi` 已初始化）。

另有一条容易被忽略的注入规则（`tools/index.ts`）：`autolearn.enabled` 为真且 `taskDepth === 0` 时，`manage_skill` 会被**强制加进**工具列表（即使会话用 `restrictedToolNames` 限了工具集，也要保证 nudge 指向的工具存在）；`learn` 只在上面的后端集合满足时才加。这条明确只对顶层会话生效——**子代理的白名单绝不会被悄悄塞进可写工具**。

`manage_skill` 本身是内置工具（`builtin-names.ts`），默认状态 `off`，随 autolearn 打开而启用。

捕获轮里其它工具被禁用，`autolearn-capture-refused.md` 会直接告诉模型"本轮只允许 learn / manage_skill，或者停下"。

### 2.5 捕获轮的提示词（`autolearn-nudge-autocontinue.md`）要点

> "Automated capture turn — not a user reply; user has not responded… Do not treat this prompt as their answer, approval to continue, or acceptance of any pending action." → 防的是"自动轮把待确认动作当成已批准"。末尾强制：捕获完就停，不许跑别的工具、不许续做任务。

### 2.6 风险

- **skill 腐化**：自动生成的 skill 会累积，写错一条就长期生效。managed 目录与手写 skill 分离只是给了边界，不是质量保证。
- **自动捕获 ≠ 自动正确**：写入前没有任何验证，只有 `minToolCalls` 这种粗门。
- 开着 `autoContinue` 会持续消耗 token（每次 stop 一次额外完整轮）。

---

## 3. 在我们的机器人仓里怎么用

### 3.1 仿真侧（推荐先跑这个）

```
独立 worktree（ovnfs new / git worktree add）
  └─ autoresearch.sh 只做一件事：跑现有 bench，打印 METRIC passed=<n>、METRIC p95_ms=<x>
  └─ 验收门 = bench 自身的通过数（不看 log_experiment 的 status）
```

- 好处：全程离线，不涉及任何硬件权限；`discard` 的 `reset --hard` 只影响这个 worktree。
- 指标选择：优先"通过数/失败数"这类离散、抗噪的量；耗时类要先压抖动（`p50` 而不是单次）。

### 3.2 真机侧（不要直接交给 autoresearch）

- **git 回滚不撤销物理副作用**：reset 复位的是代码，不是关节位置、已发出的运动、标定写入。
- 指标脚本必须在 harness 里自带前置检查（`act_ai_ops status` → PSR Running → 持 lease），否则失败会被**重复 N 次**。
- 更稳的分工：`autoresearch` 只驱动仿真或离线回放（`replay/sessions/*`），真机验证作为**人工/独立门**，一次一代。

### 3.3 autolearn 的启用顺序

1. 先只开 `autolearn.enabled`，`autoContinue` 保持 false —— 观察常驻 guidance 是否会在真实会话里被用到（不动对话前缀、不额外花钱）。
2. 观察一到两周，如果模型确实开始写 managed skill，再考虑开 `autoContinue`。
3. 定期 `ls ~/.omp/agent/managed-skills/` 抽查，坏的直接 `rm -rf` 那个目录（它只影响自动生成的那份）。

---

## 4. 一页速查

| 想做的事 | 命令 / 位置 |
|---|---|
| 进入自动优化 | `/autoresearch <goal>` |
| 退出（保留账本与分支） | `/autoresearch off` |
| 清场（关会话 + 删遗留文件） | `/autoresearch clear --keep-tree` |
| 看实验结果 | `~/.omp/autoresearch/<project-key>.db`、`~/.omp/autoresearch/<project-key>/runs/NNNN/benchmark.log` |
| 强制换基线 | `init_experiment new_segment: true`（注意会清空 `max_iterations`） |
| 标记可疑 run | `log_experiment { flag_runs: [{ run_id, reason }] }` |
| 开 autolearn | `config.yml`: `autolearn: { enabled: true }` |
| 自动捕获轮 | 同上再加 `autoContinue: true`（费 token） |
| 看自动生成的 skill | `~/.omp/agent/managed-skills/` |
| 看记忆落盘 | `local` 后端 → 项目 `learned.md`；其余走 mnemopi/hindsight |

---

## 5. 参考（可核对）

- `docs/autoresearch.md` — 契约、停止条件、存储、已知缺陷（本文大量引用）
- `packages/coding-agent/src/autoresearch/index.ts` — 注册、命令、两个 turn 钩子
- `packages/coding-agent/src/autoresearch/tools/*.ts` — 四个工具
- `packages/coding-agent/src/autoresearch/state.ts` — `computeConfidence`、segment/基线/最佳
- `packages/coding-agent/src/autoresearch/storage.ts` — 两表 schema、三笔写入
- `packages/coding-agent/src/autoresearch/prompt-setup.md` / `prompt.md` — 给模型的两个阶段指令
- `packages/coding-agent/src/autolearn/controller.ts` — stop 门禁
- `packages/coding-agent/src/autolearn/managed-skills.ts` — managed skill 目录、命名、防覆盖
- `packages/coding-agent/src/tools/learn.ts` — `learn` 工具与后端门禁
- `packages/coding-agent/src/memories/index.ts` — `learned.md` 上限与注入中和
