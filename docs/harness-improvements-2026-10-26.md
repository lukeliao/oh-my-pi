# Harness 改进记录 — 2026-10-26

本轮从"最近 30 天工具调用记录"出发做了一次系统优化。全部改动已在四台 x64 机器上线：`omp/18.12.6-custom.202610261851`。

分析底稿与证据在 `scripts/session-stats/out/harness-optimization-2026-10-26/REPORT.md`；本文件是决策与交付记录。

## 1. 结论先行

| 事项 | 结论 | 依据（实测） |
|---|---|---|
| grep 结果太肥 | 输出栅格行 71.4% 是上下文行；`contextAfter=3, contextBefore=1` → 改 `1/0` 后 grep 结果 token **−40.5%**（1.74M / 4.30M，重分词实测） | 2,001 条 grep 结果按 (文件,行号) 重建文本后 tokenize，自检误差 0.004% |
| bash 拦截器过度拦截 | 30d 172 次拦截，**148 次（86%）发生在复合命令里**，整条命令连坐；真阳性仅 14 次；98 次是变体重复 | 拦截原文按 shell 段落解析 |
| 拦截提示缺失 | bash 工具描述从未告诉模型这些形式会被拦 | 对照 `prompts/tools/bash.md` 与拦截规则 |
| edit 提示自相矛盾 | replace 模式描述推荐 `sed -E -i`，而拦截器正是拦它（30d 2 次） | `crates/pi-edit/prompts/replace.md` + `bash:shadowed:edit` 拦截记录 |
| semble 采用率崩塌 | 一等工具期 231 次（06-16→08-28）→ xd:// 设备期仅 23 次执行（3 个月）；同模型月切 30.4%→20.2%→4.6% | `ss_tool_calls`；错误率同期反而下降（34.9%→20%→10%），排除"报错劝退" |
| semble deps/impact 一直坏 | 二进制要求 `<FILE_PATH>` **相对** `<PATH>`，wrapper 原样透传 → 绝对路径 100% 失败 | 实测三种组合；历史错误 deps 6/14、impact 5/8 |

## 2. 改动清单

| 文件 | 类型 | 内容 | 上游冲突面 |
|---|---|---|---|
| `~/.omp/agent/config.yml`（四机） | 配置 | `grep: {contextAfter: 1, contextBefore: 0}` | 无 |
| `.omp/tools/semble-rs/index.ts` | fork 自有 | ① `resolveGraphTarget()`：deps/impact 绝对路径按 **subprocess cwd** 归一化；越界**报错**而非缩小图范围 ② `semble_search`/`semble_deps` 加 `loadMode: "essential"`（L1 实验） ③ 新增第 9 个工具 `semble_savings` | 无（自有文件） |
| `.omp/tools/semble-rs/index.test.ts` | fork 自有 | +7 条用例（路径归一化 6 条 + savings 1 条） | 无 |
| `packages/coding-agent/src/prompts/tools/bash.md` | 上游 | +1 行：被拦形态清单 + "整条复合命令会连坐，请拆开" | **是** |
| `crates/pi-edit/prompts/replace.md` | 上游 | 删掉推荐 `sed -E -i` 的表格，改为"被拦截，走 eval/ast_edit" | **是** |
| `.omp/skills/{omp-packaging,omp-upstream-merge}/SKILL.md` | fork 自有 | 8 → 9 工具，登记 `semble_savings` | 无 |
| `scripts/semble-l1-control.sh` | 新增 | 对照组工具文件裁剪（幂等 + 断言 + 自动恢复） | 无 |

## 3. 验证矩阵

