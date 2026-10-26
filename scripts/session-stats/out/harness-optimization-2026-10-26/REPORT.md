# Harness 优化分析 — 2026-10-26（基于最近 30 天工具调用记录）

只出方案，未改任何代码。

**交付状态：阶段报告。** 已实测的部分：四机两窗口基线（精确复现）、错误分类、结果 token 分布、拦截形态、缓存 miss 计数、grep 上下文收益重算、描述可推断性 probe。未完成的部分：P3/P4/P5 的回放实验、单一 corpus 的 residency 系数、probe 的多样本面板——这些都在 §0.2 标为未验证，不作为实施依据。

## 0. 口径与基线复现

| 项 | 值 | 来源 |
|---|---|---|
| 语料 | `~/.omp/agent/sessions/**/*.jsonl`，本机 1,326 文件 / 117 会话 | sync.py 全量重解析（parser_version=6） |
| 窗口 | 近 30 天（rolling，秒级） | `ss_tool_calls.timestamp` |
| 本机顶层 toolCall | **9,707** | `tool-call-tiers.py 30 2026-10-26T04:00:00Z` |
| 快照基线（本机 30d） | 9,707 | `out/tool-calls-2026-10-26/stats3-local-30.json` → **偏差 0.0%** |
| 快照基线（cnp6s 30d） | 4,838 / 41 会话 / 438 文件 | 远端重跑 → **完全一致** |
| fleet 30d 顶层 | 38,452 | 快照 `stats3-fleet-30.json` |
| DB 内 30d 调用 | 10,241（含子代理会话，窗口按秒滚动，比快照略宽） | `ss_tool_calls` |
| 计费请求 | 8,983（其中 advisor 会话 2,979） | `messages` |
| 结果 token 总量 | 9,729,922 | `ss_tool_results.result_tokens` |

口径提醒：三层计数不可相加；`ss_tool_calls` 与 `ss_tool_results` 的 join 键是 `(session_file, call_id)`，**带 `seq` 会全部失配**（本次踩过，`analyze.py` 用的是正确键）。

### 0.1 四机 × 两窗口复现（2026-10-26T04:00:00Z 同一 anchor，全部重跑）

| 主机 | 30d 复现 | 30d 快照 | 累计复现 | 累计快照 | 判定 |
|---|---|---|---|---|---|
| liao-NUC12DCMi9 | 9,707 | 9,707 | 51,906 | 51,906 | ✅ |
| cnp6s | 4,838 | 4,838 | 64,961 | 64,961 | ✅ |
| ser9 | 13,550 | 13,550 | 93,338 | 93,338 | ✅ |
| desktop | 10,357 | 10,357 | 31,220 | 31,220 | ✅ |
| fleet 求和 | 38,452 | 38,452 | 241,425 | 241,425 | ✅ |

八项全部逐字一致（无 5% 以内模糊，是精确相等）。语料懒落盘特性说明：本表是同一 anchor 的两次采样，落在同一 flush 状态。

### 0.2 每条结论的验证状态

| 结论 | 状态 |
|---|---|
| 四机计数、错误分类、结果 token 分布、block 形态、缓存 miss 计数 | **实测**（`ss_*` / `messages` 表 + 远端重跑） |
| grep 各上下文策略的节省比例 | **重分词实测**（1,785/2,001 条；(文件,行号) 分组、重建文本后 cl100k 计数；当前策略重建自检误差 0.004%，见 §1.3） |
| 节省量折算到「计费上下文」 | **未验证假设**：跨 corpus 比例迁移（grep residency 与 result-token 来自不同窗口/口径） |
| no-cache 响应与缓存 TTL 的因果 | **待证**：只有间隔相关性，无 provider 侧证据 |
| 工具描述可推断性 | **实跑 probe**，但仅 2 模型 × 各 1 样本（非 skill 要求的多样本面板） |
| P3/P4/P5 的收益 | **未验证**：无回放实验，只有语料侧计数 |

## 1. 证据表（问题 → 计数 → 最小样例）

### 1.1 失败与摩擦 Top10（本机 30d，641 条 is_error）

| # | 问题 | 计数 | 占 10,241 调用 | 最小样例 |
|---|---|---|---|---|
| 1 | **bash 被自建拦截器拦掉** | **172**（其中 98 条是"Repeat block #N"重复项） | 1.7% | `SimGateSummary.jsonl seq=78`；`CleanupOwnership.jsonl seq=17/33` |
| 2 | bash 命令非零退出（真实失败，非拦截） | 142 | 1.4% | `A4A5Fix.jsonl seq=108`；`SimGateSummary.jsonl seq=81` |
| 3 | 路径/名称不存在（路径猜测） | 123 | 1.2% | `TimingEvidence.jsonl seq=84`；`RemediationPlan.TestFlowAudit.jsonl seq=75` |
| 4 | **wait 的 "Skipped due to…"**（语义是跳过，非失败，被计入 is_error） | 91 | 0.9% | `01a08ae0-…jsonl seq=5353/5377/5391`（同一会话连发 3 次） |
| 5 | tool-call 参数 JSON 非法 | 22 | 0.2% | `ManualDoc.jsonl seq=122`(yield)；`ChangelogReview.jsonl seq=26`(read)；`CampaignReview.SolverGuard.jsonl seq=80`(grep) |
| 6 | yield 输出 schema 不匹配（子代理） | 16 | 0.2% | `R0Classifier.RunnerFlow.jsonl seq=79/82/85`（"expected object, received string" 连犯 3 次） |
| 7 | edit 匹配失败（`close enough match` / 多次命中） | 9 | 0.1% | `01a08ae0-…jsonl seq=5633`；`TaskspaceSeamVerify.jsonl seq=112` |
| 8 | edit 被路由规则挡（`ssh://… is written through write`） | 3 | 0.03% | 三台远端 `config.yml`，同一会话 3 次 |
| 9 | xd:// 设备误用（未挂载/参数形状不对） | 4 | 0.04% | `ExactRetimeScaling.jsonl seq=96`；`01a08ae0-…jsonl seq=7631`；`…jsonl seq=2155` |
| 10 | grep 超时（30s 预算） | 9 | 0.09% | 与 #3 同源：宽路径搜索 |

