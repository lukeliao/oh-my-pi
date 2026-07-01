#!/usr/bin/env bash
# Feishu API tools - unified script
# Usage: feishu.sh <command> [options]
set -euo pipefail

APP_ID="${FEISHU_APP_ID:-}"
APP_SECRET="${FEISHU_APP_SECRET:-}"
DOMAIN="https://open.feishu.cn"
CAL_ID="${FEISHU_CAL_ID:-}"

# ── helpers ──────────────────────────────────────────

get_token() {
  curl -s --max-time 5 -X POST "${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
    -H 'Content-Type: application/json' \
    -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" \
    --noproxy '*' | python3 -c "import sys,json; print(json.load(sys.stdin)['tenant_access_token'])"
}

api() {
  local method=$1 url=$2 body=$3
  local token=$(get_token)
  if [ -n "$body" ]; then
    curl -s --max-time 10 -X "$method" "$url" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d "$body" --noproxy '*'
  else
    curl -s --max-time 10 -X "$method" "$url" \
      -H "Authorization: Bearer $token" --noproxy '*'
  fi
}

# ── send message ─────────────────────────────────────

cmd_send() {
  local to="" chat="" text="" msg_type="text"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to) to="$2"; shift 2 ;;
      --chat) chat="$2"; shift 2 ;;
      --text) text="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [ -z "$text" ]; then echo "Usage: send --to <open_id> | --chat <chat_id> --text <msg>"; exit 1; fi

  local receive_id_type receive_id
  if [ -n "$chat" ]; then
    receive_id_type="chat_id"
    receive_id="$chat"
  elif [ -n "$to" ]; then
    receive_id_type="open_id"
    receive_id="$to"
  else
    echo "ERROR: need --to or --chat"; exit 1
  fi

  # Escape text for JSON
  local content
  content=$(python3 -c "import json; print(json.dumps({'text': '$text'}))")
  local body
  body=$(python3 -c "
import json
print(json.dumps({
    'receive_id': '$receive_id',
    'msg_type': '$msg_type',
    'content': json.dumps({'text': '$text'})
}))
")

  local resp
  resp=$(api POST "${DOMAIN}/open-apis/im/v1/messages?receive_id_type=${receive_id_type}" "$body")
  local code
  code=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['code'])" 2>/dev/null)
  if [ "$code" = "0" ]; then
    local msg_id
    msg_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['message_id'])" 2>/dev/null)
    echo "✅ sent: $msg_id"
  else
    echo "❌ code=$code $(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('msg',''))" 2>/dev/null)"
  fi
}

# ── meeting ──────────────────────────────────────────