| 验证 | 结果 |
|---|---|
| 单测 `bun test ./.omp/tools/semble-rs/index.test.ts` | **19 pass / 0 fail** |
| 类型 `bun run check:ts` | 14 个包全部 Done，EXIT=0 |
| grep 新默认生效 | 本会话即时生效：同一查询由「1 前置 + 3 后置」变「0 前置 + 1 后置」 |
| deps 端到端（安装版本模块，真实 spawn） | 绝对路径 + `path="."` → 成功 `File: crates/psr/src/command.rs`（修复前：`File not found in graph: /abs/…`） |
| deps 越界 → 必须报错 | `isError=true` + "file_path … is outside path … Pass a file inside that root, or set path to a directory that contains it" |
| 图范围缩小的危害（真机证据） | `impact src/motor_backend/mod.rs` root=`crates/arm` → 1 file；root 缩到文件目录 → `No files affected` **exit=0** |
| 两臂装载 | 处理组 `topLevel=[semble_deps, semble_search]`；对照组 `topLevel=[]` |
| 产物 | `omp/18.12.6-custom.202610261851` 四机一致；`lib/omp` 含新 bash 拦截行；modern + baseline 两个 `.node` 均含新 edit prompt |
| 对照组隔离 | 三远机 1089 行 / 0 标记；本地 1092 行 / 2 标记；`semble-l1-control.sh` 幂等 |

## 4. L1 实验（进行中，单变量）

| 组 | 机器 | 状态 |
|---|---|---|
| 处理 | liao-NUC12DCMi9 | 2 行 `loadMode: "essential"` 生效 |
| 对照 | cnp6s / ser9 / desktop | 同二进制、同 prompt、同 wrapper，仅剔除 2 行 |

基线（设备期 8 周）：执行 23 次；10 月会话渗透 11/90；30d 调用占比 0.22%。
门槛：执行次数 ≥3× 且 read+grep 结果 token 不上升；两组都不动 → 判定入口不是瓶颈，撤 L1 转触发规则（L2）与子代理注入（L4）。

采集与判定细节：`scripts/session-stats/out/semble-l1-baseline.md`。

> 注意：实验只影响**新开会话**。本轮已存在的会话仍用旧工具表。

## 5. 事故与教训

1. **对照组脚本一度清空三台机器的工具文件**（0 字节）。根因：函数经 ssh 传输但 `MARKER` 是本地变量，远端为空串 → `marker not in line` 对所有行成立。已从 `.l1-treatment.bak` 恢复；脚本重写为 stdin 传输 + 字面量 marker + **写前断言命中数 == 2** + 写后行数断言 + 空文件自动恢复。
2. **收益估算连翻两次车**：先用"逐策略独立取 min 相加"得 −67%（重叠窗重复计删），再用"行数 × 平均每行 token"得 −40.3%（不是真 token）。最终按 (文件,行号) 重建文本重分词，实测 −40.5%。多文件输出必须按 (文件,行号) 建 key，否则同号行互相覆盖（2,001 条里 579 条是多文件）。
3. **不要跨 corpus 相乘**：residency（jsonl + mtime 窗口）与 result token（`ss_*` 秒级窗口）不同口径，除出来的 255×/417× 只能当方向性说明。
4. **历史错误 ≠ 现存缺陷**：`digest` 的 `getWriter` 崩溃与 `tree` 60s 超时都在现版本不成立（源码已修正；实测 product_doc 0.19s、整仓 8.18s）。
5. **构建会污染 `packages/utils/package.json`**（临时改写 version，异常退出时不再回滚），每次构建后需还原。

## 6. 后续待办

| 项 | 说明 |
|---|---|
| L2 触发规则 | 等 L1 观测窗结果再上，避免与入口变量混淆 |
| L4 子代理注入 | `scout`/`theorist` 定义里写"探索前先 `semble_tree`/`semble_deps`" |
| OKF 一致性 | `product_doc` 187 个 concept 里 56 个无可解析 frontmatter（§11.1）；`log.md` 0 个；`Attested Computation` 未用 |
| grep 观察窗 | 两周后对比 grep p50/p90、read→read 分页数（当前 508 次/30d），确认"−40% token"没有换来更多往返 |
| 拦截器规则收窄 | 若 `bash.md` 提示上线后 block 数不降，就需要改代码只对单条命令拦截 |

## 7. 回滚

| 项 | 做法 |
|---|---|
| grep 默认值 | 删除四机 `~/.omp/agent/config.yml` 的 `grep:` 段（各机已有 `config.yml.bak-20261026-grepctx`） |
| L1 | 删两行 `loadMode: "essential", // L1-experiment`，或对处理组跑 `scripts/semble-l1-control.sh liao-NUC12DCMi9` 的口径（脚本按 marker 裁剪） |
| prompts | `git revert` 本波 commit 后重新打包 |
| 整套 | 重装任一历史 bundle：`~/.local/share/omp-bundles/omp-18.12.6-custom.202610261049-linux-x64`（本波之前） |