有效失败率（剔除 #4 跳过标记）：550 / 10,241 = **5.4%**。失败结果只占 result token 的 **0.86%**（83,387 / 9,729,922）——**失败的代价不在 token，在往返**。

### 1.2 拦截器是本轮最大的"自伤"（重点）

对 172 条 block 原文做 shell 段落解析（区分 `;`/`&&`/`|` 与 piped-stdin）：

| 形态 | 计数 | 含义 |
|---|---|---|
| 复合命令中的一段（其余步骤一并作废） | **148（86%）** | 例：`bash gate.sh && python3 check.py && cat /tmp/ev.jsonl` → 整条被杀，前两步白跑 |
| 单条简单命令（真阳性） | 14（8%） | `grep -E "^@@" /tmp/rb_prior.diff` |
| piped-stdin 段（按设计应跳过，实为规则漏网） | 9（5%） | `systemctl … \| grep -i proxy`、`git show … \| grep -n …` |
| 未分类 | 1 | `sudo cat …`（wrapper 剥离后应命中） |

后果链：172 block 中 **76 次下一条调用又是 bash**（"Repeat block" 计数到 #6），说明"确定性策略"提示不能阻止变体重试。
拦截消息的原始代价：每条 block 至少 1 次完整请求（本机中位上下文 197k tok）。

### 1.3 浪费模式（同参数重复、绕行、截断重读）

| 模式 | 计数 | 量级 |
|---|---|---|
| 同 (tool, args) 完全重复 | 88（0.9%） | 重买 22,374 tok；其中紧邻重复 26 次 |
| read→同路径再读（分页） | 508 | 触发源：774 条 read 结果带 "more lines…to continue" 尾注（38% of read） |
| read→grep 紧邻 / grep→read 紧邻 | 431 / 426 | 正常的定位-阅读往返，非浪费 |
| 结果提及 `artifact://`/截断（被落盘或截断） | 622（grep 290 / read 203 / bash 102） | 其中 **对 artifact 再 grep 91 次，322,328 tok，均值 3,542** |
| 单结果 ≥6k tok | 305 | 占全部 result token **30.3%**；read+grep 占其中绝大多数 |
| 结果 token 归属 | read+grep = 7,967,626 = **81.9%** | grep 42.6% / read 39.3% / bash 10.7% |
| context-residency（audit，jsonl 侧计费口径） | read 1.25B · grep 714.6M | 两项占 2.72B 的 **72%** |

倍增关系（**跨 corpus 估算，未验证**）：用 audit 的 read residency 1.25B ÷ `ss_*` 的 read 结果 3.0M ≈ 417×，grep 714.6M ÷ 2.8M ≈ 255×。两个数来自不同口径/窗口，只能说明「同一条结果会在后续每次请求里重复计费」这个方向性事实，不能当系数用。要得到干净系数，需在单一 corpus 内同时算 residency 与结果 token（未做）。

grep 输出的成分（**按 (文件, 行号) 分组 + 重建文本后重分词实测**）：30d 内 2,001 条 grep 结果，1,785 条可解析（占 grep token 99.9%），其中 **579 条是多文件输出**（`# dir/` + `## name` 头行折叠成文件键；单个行号字典会让不同文件的同号行互相覆盖，这是首版的 bug）。216 条无行号栅格（3,547 tok）跳过。

模拟方式：按每个文件的命中行确定保留窗，丢弃窗外栅格行，连续丢弃段折叠成一个 `...`，头/尾行原样保留，**再把重建文本重新分词**（cl100k_base）得到 token。

自检：用当前策略（`contextAfter=3, contextBefore=1`）重建，词数 4,295,543 vs 原文 4,295,731，**差 188 tok（0.004%）**——渲染模型与真实输出吻合。已知残余偏差：丢弃段后可能与原有 `...` 相邻产生双分隔符，量级每段约 1 tok，相对百万级节省可忽略。

| 策略（显式字段名） | 模拟 token | 净减少 | 相对当前 |
|---|---|---|---|
| `contextAfter=3, contextBefore=1`（当前） | 4,295,543 | 188（=重建误差，非收益） | 0% |
| `contextAfter=2, contextBefore=1` | 3,768,386 | 527,345 | **−12.3%** |
| `contextAfter=1, contextBefore=1` | 3,135,499 | 1,160,232 | **−27.0%** |
| `contextAfter=1, contextBefore=0` | 2,555,571 | 1,740,160 | **−40.5%** |
| `contextAfter=0, contextBefore=0` | 1,825,106 | 2,470,625 | −57.5% |

（首版报的 −40.3% 是用「行数 × 平均每行 token」估的，且 grid 只用行号做 key；数值接近是巧合，方法不成立，已废弃。）

折算到计费上下文仍属**未验证假设**：若按 audit（jsonl 侧、mtime 窗口、13 个主会话）的 grep residency 714.6M 做**比例迁移**，`1/0` → 714.6M × 40.5% ≈ **289M**，占该 corpus residency 合计 2.73B 的 **≈10.6%**。跨口径，只当量级参考。

### 1.4 工具面与描述

| 事实 | 数值 |
|---|---|
| 本会话真实工具面 | 12 个（read/bash/edit/ask/eval/glob/grep/task/wait/todo/web_search/write） |
| 描述+schema 总 token | **≈3,718**（源内 createTools 默认 settings 产出 11 个：4,012；但实测 edit 走 replace 模式，描述 269 而非 hashline 的 563，故 −294） |
| 其中 top3 | task 927 / read 630 / bash 354（edit 292） |
| 占中位上下文 | 3,718 / 197k = **1.9%** |
| audit "57/72 从未调用" | **不可用作证据**：72 是手工登记的 registry（含 12 个已下线 MCP、memory/ast_*/lsp/debug 等未挂载项）；实际挂载的 11–12 个工具 30 天内全部被调用 |
| 静态 prompt 全景 | AGENTS.md 7,814 + index.md 1,050 + 内置规则 expression-communication 1,991 + system-prompt.md 3,605 + project-prompt 1,180 + skills 索引 ~675 + semble 设备 273 ≈ **≈19k tok（10% 上下文）** |

