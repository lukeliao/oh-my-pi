# Feishu Tools Skill

飞书操作工具集。MCP 的 `preset.default` 覆盖了 bitable/docx/wiki/chat 查询，但**消息发送和日历操作**缺失。本 skill 补充这两个缺口。

## 用法

```bash
# 发送消息（P2P）
bash .claude/skills/feishu-tools/feishu.sh send --to open_id --text "消息内容"

# 发送消息（群聊）
bash .claude/skills/feishu-tools/feishu.sh send --chat chat_id --text "消息内容"

# 创建会议
bash .claude/skills/feishu-tools/feishu.sh meeting \
  --summary "会议标题" \
  --start "2026-06-27 00:00" \
  --end "2026-06-27 01:00" \
  --attendees ou_xxx,ou_yyy

# 查询群列表
bash .claude/skills/feishu-tools/feishu.sh chat-list

# 查询群成员
bash .claude/skills/feishu-tools/feishu.sh members --chat chat_id
```

## 前置条件

- 环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_CAL_ID` 已设好
- Bot 可用范围已发布（发消息给用户的前提）
- `curl` + `python3` 可用

## 注意事项

- `content` 字段必须是 JSON 字符串，脚本自动处理
- 日历创建后需**单独调 attendees API** 加参与者
- tenant_access_token 自动获取，有效期 2h
- 时间格式统一用 `Asia/Shanghai` 时区
