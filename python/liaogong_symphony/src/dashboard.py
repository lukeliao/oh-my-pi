"""Simple server-rendered dashboard for liaogong-symphony."""

from __future__ import annotations

import html
from collections import Counter
from collections.abc import Iterable
from datetime import UTC, datetime

from .db import WorkerRow, WorkItemRecord


def render_dashboard(*, records: Iterable[WorkItemRecord], workers: Iterable[WorkerRow]) -> str:
    items = list(records)
    worker_rows = list(workers)
    counts = Counter(record.work_item.state for record in items)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    item_rows = (
        "\n".join(_render_item_row(record) for record in items) or '<tr><td colspan="8">No work items.</td></tr>'
    )
    workers_html = (
        "\n".join(_render_worker_row(worker) for worker in worker_rows) or '<tr><td colspan="6">No workers.</td></tr>'
    )
    return f"""<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\" />
    <title>liaogong-symphony</title>
    <style>
      body {{ font-family: system-ui, sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; }}
      h1, h2 {{ margin-bottom: 8px; }}
      .summary {{ display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }}
      .card {{ background: #111827; border: 1px solid #334155; border-radius: 8px; padding: 12px; }}
      table {{ width: 100%; border-collapse: collapse; margin-bottom: 24px; }}
      th, td {{ border: 1px solid #334155; padding: 8px; text-align: left; vertical-align: top; }}
      th {{ background: #1e293b; }}
      code {{ color: #bfdbfe; }}
      a {{ color: #93c5fd; }}
      .muted {{ color: #94a3b8; }}
    </style>
  </head>
  <body>
    <h1>liaogong-symphony</h1>
    <p class=\"muted\">Generated at {html.escape(now)}.</p>
    <section class=\"summary\">
      <div class=\"card\"><strong>queued</strong><div>{counts.get("queued", 0)}</div></div>
      <div class=\"card\"><strong>running</strong><div>{counts.get("running", 0) + counts.get("leased", 0)}</div></div>
      <div class=\"card\"><strong>blocked</strong><div>{counts.get("blocked", 0)}</div></div>
      <div class=\"card\"><strong>failed</strong><div>{counts.get("failed", 0)}</div></div>
      <div class=\"card\"><strong>succeeded</strong><div>{counts.get("succeeded", 0)}</div></div>
      <div class=\"card\"><strong>workers</strong><div>{len(worker_rows)}</div></div>
    </section>

    <h2>Workers</h2>
    <table>
      <thead>
        <tr>
          <th>worker</th><th>state</th><th>labels</th><th>capacity</th><th>running</th><th>last_seen</th>
        </tr>
      </thead>
      <tbody>{workers_html}</tbody>
    </table>

    <h2>Work items</h2>
    <table>
      <thead>
        <tr>
          <th>identifier</th><th>state</th><th>attempt</th><th>lease expiry</th><th>workspace / session</th><th>last event</th><th>error / blocked / retry</th><th>ops</th>
        </tr>
      </thead>
      <tbody>{item_rows}</tbody>
    </table>
  </body>
</html>
"""


def _render_worker_row(worker: WorkerRow) -> str:
    return (
        f"<tr><td>{html.escape(worker.worker_id)}</td>"
        f"<td>{html.escape(worker.state)}</td>"
        f"<td>{html.escape(', '.join(worker.labels))}</td>"
        f"<td>{worker.capacity}</td>"
        f"<td>{worker.running_count}</td>"
        f"<td><code>{html.escape(worker.last_seen_at)}</code></td></tr>"
    )


def _render_item_row(record: WorkItemRecord) -> str:
    work_item = record.work_item
    attempt = record.latest_attempt
    active_lease = record.active_lease
    last_event = record.last_event
    workspace_bits = []
    if attempt is not None and attempt.workspace_path:
        workspace_bits.append(f"repo: <code>{html.escape(attempt.workspace_path)}</code>")
    if attempt is not None and attempt.session_dir:
        workspace_bits.append(f"session: <code>{html.escape(attempt.session_dir)}</code>")
    if attempt is not None and attempt.omp_session_file:
        workspace_bits.append(f"jsonl: <code>{html.escape(attempt.omp_session_file)}</code>")
    last_event_text = "-"
    if last_event is not None:
        last_event_text = f'{html.escape(last_event.event_type)}<br><span class="muted"><code>{html.escape(last_event.ts)}</code></span>'
    detail_bits = []
    if work_item.retry_due_at:
        detail_bits.append(f"retry_due_at=<code>{html.escape(work_item.retry_due_at)}</code>")
    if work_item.blocked_reason:
        detail_bits.append(f"blocked_reason={html.escape(work_item.blocked_reason)}")
    if attempt is not None and attempt.error:
        detail_bits.append(f"error={html.escape(attempt.error)}")
    attempt_text = "-"
    if attempt is not None:
        attempt_text = f"#{attempt.attempt_no} {html.escape(attempt.state)}"
    lease_text = html.escape(active_lease.expires_at) if active_lease is not None else "-"
    ops = (
        f'<a href="/api/v1/work-items/{html.escape(work_item.identifier)}">show</a><br>'
        f'<span class="muted">POST /api/v1/work-items/{html.escape(work_item.identifier)}/cancel</span><br>'
        f'<span class="muted">POST /api/v1/work-items/{html.escape(work_item.identifier)}/retry</span>'
    )
    return (
        f"<tr><td>{html.escape(work_item.identifier)}</td>"
        f"<td>{html.escape(work_item.state)}</td>"
        f"<td>{attempt_text}</td>"
        f"<td><code>{lease_text}</code></td>"
        f"<td>{'<br>'.join(workspace_bits) or '-'}</td>"
        f"<td>{last_event_text}</td>"
        f"<td>{'<br>'.join(detail_bits) or '-'}</td>"
        f"<td>{ops}</td></tr>"
    )


__all__ = ["render_dashboard"]