结论（与"压缩工具描述"的直觉相反）：**工具描述不是 token 大头**，surface 只有 ≈3.7k。已按 tool-prompt-optimization 的 probe 方法实跑（真鉴权，经 `eval` 的 `completion` 走本仓模型；`probe-builtin.ts --model` 直跑会因 key 未注入 env 而鉴权失败）：

| 目标 | 真实 prompt 行数 | 复原出的行 | 复原率 | 模型产出 vs 真实 |
|---|---|---|---|---|
| `edit`（hashline 变体） | 12 | 1 | 8.3% | 969 / 1,113 tok vs 真实 563（大部分是编造填充） |
| `task` | 26 | 6 | 23.1% | 1,305 / 1,773 tok vs 真实 810 |
| `read` / `bash` / `replace`-mode edit | — | — | **不可探** | 无 `<tag>` 包裹体，outline 即全文（read 复原结果 2,025 字符 = 原文回显，无信息量） |

即：schema+outline 复原不出 prompt 正文（≤23%，且输出反而更长），按 skill 判据属于 **load-bearing，不该删**。样本限制：2 个模型 × 各 1 样本，未做 skill 要求的多样本面板；且 oh-my-pi 是公开仓，存在「背过」污染，真实复原率可能更低。

### 1.5 低频工具是"不需要"还是"用不起来"

| 工具 | 30d 调用 | 判定 | 依据 |
|---|---|---|---|
| computer/judge/workpool | 0（三层全零） | 不需要 | 语料里连 eval prelude 形态也没有 |
| lsp / debug / ast_grep / ast_edit / checkpoint / rewind / security_scan / find / goal | 0–4 | **已不在面上**（settings 门控未开 / 被上游删除），不构成 prompt 税 | 实测 surface 只有 11–12 个；这 9 个未出现 |
| browser | 非零（三层都有） | 真用 | 快照 `browser` 顶层 + prelude + xd 路由均 >0 |
| semble_*（8 个） | 本机 ~18 / fleet ~80 | **用不起来**（非"不需要"）：描述已写清"grepping would miss"，但 30 天 0.2% 路由 | 严格 xd:// 路由本机 51 次/30d，占调用 0.5% |

**prompt 与拦截器互相矛盾（新增证据）**：replace 模式 edit 描述（`crates/pi-edit/prompts/replace.md`，269 tok）在 `<bash-alternatives>` 里明确推荐 `sed -E -i 's/pattern/replacement/g'` 做批量正则替换，而拦截器规则 `^\s*sed\s+(-i|--in-place)` 正是拦这条（30d 内 2 次 `bash:shadowed:edit`，样例 `fix1_trigger_check.py`、`openarm_follower_can0_*` 两次改动）。当前 edit 走 replace 模式 → 这条矛盾是活跃的，不是历史残留。

### 1.6 定制层实效与两个未被记录的事实

1. **edit 实际跑的是 replace 模式，不是 hashline**。`utils/edit-mode.ts` 对 mimo/deepseek/minimax/kimi/glm-flash 强制回落 `replace`；我们的模型角色（default=deepseek-v4-flash、smol/task=mimo、designer=MiniMax-M3、vision=kimi）**全部落在回落名单**。证据：30d 705 次 edit 的参数形态 100% 是 `{path, old_string, new_string}`，`ss_edit_sections` 为空。
   → 直接后果：`analyze.py followups` 的五个 hashline 返工探测器**全盲**（本次 0 命中是假阴性，不是"没有返工"）。
2. **OKF 注入成本**：AGENTS.md 7,814 tok + index.md 1,050 tok = 8.9k tok/请求（占中位上下文 4.5%）。相对 read/grep 的 residency 属可接受；但 AGENTS.md 里有大段"教训段"（omp-upstream-merge 6,063 tok 的 skill 正文 + AGENTS.md 内嵌流程）与产品文档路由表，可按需下沉到 skill/文档。
3. **sandbox/permission 误拦**：30d 内 `sandbox.forbidRead` 与 `permission.rules` 未产生独立错误类；edit 的 `ssh://` 三连拦是正确的（引导到 write），但形态上是"先失败再纠正"，可在 edit 描述里一句话消掉。

### 1.7 角色/配置：advise 是最大的隐藏算力

| 指标 | 值 |
|---|---|
| advisor 计费请求 | 2,979 / 30d（占全部请求 33%） |
| 其中真正投递建议 | 985（"Queued for the end of the turn." 534 / "Delivered." 451） |
| advisor 新鲜输入 token | **63.7M / 112.8M 全量新鲜输入 = 56%** |
| advisor 上下文 | p50 281k / p90 545k tok |
| 每条送达建议的新鲜 token | ~64.6k |
| 集中度 | 前 4 个会话占 72M；单会话 1,493 轮只送达 558 条 |
| task / yield | task 82 次 / yield 162 次（30d）；子代理承担 43% 工具调用、57% token、3% 成本 |
| 缓存失效 | **362 个请求（4%）扛着 82.6% 的新鲜 token**；拆开看： |
| ├ advisor / `gpt-6-astra` | **165 次 no-cache 响应，54.5M fresh，均值 330,565/次**（provider 只回 ~3k 缓存） |
| ├ main / `mimo-v2.6-pro` | 58 次，26.3M fresh，均值 453,724/次 ← **$ 成本主要来源（约占 mimo $26 中的 $17）** |
| ├ main / `gpt-6-astra` | 14 次，2.4M |
| └ main / `glm-5.3-flash` | 9 次，2.2M |
| no-cache 响应的前置间隔 | p50 = 448s、p90 = 79,749s。**仅相关性**：与 provider 缓存 TTL 过期「一致」，但无 provider 侧证据（无响应头日志），不能当因果结论 |
| 压缩抖动 | 210 次上下文断崖（compaction 特征），其后的请求共 62.3M 新鲜 token |

## 2. 提案表（改动点 → 预期收益 → 风险 → 验证方法）