## 8. 追加：advisor 插话后的收尾规则（2026-10-26 晚）

### 8.1 现象与机制

advisor 的每条建议带 severity，投递通道由 `resolveAdvisorDeliveryChannel()` 决定（`advisor/advise-tool.ts:118`）：

| severity | 通道 | 效果 |
|---|---|---|
| 省略 / `nit` | `aside` | 不打断，下一步边界批量进上下文 |
| `concern` | `steer` | 注入正在跑的回合 → 主 agent 转去处理，用户原本要的答复被推后 |
| `blocker` | `steer` | 同上 |

`isInterruptingSeverity()` 把 concern/blocker 硬编码为打断，无配置项。主 agent 的 system prompt 按设计**从不提及 advisory**（`advisor/advise-tool.ts` 注释），所以它处理完不会在答复里交代——用户既看不到卡片之外的说明，也要多问一轮才能拿到完整答复。

### 8.2 采用的方案：只加常驻规则，不动 advisor 节奏

用户明确要求 advisor 保持每轮审查（不启用 `advisor.reviewMode: agent-end`），因此改在**输出层**兜底：

- 规则文件：`~/.omp/agent/rules/advisory-recovery.md`，frontmatter `alwaysApply: true`，四机已部署（local / cnp6s / ser9 / desktop）。
- 规则要求：advisor 插话且已动手时，最终消息**必须是综合重述**（先完整回答用户的问题，变化体现在重述后的答案里），随后每条 note 一行
  `Advisor: <一句主张> → <采纳 | 驳回>（<一句理由或改了什么>）`，且不允许复盘调研/重试过程。
- 规则已含"驳回或无关也要留一行"的分支，避免建议被静默丢掉。

### 8.3 为什么放 rules/ 而不是 APPEND_SYSTEM.md

`discoverAppendSystemPromptFile()`（`packages/coding-agent/src/main.ts:1358`）**项目级 `APPEND_SYSTEM.md` 优先于全局**：一旦某个仓库自带 `APPEND_SYSTEM.md`，全局那份会被整体跳过。rules 是叠加注入的，不受这个优先级影响，所以规则放在 `rules/`。

### 8.4 验证

| 验证 | 结果 |
|---|---|
| 文件状态（四机） | `rule_bytes=1114`、`alwaysApply: true`、heading 计数 1、`APPEND_SYSTEM.md` 已无该段且 `# User Operating Rules` 完好 |
| 新会话注入（本机） | `omp --print --no-tools` 让模型复述标题后的第一句 → 逐字返回规则首句 |
| 新会话注入（cnp6s） | 同上，逐字返回 → 跨机生效 |
| advisor 配置 | 四机全部回到默认（`reviewMode=turn`、`continueSeverity=concern`、`maxNotesPerUpdate=4`）——本轮实验性的 `continueSeverity=blocker` / `maxNotesPerUpdate=2` 已撤回，保持机群一致 |

### 8.5 若仍不够，可选的下一步（都需你点头）

| 旋钮 | 作用 | 代价 |
|---|---|---|
| `advisor.continueSeverity: blocker`（四机） | 终结回答后只有 blocker 能再起一轮 | 无审查覆盖损失，仅少一次自动续跑 |
| `advisor.interruptSeverity`（新代码） | 把"打断阈值"变成配置，可设 blocker 但保留每轮审查 | 改上游文件 + 一次打包 |
| `advisor.reviewMode: agent-end` | 只在最终交付时审一次 | **放弃中途纠偏**，用户已否决 |

## 9. 拦截器真正放行复合命令（2026-10-29）

### 9.1 为什么之前"修了还是被拦"

2026-10-26 那一轮只上了**提示词**（`bash.md` 列出被拦形态 + 提醒拆开复合命令），判定逻辑没动。P3（让复合命令通过）当时按约定"先看提示词效果再改代码"。实测：10-27 仍有 8 次拦截，说明提示词管不住。

### 9.2 这次的改动（`tools/bash-interceptor.ts`）

