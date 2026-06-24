# liaogong-symphony

`liaogong-symphony` is an OMP-based unattended conductor that adds Symphony-style scheduling, deterministic workspaces, retry/reconciliation, observability, and pull-based multi-host execution around `omp --mode rpc`.

## Current v1 scope

- manual queue intake only
- deterministic workspace/session allocation per work item
- durable SQLite-backed work items, attempts, leases, workers, and events
- local embedded worker or remote pull workers
- repo-owned `WORKFLOW.md` overlay for queue/workspace/OMP/worker policy
- FastAPI operator surface and simple dashboard

## Run locally

```bash
pip install -e 'python/liaogong_symphony[dev]'
python3 -m liaogong_symphony serve --with-local-worker
```