| # | 改动点 | 类型 | 预期收益（本机 30d 估算） | 风险 | 验证方法 |
|---|---|---|---|---|---|
| **P1** | `grep.contextAfter: 3→1` + `grep.contextBefore: 1→0`（两键均已在 settings registry 注册，可由 config.yml 覆盖） | **只改配置** | **重分词实测**：grep 结果 −40.5% token（1.74M / 4.30M；(文件,行号) 分组 + 重建文本重分词，自检误差 0.004%）；保守档 `after=2,before=1` = −12.3%，`after=1,before=1` = −27.0%。折算计费上下文 −10.6% 属**未验证的比例迁移** | 上下文行是"结构信号"，砍完可能增加"再 read 一次看上下文"的往返（当前 read→read 分页 508 次，需观察是否上升） | `stats:sync` 前后同窗口对比 grep p50/p90 与 read 调用数；A/B 两周 |
| **P2** | `prompts/tools/bash.md` 增一行拦截清单（cat/head/tail、grep/rg、find/fd、`sed -i`、`echo >` 均被拦截，改走 read/grep/glob/edit/write） | 改上游 prompt 文件 | 直接打击 172 block/30d 与 98 次重复变体；按 88 次成功重定向估算可省 ~88 次往返 | 提示词与拦截器重复表述，后续上游改规则会漂移 | 观察 `Blocked: Use the` 计数（`ss_tool_results`）两周内降幅 |
| **P2b** | 删掉 replace 模式 edit 描述里的 `<bash-alternatives>` 段（或改成"批量正则替换用 `eval`/脚本，不要 `sed -i`"） | 改上游 prompt 文件 `crates/pi-edit/prompts/replace.md` | 消掉已实测 2 次/30d 的自相矛盾；顺带省 60 tok/请求 | 失去"批量替换别用 edit"的引导 → 改为指向 `eval` | 语料回放 705 次 edit：统计"同文件多次 edit 同一字符串"的次数是否下降 |
| **P3** | 拦截器规则只对**单一命令**生效（含 `;`/`&&` 的复合命令不再拦），或把 grep/read/glob 规则收窄为"整条命令匹配" | 改上游代码 `tools/bash-interceptor.ts` + `exec/settings.ts` 默认表（后者我们已改过） | 消掉 148/172（86%）"连坐"作废；同时保留 14 条真阳性 | 放行复合命令里的 `cat file && …`，弱化"用对工具"的引导 | 单测：`checkBashInterception` 加复合命令用例；语料回放 172 条验证新判定分布 |
| **P4** | 对 `read` 的 http(s) 目标加默认上限（100 行 / 20 KiB）+ 明确分页提示 | 改上游代码 `tools/read.ts` | URL 读 522 次 / 1.27M tok（占 read+grep+glob 16%，均值 2.4k，最大 17.7k 的 GitHub API 响应） | 分页会增加往返；JSON 单行超长时按行切仍大 | 用 30d 语料回放 522 条 URL 读，统计 tarball/JSON 的截断损失 |
| **P5** | `grep`/`read` 对 `artifact://` 目标默认返回"计数 + 前 N 页"，禁止整篇回流 | 改上游代码 | artifact 再扫 91 次 / 322k tok（均值 3.5k，最大 22.8k） | 需要时得显式 `:N-M` 翻页 | 语料回放 91 条，核对是否有"必须整篇"的用例 |
| **P6** | advisor 策略：① 降低触发频率或改"高风险前审查"；② 给 advisor 上下文加"近 N 轮窗口"（当前全量 transcript，均值 330k fresh/次） | 配置 + 语义决策 | freshness 输入 −56% 上限中的大头；165 次 no-cache 响应 = 54.5M fresh | 建议密度下降，可能漏掉真实纠偏；窗口化会丢历史上下文 | 先测窗口化（不改触发率）：对比 advise 送达数与事后返工率两周 |
| **P7** | 缓存失效收敛：main 会话 `mimo` 的 58 次 no-cache（26.3M fresh ≈ $17/30d）用"更短会话/更低 compaction 阈值"避开；advisor 的 165 次（54.5M fresh）成因**待证**（TTL 只是与间隔一致的假设） | 配置（`compaction.*`）+ 与 P6 联动 | 246 次 no-cache 响应扛 85.5M fresh（占总 fresh 76%）——**这是现象，不是可归因收益** | 阈值下调=更多压缩，压缩本身要重发全量（210 次断崖已消耗 62.3M fresh） | 先用 `messages` 表确认 no-cache 是否集中在「间隔 > TTL」样本（单变量），再定阈值 |
| **P8** | 修 stats 工具链：`analyze.py followups` 增加 replace-模式返工探测（同文件 `old_string` 重叠/连续失败）；`audit.ts` 的 `TOOL_REGISTRY` 删掉已下线 MCP | fork 自有脚本（无上游冲突） | 恢复返工可观测性（当前 0 命中是假阴性） | 新增解析器需与 `ss_edit_calls` 语义对齐 | 用 705 次 edit 回放，至少能识别出本次人工找到的 9 条 |
| **P9** | 不建议动：工具描述压缩、semble 设备下线 | — | 描述合计 ≈3.7k tok（1.9% 上下文），semble 描述 273 tok。**probe 已实跑**：schema+outline 复原率 edit 8.3% / task 23.1%，且模型输出比原文更长（编造填充）→ 判为 load-bearing，不删 | —— | 若要推翻，需按 skill 补多样本面板（3 样本 × ≥3 模型）重测 |

## 3. 优先级（影响 × 成本）

| 档 | 项 | 影响 | 成本 | 上线路径 |
|---|---|---|---|---|
| **S1** | P1 grep 上下文默认值 | 高（grep 结果 −40.5%，重分词实测；折算计费上下文 −10.6% 为未验证迁移） | 极小（两行配置） | 配置即可，四机同步 |
| **S1** | P2 bash.md 拦截清单 | 高（88 次重定向的往返） | 小（一行 prompt） | 上游文件 → 记入冲突面 |
| **S2** | P3 拦截器只拦单一命令 | 高（148 条连坐） | 中（代码 + 单测） | 上游文件 → 记入冲突面 |
| **S2** | P2b 删 replace.md 的 `sed -i` 建议 | 小（2 次/30d 自相矛盾） | 极小（一段 prompt） | 上游文件 → 记入冲突面 |
| **S2** | P8 stats 工具链修复 | 中（恢复可观测性，后续优化全靠它） | 小（fork 脚本） | 无冲突 |
| **S3** | P4 URL 读取上限 / P5 artifact 再扫 | 中（合计 ~1.6M tok） | 中（read/grep 代码） | 上游文件 → 冲突面 |
| **S3** | P7 缓存/压缩策略 | 高但含混（与 provider 行为耦合） | 中（配置调参 + 两周观察） | 先实验后定 |
| **待决** | P6 advisor 策略 | 最高单项（56% 新鲜输入） | 语义决策 | 需你拍板后再动 |
| **不做** | P9 描述压缩 / semble 下线 | 低 | — | — |

