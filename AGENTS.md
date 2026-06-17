# Repository Guidelines

## Project Overview

Oh My Pi (`omp`) is a CLI coding agent that uses LLMs to read, write, edit, search, and execute code within your workspace. It provides an interactive terminal UI with tool-calling, multi-provider model support, LSP integration, MCP servers, subagent orchestration, and a Python RPC protocol for programmatic control.

The repository is a **Bun + Rust monorepo** with a `packages/coding-agent/` TypeScript CLI at its core, backed by a Rust native addon (`crates/pi-natives/`) for performance-critical operations. Python packages in `python/` consume the CLI via its RPC mode.

## Architecture & Data Flow

```
User Input → CLI (cli.ts) → main.ts → AgentSession
  → Agent (pi-agent-core) wraps state
    → agentLoop() converts messages → calls pi-ai streamSimple()
      → pi-ai dispatches to provider (Anthropic/OpenAI/Google/…)
        → streaming events
          → agent-loop processes tool calls → tool execution
            → results fed back as toolResult → loop repeats
```

### Package Dependency Hierarchy

```
@oh-my-pi/pi-ai          Leaf — LLM providers, streaming, model resolution, auth
@oh-my-pi/pi-agent-core  Depends on pi-ai, pi-natives, pi-utils — Agent class, loop, compaction
@oh-my-pi/pi-coding-agent  Top-level — depends on everything; contains tools, TUI, CLI, MCP, LSP, sessions
@oh-my-pi/pi-tui          Terminal UI engine — standalone
@oh-my-pi/pi-natives      JS wrappers → Rust .node binary — compute-heavy ops
@oh-my-pi/pi-utils        Shared utilities — logger, dirs, streams, temp files
@oh-my-pi/pi-stats        Observability dashboard — standalone consumer
```

### Key Runtime Patterns

- **Event-driven**: `AgentSession` subscribes to `AgentEvent` stream from `agentLoop()`. Streams use `EventStream<T, TResult>` — push-based, async-iterable, with `.result()` for terminal value.
- **Tool pattern**: Each tool is a class with `static name`, `description`, `parameters` (Zod schema), and `async execute(input, context)`. Tools are instantiated with constructor-injected dependencies. Registered via `createTools()`.
- **State management**: Plain object mutation + event emission. No Redux/MobX. `Agent` wraps mutable `AgentState` with getters/setters. `AgentSession` extends with persistence hooks.
- **Constructor DI**: Dependencies injected via constructor. Config objects flow through plain interfaces. No DI container.

## Key Directories

### TypeScript Packages

| Directory | Package | Purpose |
|---|---|---|
| `packages/coding-agent/src/` | `@oh-my-pi/pi-coding-agent` | CLI app, tools, TUI mode, sessions, LSP, MCP, subagents, SDK |
| `packages/ai/src/` | `@oh-my-pi/pi-ai` | LLM providers (50+), streaming, model resolution, auth, token usage |
| `packages/agent/src/` | `@oh-my-pi/pi-agent-core` | Agent state machine, loop, compaction, telemetry, leak detection |
| `packages/tui/src/` | `@oh-my-pi/pi-tui` | Differential terminal rendering, component tree, keyboard handling |
| `packages/utils/src/` | `@oh-my-pi/pi-utils` | Logger, directory resolution, streams, temp files, glob, which |
| `packages/natives/src/` | `@oh-my-pi/pi-natives` | JS loader → Rust native addon (text, search, syntax, keyboard, isolation) |
| `packages/stats/src/` | `@oh-my-pi/pi-stats` | Session usage stats: SQLite, worker pool, React dashboard, Bun HTTP server |

### Rust Crates

| Directory | Purpose |
|---|---|
| `crates/pi-natives/` | Shim layer; core logic in sibling crates (`pi-ast`, `pi-iso`, `pi-shell`, `pi-search`) |
| Key modules: `grep.rs` (ripgrep), `text.rs` (ANSI-aware measurement), `ast.rs` (ast-grep), `keys.rs` (kitty protocol), `tokens.rs` (tiktoken), `highlight.rs` (syntect) |

### Python Packages

| Directory | Purpose |
|---|---|
| `python/omp-rpc/` | Typed Python client for `omp --mode rpc`. Zero runtime deps. Imported by robomp and liaogong-symphony. |
| `python/robomp/` | Self-hosted GitHub triage/fix bot. FastAPI + omp-rpc + SQLite + Docker. |
| `python/liaogong_symphony/` | Unattended work conductor. FastAPI + omp-rpc + SQLite + pull-based worker leases. |

### Other

| Directory | Purpose |
|---|---|
| `scripts/` | Build infra (`ci-build-native.ts`), release scripts, dev utilities, session-stats Python scripts |
| `docs/` | Markdown docs: tools reference, TUI internals, session, skills, models, SSH |
| `.omp/` | Local harness state (rules, skills, tools, commands) |

## Development Commands

All commands run from the repo root.

### Install

```bash
bun install --frozen-lockfile
```