判定层按"规则意图"分流，而不是对所有规则一视同仁：

| 规则类型 | 判定范围 | 理由 |
|---|---|---|
| 引导类（`tool` 为 read/grep/glob/edit/write） | **仅当整条命令就是该命令**（按 `originalCommand` 判定 `extractFlatShellCommandSegments(...).length === 1`） | 审计（`out/interceptor-audit-90d/SUMMARY.md`，`glob 'Blocked: *'` 精确口径）在 90 天 415 条可归因拦截里测得命中位置：**非首段 256（62%）**、整条/首段 159（38%）；30 天口径为 177 条、90 天 445 条。杀掉一整行去纠正其中一段，损失大于收益 |
| 拒绝类（`tool: "bash"`，如项目 build 纪律 `build-discipline:*`） | 仍逐段扫描 | 这类规则要求整行不执行（裸 `cargo build` 出现在 `cd x && …` 里也必须拦） |

源码级判定（`packages/coding-agent` 单测 + 直接调用）：

| 命令 | 判定 | 说明 |
|---|---|---|
| `cd /tmp && cat /etc/hostname` | **pass** | 复合命令不再连坐（此前被拦） |
| `cat /etc/hostname` | BLOCK | 单条命令仍是引导目标 |
| `grep -c . /etc/hostname` | BLOCK | 同上 |
| `true && nohup sleep 0` | BLOCK | 拒绝类规则继续逐段命中 |

### 9.2b 一句口径纠正

先前我引用的「30d 172 次拦截、其中 148 次连坐、真阳性 14」来自我自己的分类：过滤器是 `result_text like 'Blocked: Use the%'`（只覆盖内置规则的消息前缀，漏掉项目自定义规则），且**没有做人工误报标注**。审计随后把过滤器修正为 `glob 'Blocked: *'`（30d 179→177，90d 447→445），并明确"分拣是信号辅助，不是标注"。

因此**该组数字只作指示，不再作为修复依据**；修复依据以上表引用的命中位置分布为准（62% 非首段）。是否逐条人工标注"C 组是否真该拦"仍是审计里未完成的事项。

### 9.3 验证

| 项 | 结果 |
|---|---|
| 单测 | `bun test test/tools/bash-interceptor.test.ts` → **76 pass / 0 fail**（7 条复合放行 + `originalCommand` 参数差异 + 3 条 BashTool 集成用例） |
| 类型检查 | `bun run --filter './packages/*' check:types` → EXIT=0 |
| 格式/lint | `oxlint .` + `oxfmt --check`（本次改动的 2 个文件）通过；仓库里另有 2 个**未跟踪**的 `scripts/session-stats/interceptor_*.ts` 格式不合规，非本次改动 |
| 部署 | 本机 / ser9 / desktop → `omp/18.12.6-custom.202610291052`；**cnp6s 离线（Tailscale `offline, last seen 1d`），恢复后需补部署** |
| 运行时验证（已部署二进制 `…1052`） | 在启用了拦截器的目录（`refactor/act_ai_product`，项目 `.omp/config.yml` 设 `bashInterceptor.enabled: true`）跑一次性会话：`cd /tmp && cat /etc/hostname` → **实际执行并返回主机名**；`cat /etc/hostname` → **被拦**（`bash:shadowed:read`）。两条都符合新规则 |
| 为什么早先那次实验没拦 | **已查实**：`bashInterceptor.enabled` 的注册默认值是 **`false`**（`exec/settings.ts:159`），只有项目 `.omp/config.yml` 显式开启才生效；早先的 `--print` 实验在 `/tmp` 下运行，没有项目配置，拦截器根本没启用。**此前写的"`ctx.toolNames` 为空"是猜测，已删除** |

### 9.3b 第一版漏掉的洞：`cd X && …` 前缀会被剥离

`BashTool` 会把行首 `cd <dir> &&` 提升成 `cwd` 并对**剥离后的剩余部分**再检查一次（`tools/bash.ts:1099-1101`）。第一版按 `command` 判定复合性，于是 `cd /tmp && cat /etc/hostname` 第一遍放行、第二遍以单段 `cat /etc/hostname` 重新拦下——最常见的形态根本没修好。

