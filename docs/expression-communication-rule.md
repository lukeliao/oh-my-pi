# 对话与文档用语规范——内置规则实现说明

> 源起：Karpathy 关于技术写作要"说人话"的思路。本仓的落地产物是一条**内置常驻表达规则**（rule 名 `expression-communication`），随 binary 分发，覆盖全部会话角色。
> 关联 commit：`39424d67cf`（内置规则 + advisor 接线 + 测试）；首个含该规则的部署版本 `omp-18.8.0-custom.202610090232`。

## 1. 落地思路

Karpathy 的要求属于**表达层**：怎么把话讲清楚，不影响工具权限、审批门、安全语义。因此实现为一条常驻规则（`alwaysApply: true`），而不是安全规则或工具行为。

规范正文由廖工逐条审定，共七节：

1. 先说清楚，再求简洁；
2. 沿用名称，不自造术语；
3. 用中文解释，保留准确标识；
4. 事实不能为文风让路；
5. 长时间工作后仍回答原问题；
6. 请使用者判断前，先把问题讲完整；
7. 用结构帮助理解。

全文见 `packages/coding-agent/src/discovery/builtin-rules/expression-communication.md`（唯一正文真源）。产品侧口径文档在 `product_doc/language_style.md`（用语规范）与 `product_doc/glossary.md`（术语表）。

## 2. 提示词注入点（harness 哪部分加了什么）

| 覆盖角色 | 注入点 | 内容 | 机制 |
|---|---|---|---|
| 全部会话（main / task / vibe worker / subagent） | `packages/coding-agent/src/discovery/builtin-rules/expression-communication.md`，经 `builtin-rules/index.ts` 注册进 `BUILTIN_RULE_SOURCES` 并导出 `EXPRESSION_COMMUNICATION_SOURCE` | 规范七节全文 | builtin rule，frontmatter `alwaysApply: true`，经 generic-rules 渲染进主 system prompt |
| advisor | `packages/coding-agent/src/session/session-advisors.ts` 的 `ADVISOR_EXPRESSION_PROMPT` | 同一文件 `parseFrontmatter(...).body` | 显式 push 进 advisor `systemPrompt`（advisor 装配不走 builtin rule 通道） |
| 用户级补充 | `~/.omp/agent/APPEND_SYSTEM.md` | 只保留硬件/操作规则指针段 | 不含表达规范正文，避免重复渲染 |

### 注入链路（执行顺序）

**链路 A —— 所有会话（main / task / vibe worker / subagent）：**

1. **编译期内嵌**：`builtin-rules/index.ts` 用 `import expressionCommunication from "./expression-communication.md" with { type: "text" }` 把 md 全文（含 frontmatter）编进 binary，注册进 `BUILTIN_RULE_SOURCES`，同时导出 `EXPRESSION_COMMUNICATION_SOURCE`。
2. **规则发现**：会话启动时 `discovery/builtin-defaults.ts` 的 `builtin-defaults` provider（priority=1）把 `BUILTIN_RULE_SOURCES` 经 `buildRuleFromMarkdown` 解析成 `Rule` 对象；frontmatter 的 `alwaysApply: true` 成为规则属性。
3. **分桶**：`capability/rule-buckets.ts` 的 `bucketRules` 把 `alwaysApply === true` 的规则放进 `alwaysApplyRules` 桶（不进 rulebook，不做 TTSR 触发）。
4. **渲染进 system prompt**：`system-prompt.ts` 的 `buildSystemPrompt` 收到 `alwaysApplyRules`，先经 `dedupeAlwaysApplyRules` 对 promptSources（custom prompt / append / contextFiles）做内容去重，再由模板 `prompts/system/system-prompt.md` 的 `<generic-rules>` 块（`{{#each alwaysApplyRules}}{{content}}{{/each}}`）把正文写进 system prompt。
5. 这是所有 AgentSession 的公共装配路径——main、task、subagent（`taskDepth > 0` 或带 `parentTaskPrefix`）、vibe worker 都走它，所以正文每会话恰好出现 1 次。

**链路 B —— advisor（不走上面的模板）：**

1. **取正文**：`session/session-advisors.ts` 模块加载时执行 `ADVISOR_EXPRESSION_PROMPT = parseFrontmatter(EXPRESSION_COMMUNICATION_SOURCE).body.trim()`——同一个导出，frontmatter 被剥掉。
2. **注入**：advisor 会话装配时 `systemPrompt = [渲染后的 advisor 基础 prompt, ADVISOR_EXPRESSION_PROMPT, ...]`，其后才是 context/memory/watchdog 段。advisor 的 system prompt 不经过 `<generic-rules>` 模板，所以必须显式 push 这一段。
3. 该注入与 `WATCHDOG.md` 是否存在无关。

同源保证：两处注入读同一个 md 文件。改正文只改 `expression-communication.md`，两处自动一致。