### 需触碰上游文件的改动（追加到 rebase 冲突面清单）

| 文件 | 归属 | 关联提案 |
|---|---|---|
| `packages/coding-agent/src/prompts/tools/bash.md` | 上游 | P2 |
| `crates/pi-edit/prompts/replace.md` | 上游（当前活跃的 edit 描述） | P2b |
| `packages/coding-agent/src/tools/bash-interceptor.ts` | 上游 | P3 |
| `packages/coding-agent/src/exec/settings.ts` | **已在冲突面**（sandbox/permission/interceptor 注册） | P3 |
| `packages/coding-agent/src/tools/read.ts` | 上游 | P4 |
| `packages/coding-agent/src/tools/grep.ts` | 上游 | P5 |
| `packages/coding-agent/src/tools/settings.ts` | 上游 | P1（若不改默认值只写 config.yml 则无冲突） |

只改配置的（P1 走 `config.yml`、P6/P7 走 settings）：**零冲突面**，四机部署即生效。

## 4. 需要你拍板的点

1. **P1 取 `contextAfter=1, contextBefore=0`（重分词实测 −40.5%）还是保守的 `contextAfter=2, contextBefore=1`（−12.3%）**？"结构信号"损失只能靠两周 A/B 判，本报告无法替你判。
2. **P6 advisor 的定位**：是"每轮审查"（当前行为）还是"高风险动作前审查"？这决定 56% 新鲜 token 的取舍，纯数据无法替你定工作流语义。
3. **P3 的边界**：复合命令放行后，`cat a.txt && grep x b.txt` 这类会重新走 bash。接受"引导弱化"还是保留拦截并接受 86% 连坐？

## 5. 附：本次七条方法论修正（已实测，别重复踩）

1. `ss_tool_calls` ⨝ `ss_tool_results` 必须用 `(session_file, call_id)`；带 `seq` 全量失配（10,241 → 0）。
2. `is_error` 不能直接当失败率：`wait` 的 91 条是跳过语义；剔除后有效失败率 5.4%（不是 6.3%）。
3. **收益估算不能逐项独立取 min 再相加**：首版对 `contextAfter` 与 `contextBefore` 各自算 `min(k*m, ctx)` 再相加，重叠窗被重复计删，得出 −67% 的假数。
4. **多文件输出必须按 (文件, 行号) 建 key**：只用行号会把不同文件的同号行互相覆盖（2,001 条 grep 里 579 条是多文件输出）。
5. **省了多少 token 必须重分词**：用「行数 × 平均每行 token」得到的 −40.3% 与重分词实测 −40.5% 接近纯属巧合；方法不成立就不能写进提案。
6. **不能跨 corpus 相乘**：residency（audit，jsonl+mtime 窗口）与 result token（`ss_*`，秒级窗口）不同口径，除出来的 255×/417× 只能当方向性说明。要系数就在同一 corpus 内同时算。
7. **`probe-builtin.ts --model` 在 key 未注入 env 时鉴权失败**；用 `eval` 的 `completion(..., model="default"|"slow").wait()` 走本仓模型鉴权即可跑通同一方法。

## 6. 实施记录（2026-10-26）

### P1 已落地（决策 1：`contextAfter=1, contextBefore=0`）

| 项 | 内容 |
|---|---|
| 改法 | 四机 `~/.omp/agent/config.yml` 追加 `grep: {contextAfter: 1, contextBefore: 0}`；备份 `config.yml.bak-20261026-grepctx` |
| 本机 | 已写 + YAML 校验 + settings 句柄复核（`grep.contextAfter=1`、`grep.contextBefore=0`；对照组 `debug.enabled=true`、`memory.backend=mnemopi` 证明配置确实被加载） |
| 远端 | cnp6s / ser9 / desktop 各自 append（保留各机原有键：cnp6s 的 `providers`、desktop 的 `defaultThinkingLevel` 均未动），三机回读 `grep` 段一致 |
| 运行时冒烟 | 本会话立即生效：同一 grep 查询的输出从「1 行前置 + 3 行后置」变为「0 前置 + 1 后置」 |

### 待实施（需打包周期）

P2（`bash.md` 拦截清单）、P2b（`replace.md` 删 `sed -i` 建议）、可选 semble `savings` 工具——三者都改 bundle 内嵌内容，需一次重建 + 四机部署。

### 更正：拦截器不能靠配置"白名单"

读 `bash-interceptor.ts` 的 `checkBashInterception`：任何命中的规则一律 `blockedResult`，没有 allow 分支；`bashInterceptor.extraPatterns` 只是**前置追加**（first-match-wins，可以换一条更窄的规则重新拦、换提示语），`bashInterceptor.patterns` 可**整体替换**默认 10 条（配置可行但会与上游漂移）。因此「只在单一命令时拦截」= 改代码，不是改配置。

## 7. 附：semble_rs / OKF 调研（2026-10-26，含一处结论更正）

### 7.1 semble_rs：无上游更新可拉

| 检查项 | 实测 |
|---|---|
| 上游 `johunsang/semble_rs` | 本地 HEAD `8f8d963` == `origin/main`（`git ls-remote` 实查，fetch 经 7897 代理成功）→ 落后 0 |
| 最新 tag | `v0.9.1`；本地领先 5 个提交（含 `--version`） |
| 部署二进制 | `semble_rs 0.9.1`，`--version` 可用 → 与当前源码同版本，无需重建 |
| 子命令 | CLI 10 个，wrapper 封装 8 个；未封装 = `plan`（98b49860e3 主动移除）、`savings`（可跑：all-time 267 次调用，自称省 ~11.3M tok / 71%） |
| 采用率 | 30d 严格 xd:// 路由本机 51 次（0.5%），semble 子集约 18 次（fleet ~80）→ 瓶颈是采用率，不是能力 |