修法：复合性一律按 **`originalCommand`** 判定（两个检查轮次看到的是同一条原始命令行）。补了 BashTool 级集成测试（拦截器开启 + `read` 可用）：

| 用例 | 期望 |
|---|---|
| `cd packages/coding-agent && cat package.json` | **执行**，输出含包名 |
| `cat package.json`（单命令） | 抛 `Use read instead.` |
| `cd /tmp && nohup true`（拒绝类规则） | 仍抛错 |

单测口径也覆盖了参数级差异：`checkBashInterception("cat x", …, "cd pkg && cat x")` → pass；`…, "cat x")` → block。

### 9.4 需要同步更新的既有产物

`scripts/session-stats/interceptor_audit.ts`（未跟踪，2026-10-26 23:43 生成）把旧策略写成了断言：
`git status && grep …`、`cd build && make -j8`（这条属拒绝类，仍应通过）等。其中**引导类夹具的期望值需改为 pass**，否则该审计会报"失败"。

### 9.5 若还需要更细的控制（未做）

- 段级提示而非整行拒绝（`block` → `warn`）：需要 bash 工具把警告拼到结果里，改动面更大；
- 抽取器拒绝分段时的兜底粗切（`$(…)`/heredoc/括号占 30d 的 12.6%）：会同时改变精度与召回，需要标注支撑。

## 10. Advisor 收尾规则的复核（2026-10-29）

### 10.1 当初的验证缺口

只验证了"规则进了 system prompt"（`omp --print` 让模型复述规则首句 → 逐字返回），**没有验证模型是否照做**。这是漏的一步。

### 10.2 补的行为测量（本机全量会话；advisor 消息按 `custom_message/customType=advisor` 结构化解析）

| 会话 | 启动 | 规则在 prompt | advisory | 台账出现在本轮某处 | 台账在**最后一条**答复 |
|---|---|---|---|---|---|
| 2026-10-27T02:50 | 规则后 | 是 | 7 | 7 | **3** |
| 2026-10-29T04:01 | 规则后 | 是 | 1 | 1 | 1 |
| 合计 | — | — | **8** | **8（100%）** | **4（50%）** |

测量口径修正记录：第一次按"advisory 后的**第一条** assistant 文本"判定，得 3/8——长回合里那只是进度说明；改为在 advisory→下一条 advisory 的窗口内看**所有** assistant 文本，得 8/8；再收窄到"窗口内最后一条"得 4/8。

### 10.3 结论：写是写的，位置不对

模型每次都写了台账，但有一半回合在写完台账**之后又继续干活**，用户看到的最后一条消息里就没有它——与"最后看不到 advisor 说了什么、还要多问一轮"的观感一致。

同期另一个干扰项：本机正在跑的长会话（`2026-10-26T09:25Z` 启动）早于规则落地（`2026-10-26T16:05Z`），它的 prompt 里根本没有这条规则；在那类会话中评价"效果"不成立，必须新开会话。

### 10.4 规则改写（2026-10-29）

`~/.omp/agent/rules/advisory-recovery.md` 把**位置**写成硬要求：

1. 台账必须出现在**结束本回合的那条消息末尾**，不允许只写在进度说明里；若之后继续干活，必须原样带到最终消息；
2. 格式仍是一行一条：`Advisor: <一句主张> → <采纳 | 驳回>（<一句理由或改了什么>）`；
3. 同一条消息必须包含完整答案；advisory 改变了答案就整篇重述，禁止"已按建议修复"式改动清单；
4. 不复述排查过程；被驳回或无关的建议也要留一行。

部署：本机 / ser9 / desktop（cnp6s 仍离线）。注入验证：新会话 `omp --print` 复述第 1 条 → 逐字返回新文案。

### 10.5 复测方法（约一分钟）

开新会话触发一次 advisory（任一 concern 即可），然后用本文件同目录的采集口径：解析最新会话的 `custom_message/customType=advisor` 条目，检查**该轮最后一条** assistant 文本是否含 `Advisor:`。

判据：每条 advisory 的"最后一条含台账"为 True。若仍为 0–50%，说明提示词层不够，需要代码层兜底（advisory 投递后若本轮继续，补一条 reminder；或由渲染层把台账并入最终输出）。
