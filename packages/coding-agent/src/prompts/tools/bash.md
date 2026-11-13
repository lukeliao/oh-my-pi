Persistent bash 5.3.
cwd will reset after each turn, don't rely on cd; `pty` = interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
In-process builtins, ahead of PATH: {{join builtins ", "}}.
{{#if asyncEnabled}}
`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.
{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
Blocked in bash when the command itself is that command (use the owning tool): `cat`/`head`/`tail`/`less`/`more` → `read`; `grep`/`rg`/`ag` → `grep`; `find`/`fd` → `glob`; `sed -i`/`perl -i`/`awk -i inplace` → `edit`; `echo >file`/`printf >file` → `write`. Nudges do not fire inside a compound line; refusal rules block the whole line on any matching segment.
{{#if hasLaunch}}
Long-lived services:
- unique name; ready requires name; no async/timeout; pty defaults true.
- ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.
{{/if}}
{{#if autoBackgroundEnabled}}
Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout`.
No backgrounding when the client terminal runs the command or the job cap is reached.
The result arrives automatically as a follow-up message. NEVER poll.
{{/if}}
