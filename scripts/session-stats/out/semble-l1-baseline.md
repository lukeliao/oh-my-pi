# Semble 采用率实验 — L1 基线（2026-10-26）

> 上线版本：`omp/18.12.6-custom.202610261847`（四机一致）。处理组=本机；对照组=cnp6s/ser9/desktop（脚本 `scripts/semble-l1-control.sh`，已实测 strip=2 / 1055 行 / factory+savings 完好）。

L1 = 把 `semble_search` + `semble_deps` 从 xd:// 设备提升为一等工具（`loadMode: "essential"`）。
目的：判定"入口降级"是不是采用率崩塌的主因。**单变量**：同批部署里的 P2/P2b/savings/L0 都不影响工具呈现方式（P2 只影响 bash 拦截提示、P2b 只影响 edit 提示、savings 是新增设备、L0 只改 deps 的路径归一化）。

## 分组

| 组 | 机器 | 状态 |
|---|---|---|
| 处理组 | liao-NUC12DCMi9（本机） | `index.ts` 含 2 行 `loadMode: "essential" // L1-experiment` |
| 对照组 | cnp6s / ser9 / desktop | 同二进制、同 wrapper、同 prompt，**仅剔除这 2 行**（`scripts/semble-l1-control.sh`） |

## 基线（设备期，提升前）

| 指标 | 值 | 来源 |
|---|---|---|
| 设备期执行次数 | 23 次 / 8 周（`write xd://semble_*`） | `ss_tool_calls` + arg `path` 匹配 |
| 设备期文档读取 | 15 次，其中 8 次（53%）随后执行同一设备 | 同上，按会话配对 |
| 30d 调用占比 | 0.22%（20 / 9,007，2026-10） | 同上 |
| 10 月会话渗透 | 11 / 90 会话 | 同上 |
| 直接工具期对照 | 231 次（2026-06-16 → 08-28） | `tool_name LIKE 'semble%'` |
| 历史错误 | deps 6/14、impact 5/8（绝对路径）、tree 13 次 60s 超时（robotbridges） | `ss_tool_results` |

同时段功能性冒烟（2026-10-26，本次改动前测的二进制行为）：
- `search` 可用：`"where is the ethercat state machine handled"` → 8.97s，命中 `arm/src/motor_backend/ethercat/ds402.rs`、`service.rs`
- `deps`：相对路径 OK（2.6s），绝对路径 100% 失败 → 已由 L0 归一化修复
- `digest`：stdin 路径正常（历史 `getWriter` 缺陷已不存在）
- `tree`：`product_doc` 0.19s、整仓 8.18s（60s 上限无风险）

## 判定门槛（上线后 1–2 周）

| 指标 | 成功门槛 | 采集 |
|---|---|---|
| 处理组 semble 执行次数 | ≥3× 基线（设备期 ≈3 次/周/机 → ≥9 次/周） | `stats:sync` + 设备路由统计 |
| 处理组会话渗透 | ≥3× 基线（10 月 12%） | 同上 |
| 对照组 | 不显著上升（排除"同期外力"） | 同上 |
| 副作用：read+grep 结果 token | 不上升（防"用了但没省"） | `stats:tools --since 7d` |
| `semble_savings` 读数 | 处理组调用数增长与 DB 计数方向一致 | 新工具输出 |

## 采集命令

```sh
cd ~/workspace/act_ai_product/agents_harness/oh-my-pi
bun run stats:sync
python3 - <<'PY'
# 设备路由 + 直接工具双口径统计（与基线同口径）
import sqlite3, json, collections, time
db = sqlite3.connect('file:%s/.omp/stats.db?mode=ro' % __import__('os').path.expanduser('~'), uri=True)
since = int(time.time()*1000) - 7*86400*1000
cnt = collections.Counter()
for tn, a in db.execute("select tool_name, arg_json from ss_tool_calls where timestamp>=?", (since,)):
    if tn.startswith('semble'):
        cnt[tn] += 1; continue
    try: p = json.loads(a or '{}').get('path') or ''
    except Exception: p = ''
    if isinstance(p, str) and p.startswith('xd://semble'):
        cnt[p[5:].split('(')[0].split('/')[0]] += 1
print(dict(cnt))
PY
```

## 决策规则

- 处理组达标、对照组不达标 → 入口降级成立，L1 全量推广，再评估 L2（触发规则）。
- 两组都不变 → 入口不是瓶颈，撤销 L1，转 L2 + L4（触发规则/子代理注入）。
- 处理组上升但 read+grep token 也上升 → 工具被滥用（拿到答案仍重复搜索），先修触发条件再推广。