cmd_meeting() {
  local summary="" description="" start_ts="" end_ts="" attendees=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --summary) summary="$2"; shift 2 ;;
      --desc) description="$2"; shift 2 ;;
      --start) start_ts="$2"; shift 2 ;;
      --end) end_ts="$2"; shift 2 ;;
      --attendees) attendees="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [ -z "$summary" ] || [ -z "$start_ts" ] || [ -z "$end_ts" ] || [ -z "$attendees" ]; then
    echo "Usage: meeting --summary <title> --start <YYYY-MM-DD HH:MM> --end <YYYY-MM-DD HH:MM> --attendees <ou_xxx,ou_yyy>"
    exit 1
  fi

  # Convert timestamps
  local s_ts e_ts
  s_ts=$(python3 -c "
from datetime import datetime, timezone, timedelta
cst = timezone(timedelta(hours=8))
dt = datetime.strptime('$start_ts', '%Y-%m-%d %H:%M').replace(tzinfo=cst)
print(int(dt.timestamp()))
")
  e_ts=$(python3 -c "
from datetime import datetime, timezone, timedelta
cst = timezone(timedelta(hours=8))
dt = datetime.strptime('$end_ts', '%Y-%m-%d %H:%M').replace(tzinfo=cst)
print(int(dt.timestamp()))
")

  local desc="${description:-周会}"

  # Step 1: Create event
  echo "📅 Creating event: $summary ($start_ts → $end_ts)..."
  local create_body
  create_body=$(python3 -c "
import json
print(json.dumps({
    'summary': '$summary',
    'description': '$desc',
    'need_notification': False,
    'start_time': {'timestamp': '$s_ts', 'timezone': 'Asia/Shanghai'},
    'end_time': {'timestamp': '$e_ts', 'timezone': 'Asia/Shanghai'},
    'attendee_ability': 'can_invite_others',
    'visibility': 'public',
    'free_busy_status': 'busy',
    'reminders': [{'minutes': 15}]
}))
")
  local resp
  resp=$(api POST "${DOMAIN}/open-apis/calendar/v4/calendars/${CAL_ID}/events?user_id_type=open_id" "$create_body")
  local code event_id
  code=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['code'])" 2>/dev/null)
  if [ "$code" != "0" ]; then
    echo "❌ Create failed: $(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('msg',''))" 2>/dev/null)"
    exit 1
  fi
  event_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['event']['event_id'])" 2>/dev/null)
  echo "✅ Event created: $event_id"

  # Step 2: Add attendees
  echo "👥 Adding attendees..."
  IFS=',' read -ra ATT_LIST <<< "$attendees"
  local att_json="["
  local first=true
  for att in "${ATT_LIST[@]}"; do
    [ "$first" = true ] && first=false || att_json+=","
    att_json+="{\"type\":\"user\",\"user_id\":\"$att\"}"
  done
  att_json+="]"

  local att_body
  att_body=$(python3 -c "
import json
print(json.dumps({
    'attendees': $att_json,
    'need_notification': True
}))
")
  resp=$(api POST "${DOMAIN}/open-apis/calendar/v4/calendars/${CAL_ID}/events/${event_id}/attendees?user_id_type=open_id" "$att_body")
  code=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['code'])" 2>/dev/null)
  if [ "$code" = "0" ]; then
    echo "$resp" | python3 -c "
import sys,json
for a in json.load(sys.stdin).get('data',{}).get('attendees',[]):
    print(f'  ✅ {a[\"display_name\"]} rsvp={a[\"rsvp_status\"]}')
"
  else
    echo "❌ Add attendees failed: $(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('msg',''))" 2>/dev/null)"
  fi
}

# ── chat list ────────────────────────────────────────

cmd_chat_list() {
  api GET "${DOMAIN}/open-apis/im/v1/chats" "" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for c in d.get('data',{}).get('items',[]):
    print(f'{c[\"chat_id\"]} | {c.get(\"name\",\"(no name)\")} | {c.get(\"chat_type\",\"?\")} | members_visible={c.get(\"show_member_count\",\"?\")}')
"
}

# ── members ──────────────────────────────────────────

cmd_members() {
  local chat=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --chat) chat="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -z "$chat" ] && { echo "Usage: members --chat <chat_id>"; exit 1; }

  api GET "${DOMAIN}/open-apis/im/v1/chats/${chat}/members" "" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for m in d.get('data',{}).get('items',[]):
    print(f'{m.get(\"member_id\",\"?\")} | {m.get(\"name\",\"?\")} | {m.get(\"member_id_type\",\"?\")}')
"
}

# ── dispatch ─────────────────────────────────────────

case "${1:-}" in
  send)      shift; cmd_send "$@" ;;
  meeting)   shift; cmd_meeting "$@" ;;
  chat-list) shift; cmd_chat_list "$@" ;;
  members)   shift; cmd_members "$@" ;;
  *)
    echo "Usage: feishu.sh {send|meeting|chat-list|members} [options]"
    echo ""
    echo "  send       --to <open_id> | --chat <chat_id> --text <message>"
    echo "  meeting    --summary <title> --start <YYYY-MM-DD HH:MM> --end <YYYY-MM-DD HH:MM> --attendees <id1,id2,...> [--desc <desc>]"
    echo "  chat-list  List available chats"
    echo "  members    --chat <chat_id>"
    exit 1
    ;;
esac
