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