### Build

```bash
bun run build              # workspace build (--if-present)
bun run build_native       # Rust native addon only
```

### Type Check

```bash
bun run check              # parallel: ts + rs
bun run check:ts           # Biome + per-package bun check
bun run check:rs           # cargo fmt --check + clippy -D warnings
```

Never use `tsc`/`npx tsc` — always `bun check`.

### Test

```bash
bun run test               # parallel: ts + rs + py
bun run test:ts            # bun test --only-failures
bun run test:rs            # cargo nextest (not cargo test)
bun run test:py            # pytest for all Python packages
```

### Lint & Format

```bash
bun run lint               # biome lint + cargo clippy
bun run lint:py            # ruff check + ruff format
bun run fmt                # biome format --write + cargo fmt
bun run fix                # auto-fix ts + rs
```

### Specific scopes

```bash
bun --cwd=packages/ai run test          # run one package's tests
bun --cwd=packages/coding-agent run check  # typecheck one package
cargo test -p pi-natives                 # run Rust tests only
```

### Python packages

```bash
bun run robomp:install            # pip install -e 'python/robomp[dev]'
bun run liaogong:install          # pip install -e 'python/liaogong_symphony[dev]'
bun run robomp:serve              # start robomp server
bun run liaogong:serve            # start symphony conductor + local worker
```

## Code Conventions & Common Patterns

### TypeScript

- **Runtime**: Bun 1.3.14. Use Bun APIs (`Bun.file()`, `Bun.write()`, `$` shell) over Node alternatives.
- **Target**: ES2024, ESNext modules, Bundler resolution, strict mode, `verbatimModuleSyntax`.
- **Formatting/Linting**: Biome 2.4.16 (primary), Prettier 3.8.3. No ESLint.
- **No `any`** unless absolutely necessary. Never `ReturnType<>`. Never inline `import()`.
- **Barrel exports**: `export * from "./module"` — even for single specifiers.
- **Class privacy**: ES `#private` fields. No `private`/`public` keywords on fields, except constructor parameter properties.
- **Async**: `Promise.withResolvers()` over `new Promise(...)`.
- **Prompts**: Static `.md` files with Handlebars. Import via `import content from "./prompt.md" with { type: "text" }`. Never inline.
- **Logging**: Centralized Winston logger (`import { logger } from "@oh-my-pi/pi-utils"`). Never `console.log` in coding-agent — it corrupts TUI rendering.
- **Worker scripts**: Use the dev/compile-safe hybrid pattern (`isCompiledBinary()` check). Never `with { type: "file" }`. Must be listed in `packages/coding-agent/scripts/build-binary.ts`.
- **Node imports**: Namespace imports (`import * as fs from "node:fs/promises"`).
- **File I/O**: Prefer `Bun.file()`, `Bun.write()` for reads/writes. `node:fs/promises` for directory ops. Use `try/catch` + `isEnoent()`; never existence-check-then-read.
- **Process execution**: Bun Shell (`` $`cmd` ``) for simple commands. `Bun.spawn()` for streaming/interactive. `$which()` from `@oh-my-pi/pi-utils` for binary lookup.
- **TUI sanitization**: All displayed text must be tab-replaced (`replaceTabs()`), truncated (`truncateToWidth()`), and path-shortened (`shortenPath()`).

### Rust

- **Edition**: 2024, resolver 3, nightly-2026-04-29 toolchain.
- **Binding pattern**: `#[napi]` macros → `.node` binary → JS platform-aware loader. Async work via `AsyncTask` on libuv thread pool. Cached state in `LazyLock` globals.
- **Formatting/Linting**: `cargo fmt` + `cargo clippy -D warnings`.
- **Testing**: `cargo nextest run --workspace` (not `cargo test`).
- **Key deps**: napi-rs v3, tokio, tree-sitter (40+ grammars), syntect, ripgrep crate family, tiktoken-rs, portable-pty.

### Python

- **Build**: setuptools via pyproject.toml.
- **Type hints**: `py.typed` marker for PEP 561 compliance.
- **Config**: `pydantic-settings BaseSettings` with env prefix per package.
- **CLI**: Click with `serve`/`worker`/`status` subcommands.
- **Formatting/Linting**: Ruff (line-length 120, double quotes).
- **Testing**: `pytest` with `asyncio_mode=auto`. Integration tests gated behind env flags (`ROBOMP_INTEGRATION=1`, `LIAOGONG_SYMPHONY_INTEGRATION=1`).
- **State**: WAL-mode SQLite via stdlib `sqlite3`.
- **HTTP**: FastAPI + uvicorn for server surfaces.

### Cross-cutting

- **Models config**: `packages/ai/src/models.json` is generated — never edit directly. Regenerate with `bun --cwd=packages/ai run generate-models`.
- **Changelog**: Per-package `CHANGELOG.md` under `## [Unreleased]`. Released sections are immutable.
- **Releasing**: `bun run release` handles version bump, changelog finalization, commit, tag, publish.