### 7.2 OKF：规范无新版本，但有覆盖缺口

| 检查项 | 实测 |
|---|---|
| 上游 `GoogleCloudPlatform/open-knowledge-format` | `SPEC.md` = **Version 0.2**；本仓 `product_doc/index.md` 声明 `okf_version: "0.2"` → 已对齐 |
| 上游动向（非 v0.2 正文） | ISO-8601 显式 offset 的时间戳要求（commit 3dc3029，本仓 AGENTS.md 已强制）；`supersedes`/`contested_by` 类型化关系边仍是 knowledge-catalog 仓提案（#148）→ 观察项 |
| §11 一致性硬条件① | refactor 树 product_doc 的 187 个 concept 文件中 **56 个无可解析 frontmatter**（plans 11、impl_details 17、hardware 5 等） |
| §9 `log.md` | 0 个（本仓用 `changelog.md`，MAY 级不违规） |
| §10 Attested Computation | 未使用（对指标型文档是唯一有实质价值的新能力） |
| §6.3 `references/` | 本仓用 `reference/`（单数），纯命名约定 |

### 7.3 更正：`okf_*` 工具没有"消失"，是查错了树

两个独立 checkout（不同 inode、不同分支），此前混用：

| | `/home/liao/workspace/act_ai_product` | `/home/liao/workspace/refactor/act_ai_product` |
|---|---|---|
| 分支 / HEAD | `main` / `4ec514c` | `master` / `2fcd6f0` |
| 角色 | 旧根：承载 `agents_harness/`（含 oh-my-pi、semble_rs）+ `.omp/tools` | 新布局根（AGENTS.md 所述 canonical）：`algorithms/ drivers/ product_doc/ …` |
| `.omp/` 内容 | `plans/ skills/ tools/`（**含 `okf-manage`**） | `config.yml skills/`（**无 tools/**） |
| `product_doc` | 126 个 .md，`index.md` 无 `okf_version` | 204 个 .md，`index.md` 有 `okf_version: "0.2"` |

- `okf-manage` 在旧根被 git 跟踪：`git ls-files .omp/tools` → `okf-manage/index.ts` + `index.test.ts`（613 行，暴露 `okf_add/okf_rm/okf_query/okf_status/okf_validate`）；新根 `git log -- .omp/tools` 为空 → **从未在新根存在过，不是被删**。
- 工具发现路径是 `<cwd>/.omp/tools/<name>/index.ts`（`discovery/builtin.ts:772,786`，`configDirs` 含 user `~/.omp/agent` 与 project `<cwd>/.omp`）。本会话 cwd 在新根 → `okf_*` 不可发现，所以 30d 调用为 0。
- 该工具用 `workspaceRoot() = import.meta.dir/../../..` 定位 `scripts/okf_manage.py`、`scripts/check_okf_wiki.sh`；这两个脚本**两棵树都有**，因此直接复制目录到新根 `.omp/tools/` 即可工作，无路径风险。

## 8. 调研：如何提高 semble 系列工具调用频率（2026-10-26）

### 8.1 实测事实

**时间线（本机全量语料）**

| 时期 | 形态 | 调用 | 备注 |
|---|---|---|---|
| 2026-06-16 → 08-28 | 一等工具（`tool_name=semble_*`） | 231 次 | 峰值在 06-16/17（基准测试期） |
| 2026-07-28 → 10-26 | xd:// 设备（`write xd://semble_*`） | 23 次执行 + 15 次 `read` 取文档 | 取文档后 **8 次**执行了同一设备（53%）、3 次执行了其它设备、**4 次**未再执行 |

**会话渗透率（同口径：该月有 semble 调用的会话 / 该月有工具调用的会话）**

| 月份 | 会话 | 有 semble | 渗透率 | 直接 / 设备 |
|---|---|---|---|---|
| 2026-06 | 355 | 85 | 23.9% | 126 / 0 |
| 2026-07 | 338 | 60 | 17.8% | 95 / 4 |
| 2026-08 | 175 | 10 | 5.7% | 10 / 1 |
| 2026-09 | 232 | 7 | 3.0% | 0 / 14 |
| 2026-10 | 90 | 11 | 12.2% | 0 / 20 |

**同模型对照（排除"换模型"解释）**：`deepseek-v4-flash` 会话的 semble 渗透率 06 月 30.4% → 07 月 20.2% → 08 月 **4.6%**。同一模型，一个月内掉到 1/4.4。

**错误率反证（排除"报错劝退"解释）**：直接期 semble 错误率 06 月 34.9% → 07 月 20.0% → 08 月 10.0%，**错误在变少，使用却在崩塌**。

**错误构成（直接期 64 次）**：`Executable not found in $PATH: semble_rs` ≈ 20、`SEMBLE_MODEL_PATH required` ≈ 7、`tree timed out after 60s` 13、`search timed out after 180s` 1、`No supported files under …` 3、`Failed to load model` 2、wrapper 缺陷 `proc.stdin.getWriter is not a function`（digest 2）、API 误用（`No chunk found at file:line` 4、`File not found in graph` 2、`max_depth too small` 1）。

**外部指令驱动只占少数**：6 月有 semble 调用的 87 个会话里，用户提示中提到 "semble" 的只有 12 个（14%）——**86% 是模型自选**。

**价值侧基准（`docs/semble-benchmark-results.md`，2026-06-17，`omp` vs `omp-semble` 同任务对照）**：`semble_tree` −17%、`find_pattern` −26%、`deps` −30%、`impact` −48%、`search` −41%、`encode` −41%；`digest` +27%、`plan` +49%（plan 已移除）。描述改写后 **9/9 工具被选中**。

### 8.2 假设与证据强度

| 假设 | 证据 | 强度 |
|---|---|---|
| H1 **入口降级**：从一等工具变成 xd:// 设备后，用一次要两步（先 `read xd://x` 取文档，再 `write xd://x` 传 JSON） | 时间重合（设备 07-30 首次执行，08 月崩塌）；同模型对照排除换模型；错误率下降排除劝退；设备期 39 次触碰里 14 次只取文档 | 强（相关，非受控实验） |
| H2 **无触发规则**：prompt 只有设备目录一行摘要，AGENTS.md 只有"文件级操作 → 用 semble"这类抽象表述 | 无任何"问 X 就调 Y"的具体映射；`code-intelligence` skill 也没给触发条件 | 中 |
| H3 可靠性残留 | `tree` 60s 超时 13 次仍是硬伤（大仓必超时）；digest stdin 缺陷；find_related 需要 chunk 定位但文档没教 | 弱-中（历史错误多在修） |
| H4 竞争引导 | AGENTS.md 规定"多轮搜索 MUST 用 Task + scout"，与 semantic search 抢同一场景 | 中 |

### 8.3 干预措施（按证据强度排序）

| # | 改动 | 成本 | 预期 | 验证 |
|---|---|---|---|---|
| **L1** | 把 `semble_search` + `semble_deps` 声明 `loadMode: "essential"`（恢复一等工具） | 2 行（fork 自有文件）+ 约 +200~260 tok/请求（估算） | 直接消除两步入口摩擦；历史证据：一等期 231 次 → 设备期 24 次执行 | 上线 2 周看执行次数与会话渗透率 |
| **L2** | 在 AGENTS.md 加 3 条具体触发规则（见 §8.4） | ~80 tok/请求（AGENTS.md 已 7.8k） | 把"知道有这工具"变成"知道何时用" | 同上按工具拆分统计 |
| **L0**（新增，必须先做） | `deps`/`impact` 的 `file_path` 归一化：绝对路径转成相对 `path` 的路径 | 改 wrapper ~10 行 + 2 条单测 | 修掉**现存**缺陷：二进制要求 `<FILE_PATH>` 相对路径，wrapper 原样透传 → 绝对路径必失败（历史 deps 6/14、impact 5/8 错误即此） | 单测 + `write xd://semble_deps` 端到端冒烟 |
| **L4** | 在 `scout`/`theorist` agent 定义里写明"探索前先 `semble_tree`/`semble_deps`" | 2 个 prompt 文件 | 子代理占 43% 调用量，是放大器 | 子代理会话中出现率 |

### 8.4 L2 的具体规则草案（待你确认措辞）

- 问"这个改动会影响哪些文件" → `semble_impact`（先 `semble_deps` 看导出符号）
- 问"这个模块对外暴露什么 / 依赖什么" → `semble_deps`
- 同一问题 grep 两次没定位到 → `semble_search`（按语义找，不按变量名）
- 构建/测试日志超过 ~100 行 → `semble_digest`，并直接信任其输出

### 8.5 判定实验

- **指标**：每会话 semble 执行次数；semble 会话渗透率；grep/glob 调用数；read+grep 结果 token。
- **基线（设备期现状）**：30d 调用占比 0.22%、11/90 会话（10 月）、执行 24 次 / 8 周。
- **成功门槛**：执行次数 ≥3 倍（约 2 次/活跃日）且 read+grep 结果 token 不上升（防止"用了但没省"）。
- **分批**：只在本机先上 L1（一周）→ 无效则说明入口不是瓶颈，转 L2+L4；有效再四机。

### 8.6 不建议做

- **再改工具描述**：基准里描述已达 9/9 命中，且现有摘要已含 trigger 与 "PREFER THIS over …" 句式。
- **加新工具（如 `savings`）**：缺的是入口与习惯，不是能力。
- **全量 `tools.xdev: false`**：会把 `retain/recall/memory_edit/eval` 等一并提升，schema 成本上升，且与上游默认行为分叉。

### 8.7 复核与修正（2026-10-26 第二轮）

对 §8.3 的原始 L3 逐项做了现版本核查，三条被推翻，同时发现一个真实缺陷：

| 原判断 | 复核结果 | 证据 |
|---|---|---|
| `digest` stdin 有 `getWriter` 缺陷，需修 | **已不存在** | `.omp/tools/semble-rs/index.ts:358-362` 现为 `proc.stdin.write(new TextEncoder().encode(stdinText)); proc.stdin.end();`；且 `write xd://semble_digest` 实测成功（2 行 `Compiling` 被剥离，1 warning + 2 error 保留） |
| `tree` 60s 超时是隐患 | **本仓不成立** | 实测 `product_doc` 0.19s、整个 refactor 仓 8.18s，远低于 60s；历史 13 次超时发生在 `robotbridges`（~70 个 vendor 目录） |
| 15 次 `read` 取设备文档 = "取完就停" | **不成立** | 按会话配对：8/15（53%）随后执行了同一设备，3 次执行其它设备，仅 4 次未执行 |
| — | **新发现真缺陷**：`deps`/`impact` 要求 `<FILE_PATH>` 相对 `<PATH>`，wrapper 原样透传模型给的路径 → 绝对路径 100% 失败 | 实测：`deps <绝对文件> .`、`deps <绝对文件> <绝对根>` 均报 `File not found in graph`；`deps <相对文件> <绝对根>` 正常（2.6s）。历史错误 deps 6/14、impact 5/8 与此一致 |

`semble_search` 实测可用：查询 "where is the ethercat state machine handled" 指向 `drivers`，8.97s 命中 `arm/src/motor_backend/ethercat/ds402.rs`（`Ds402StateMachine`）与 `service.rs`，即正确位置。

**修订后的实验纪律**：`okf`/`digest`/`tree` 三项剔除后，唯一与采用率有关的改动是「入口降级」，因此 **L0 + L1 必须单独成批**；若与 L2（触发规则）同批上线，就无法区分"是入口修好了"还是"是规则提醒了"。L2/L4 放到 L1 的观测窗之后。

## 9. 实施记录：L0 + L1 + P2 + P2b + savings（2026-10-26 第二轮）

### 9.1 代码改动（全部在 fork 自有文件，上游冲突面只增 2 个 prompt 文件）

| 项 | 文件 | 内容 |
|---|---|---|
| L0 | `.omp/tools/semble-rs/index.ts` | 新增 `normalizeGraphTarget()`：`deps`/`impact` 的绝对 `file_path` 归一化为相对 `path`；越界时回退到文件自身目录。同时修正两个参数描述（"relative to `path`"） |
| L1 | 同上 | `semble_search` + `semble_deps` 各加 `loadMode: "essential", // L1-experiment` 一行 |
| savings | 同上 | 新增第 9 个工具 `semble_savings`（`savings [--verbose]`）+ args 分支 |
| P2 | `packages/coding-agent/src/prompts/tools/bash.md` | 新增一行拦截清单 + "整条复合命令会被整段拦掉，请拆开" |
| P2b | `crates/pi-edit/prompts/replace.md` | 删掉 `<bash-alternatives>` 里推荐 `sed -E -i` 的表格，改为"被拦截，走 eval/ast_edit" |
| 文档 | `.omp/skills/{omp-packaging,omp-upstream-merge}/SKILL.md` | 8 → 9 工具，登记 `semble_savings` |

### 9.2 验证（逐项实测）

| 验证 | 结果 |
|---|---|
| 单测 | `bun test ./.omp/tools/semble-rs/index.test.ts` → **17 pass / 0 fail**（含 5 条新增：绝对→相对、跨根回退、相对不变、savings 两种形态） |
| 类型检查 | `bun run check:ts` → 14 个包全部 Done，EXIT=0 |
| L1 装载（真实 factory + 真实 `defaultLoadModeForToolName`） | 处理组文件 → `topLevel=[semble_deps, semble_search]`；对照组文件 → `topLevel=[]`（三个工具均 `discoverable`） |
| P2 是否进二进制 | 新 bundle `lib/omp` 含 `blocks the WHOLE compound command` → FOUND |
| P2b 是否进原生绑定 | `pi_natives.linux-x64-modern.node` 含新措辞、旧表格行 absent |
| 部署 | `omp-deploy.sh` → 四机版本一致 `omp/18.12.6-custom.202610261839` |
| 对照组隔离 | cnp6s / ser9 / desktop 的 `~/.omp/agent/tools/semble-rs/index.ts` 剔除 2 行标记（1055 行 / 26,569 字符），TS 解析通过，`factory` 与 `savings` 完好 |

### 9.3 事故与修复（写下来防止复犯）

`scripts/semble-l1-control.sh` 第一版把函数定义经 ssh 传入，但 `MARKER` 是*本地*全局变量 → 远端为空串 → Python 的 `marker not in line` 对所有行成立 → **三台机器的工具文件被清空成 0 字节**。

- 立即从 `.l1-treatment.bak` 恢复，重新按"恰好 2 行"裁剪，并用真实 factory 装载校验（见 9.2）。
- 脚本已重写为：脚本走 **stdin**、marker 在 heredoc 字面量里、**写前断言命中数 == 2**、断言后文件行数 > 900、空文件自动从备份恢复。

### 9.4 仍未收口

- `pi_natives.linux-x64-baseline.node` 在本轮首次构建时仍是旧 prompt（只重建了 host/modern 变体）；已启动 `bazel-natives linux-x64-baseline` 重建，重建后需再打一次 bundle 才能让两个变体一致。现网四机均为 modern 变体，故不影响当前行为。

### 9.5 最终部署状态

| 项 | 值 |
|---|---|
| Bundle | `omp-18.12.6-custom.202610261847-linux-x64`（49 files checksummed） |
| 四机版本 | local / cnp6s / ser9 / desktop 全部 `omp/18.12.6-custom.202610261847` |
| 原生变体 | `modern` 与 `baseline` 均已含新 edit prompt（旧 `sed -E -i` 表格行两变体均已消失） |
| 处理组（本机） | 工具文件 1058 行 / 2 个 `loadMode` 标记；真实装载 `topLevel=[semble_deps, semble_search]` |
| 对照组（三远机） | 1055 行 / 0 标记 / `topLevel=[]`；真实装载三个工具均 `discoverable` |
| `semble_savings` | 已随 bundle 分发（9 个工具），`discoverable`（按需 `write xd://semble_savings`） |

## 10. L0 重做（2026-10-26，第二版：修正两个设计错误）

第一版 `normalizeGraphTarget` 有两处必须纠正的错误，均已在第二版修掉：

| 第一版错误 | 后果 | 第二版 |
|---|---|---|
| 用 `path.resolve(root)`（进程 CWD）解析根 | `runSemble` 实际以 `options.cwd = pi.cwd` 派生进程；两者不同时算出的相对路径指向别处 | `resolveGraphTarget(filePath, root, cwd)`，根按 **subprocess cwd** 解析 |
| 文件越界时把 root 偷换成文件自身目录 | 命令**成功返回**但图范围被缩小，`impact` 漏掉目录外调用方 —— 自信的错误答案 | 越界直接**报错**并给出怎么改（"pass a file inside that root, or set path to a directory that contains it…"） |

### 10.1 真实图查询证据（证明"缩小 root"会静默丢结果）

| 调用 | 结果 |
|---|---|
| `impact src/motor_backend/mod.rs`，root=`crates/arm` | **1 files affected: `src/lib.rs`** |
| `impact mod.rs`，root=`crates/arm/src/motor_backend`（被偷换后的根） | **`No files affected`**，exit=0 |

同一个文件、同一份图，根缩小后调用方凭空消失且返回成功 —— 这就是必须报错而非"兜底"的理由。

### 10.2 第二版验证

| 验证 | 结果 |
|---|---|
| 单测 | 19 pass / 0 fail；新增 6 条：绝对路径按 subprocess cwd 解析、相对 root 解析、**`process.chdir()` 后仍按传入 cwd 解析**、绝对 root 保持、越界必须报错（断言 message 含 `is outside path` 与 `hides callers outside it`）、相对路径原样透传 |
| 端到端（安装版本模块，真实 spawn 二进制） | ① 绝对路径 + root=`.` → 成功（`File: crates/psr/src/command.rs`，修复前是 `File not found in graph: /abs/…`）；② 根外文件 → `isError=true` + 可操作提示 |
| 部署 | 四机一致 `omp/18.12.6-custom.202610261851`；处理组 1092 行 / 2 标记，对照组 1089 行 / 0 标记 |
| 对照组隔离 | `scripts/semble-l1-control.sh` 幂等（stripped=2、行数断言、空文件自动恢复） |