### 产品术语的注入通道（workspace 级，不进 binary）

产品术语（说哪些词）与表达纪律（怎么说话）走不同通道：

- **载体**：`act_ai_product` 根 `AGENTS.md` 的「产品术语速查（已审定条目）」节——经 project-context 自动进入所有产品 workspace 会话（含子仓 cwd 会话、task/subagent 继承）。内容是 `product_doc/glossary.md` 的〔用户已确认〕39 条紧凑快照；待审/已排除条目不进系统规范（遵守 glossary 使用约束），真源冲突以真源和代码为准。
- **为什么是 AGENTS.md 而不是规则目录**：实测发现 `.agent/rules` 与 `.omp/rules` 的向上查找止于各子仓自己的 git 根——在 `drivers/act_ai_drivers` 等子仓 cwd 启动的会话看不到 workspace 根的规则文件；而根 AGENTS.md 的 project-context 通道实测跨嵌套仓边界，子仓会话可见。
- **迭代**：改根 `AGENTS.md` 该节 + git 同步即可，新会话生效，免构建免部署。glossary 条目变更后需同步该节（真源仍是 `product_doc/glossary.md`）。

## 3. 关键设计决策

- **内置 rule，而不是用户级 `~/.omp/agent/RULES.md`**：单一正文真源、随版本分发、多机免同步。用户文件与 builtin 并存会把正文渲染两次（alwaysApply 规则之间无内容去重），因此新 bundle 部署后删除了四机用户副本（`RULES.md`/`WATCHDOG.md`，备份在各机 `/tmp/*.bak-20261009`）。
- **advisor 显式注入**：advisor 的 system prompt 在 `session-advisors.ts` 装配，generic-rules 通道不覆盖它。注入位置在渲染后的 advisor 基础 prompt 之后、context/memory/watchdog 之前，且与 watchdog 文件是否存在无关。
- **`parseFrontmatter(...).body`**：只取正文，`alwaysApply` 等元数据不进 advisor prompt。
- **同名用户/项目规则可覆盖**：builtin-defaults provider 优先级低（priority 1），发现层同名规则以用户/项目规则为准。

## 4. 验证方法（可复现）

- 单测：`packages/coding-agent/test/discovery/builtin-defaults.test.ts`（断言 `alwaysApply` 与正文标记句）；`packages/coding-agent/test/advisor-watchdog.test.ts`（session 装配层断言 advisor dump 含正文标记句）。
- prompt 装配 smoke（零模型）：空 agentDir 与真实 agentDir 各跑一遍，main / task / subagent / advisor 正文各恰好 1 次（无重复、无遗漏）。subagent 一场同时覆盖 vibe worker（它复用 task spawn 的 subagent 装配路径）；未单独进 `/vibe` runtime 验证。
- binary 内嵌验证：bun compile 把非 ASCII 字符串存为 `\uXXXX` 转义序列，字节计数须按转义形态检索（按 UTF-8/UTF-16 检索会误判缺失）。
- 部署核验：四台 x64 开发机 `lib/omp` 完整 SHA-256 一致，`omp --version` 同版本。

## 5. 已知边界

- 以上验证止于 **prompt 装配层**（规则注入位置与次数）。真实模型改写样例尚未达标（输出仍夹 `wire`/`fail-open` 等未解释术语、发明无依据备选项），行为层达标与否需另行重验，不得由本文件的部署记录推定。
- 本文件加入后，已部署 binary 内嵌的 `omp://` docs 索引在下次构建时收进（`docs-index.generated.ts` 为构建生成物）。

## 6. 修改规范正文的流程

快速试稿（不重建）：放一个同名规则 `expression-communication.md` 即可覆盖 builtin（同名 first-wins；builtin provider priority=1，任何用户/项目规则都赢）。路径按作用域选：用户全局 `~/.omp/agent/rules/`（对所有项目生效），项目级 `<cwd>/.omp/rules/`（只对当前仓生效）；规则名取自文件名，扩展名 `md`/`mdc`。定稿后把正文落回 builtin md 并删除覆盖文件。临时停用单条规则可用 `ttsr.disabledRules: ["expression-communication"]`，整体停用用 `ttsr.builtinRules: false`。

定稿入库：

1. 改 `packages/coding-agent/src/discovery/builtin-rules/expression-communication.md`（保持 frontmatter `alwaysApply: true`）。
2. 同步更新 `builtin-defaults.test.ts` 与 `advisor-watchdog.test.ts` 里的正文标记句断言。
3. 跑 `bun test packages/coding-agent/test/discovery/builtin-defaults.test.ts packages/coding-agent/test/advisor-watchdog.test.ts` 与 `bun run check:ts`。
4. 构建 bundle 并 `./scripts/omp-deploy.sh <bundle>` 部署；如需同步产品口径，改 `product_doc/language_style.md` 与 `product_doc/glossary.md`。