## Important Files

### Entry Points

| File | Purpose |
|---|---|
| `packages/coding-agent/src/cli.ts` | CLI entry — subcommand registration, smoke tests |
| `packages/coding-agent/src/main.ts` | Bootstrap — session creation, mode selection, LSP/MCP init |
| `packages/coding-agent/src/sdk.ts` | Public SDK for programmatic usage |
| `packages/coding-agent/src/index.ts` | Package barrel export |
| `packages/agent/src/agent.ts` | `Agent` class (1276 lines) — core state machine |
| `packages/agent/src/agent-loop.ts` | `agentLoop()` (1491 lines) — LLM interaction orchestration |
| `packages/ai/src/stream.ts` | `streamSimple()` (1100 lines) — central provider dispatch |
| `packages/ai/src/types.ts` | Core AI types — `Model`, `Message`, `Context`, `StreamOptions` |
| `python/omp-rpc/src/omp_rpc/client.py` | `RpcClient` (1797 lines) — Python RPC driver |
| `python/robomp/src/server.py` | FastAPI GitHub webhook receiver |

### Key Large Files

| File | Lines | Role |
|---|---|---|
| `packages/coding-agent/src/session/agent-session.ts` | 9863 | Central session orchestrator |
| `packages/coding-agent/src/session/session-manager.ts` | ~118K | Session lifecycle |
| `packages/coding-agent/src/modes/interactive-mode.ts` | ~113K | Interactive TUI mode |
| `packages/coding-agent/src/config/settings-schema.ts` | ~101K | Settings schema |
| `packages/coding-agent/src/tools/gh.ts` | ~106K | GitHub tools |
| `packages/coding-agent/src/tools/read.ts` | ~92K | File reading tool |
| `packages/coding-agent/src/task/Executor.ts` | ~58K | Subagent executor |
| `packages/coding-agent/src/mcp/Manager.ts` | ~42K | MCP server lifecycle |
| `packages/coding-agent/src/lsp/index.ts` | ~79K | LSP client library |
| `packages/ai/src/auth-storage.ts` | ~181K | Credential/auth storage |
| `packages/ai/src/provider-models/openai-compat.ts` | ~100K | Model catalog |

### Config Files

| File | Purpose |
|---|---|
| `package.json` | Workspace root — scripts, workspaces, catalog deps |
| `tsconfig.base.json` | Shared TS config (ES2024, Bundler, strict) |
| `packages/tsconfig.workspace.json` | Packages-wide TS config |
| `tsconfig.tools.json` | Scripts + natives helper config |
| `Cargo.toml` | Rust workspace (edition 2024, resolver 3) |
| `bun.lock` | Lockfile (bun) |

## Runtime & Tooling Preferences

- **Runtime**: Bun 1.3.14. Node.js only used in CI for npm publishing.
- **Package manager**: Bun (not pnpm/npm/yarn). `bun.lock` lockfile.
- **TypeScript checker**: `bun check` (not `tsc`).
- **TS formatter/linter**: Biome, not ESLint.
- **Rust tester**: `cargo nextest`, not `cargo test`.
- **Binary compilation**: `bun build --compile` via `scripts/ci-release-build-binaries.ts`.
- **Cross-compile**: Zig 0.16.0 for native binary builds.
- **CI**: GitHub Actions, ubuntu-22.04 (primary), macos-14, macos-15-intel, ubuntu-24.04-arm.
- **Docker**: Python packages extend `oh-my-pi/pi:dev` base image.

## Testing & QA

### Running tests

```bash
bun run test              # Full suite (ts + rs + py)
bun run test:ts           # TypeScript only (bun test)
bun run test:rs           # Rust only (cargo nextest)
bun run test:py           # Python only (pytest)
```

### Frameworks

| Language | Framework | Location Convention |
|---|---|---|
| TypeScript | `bun test` | `packages/*/__tests__/` or `*.test.ts` |
| Rust | `cargo nextest` | Inline `#[cfg(test)] mod tests` or `crates/*/tests/` |
| Python | `pytest` + `pytest-asyncio` | `python/*/tests/` |

### Code quality checks

```bash
bun run check             # Full typecheck (ts + rs)
bun run lint              # Full lint (ts + rs)
bun run fix               # Auto-fix (ts + rs)
```

### Smoke test

```bash
bun packages/coding-agent/src/cli.ts --smoke-test
```

Validates binary can spawn the stats sync worker and ping it. Run after worker changes.

### Key conventions

- Never suppress tests to make code pass.
- Prefer contract-level tests over implementation details.
- Never `mock.module()` — leaks across files in Bun (issue #12823). Use `vi.spyOn()`.
- Python integration tests are gated behind env flags.
- Tests must be full-suite safe — no file-wide mutations of `Bun.*`, `process.env`, or `process.platform`.

### CI pipeline (release)

```
gate → rust-hash → check + native_linux + native_release
  → test + install_methods → release_binary → release-github → release_github_verify → release-npm
```
