---
name: code-intelligence
description: How to use semble (lightweight file-level tools) and codebase-memory-mcp (deep graph-level MCP tools) together for efficient code exploration. Shows which tool to use first for each task.
---

# Code Intelligence Strategy: semble + codebase-memory-mcp

You have TWO tool families for understanding code. Use the right one first.

## Tool Families

| Family | Scope | Speed | Strengths |
|---|---|---|---|
| **semble** (8 tools) | File/directory level | Instant, no index needed | Tree, digest, fast semantic search, import graphs |
| **codebase-memory** (14 MCP tools) | Symbol/graph level | Requires 1-time index (ms) | Architecture, call traces, dead code, Cypher queries |

## Decision Rules

### 1. Explore project structure
```
FIRST:  semble_tree (no index, instant)
THEN:   CBM get_architecture (if you need deeper architecture summary)
```

### 2. Semantic search (find by meaning, not text)
```
FIRST:  semble_search (fast file-level results)
DEEP:   CBM semantic_query or search_graph (symbol-level, project-wide)
```
semble_search is lighter and returns file-level results instantly. Use CBM search when you need function/class-level matches or need to search by label (Function, Class, Route).

### 3. Dependency analysis
```
FILE-LEVEL:  semble_deps → what files does X import?
SYMBOL-LEVEL: CBM trace_call_path → who calls function X? What does X call?
```
semble_deps is fast for file-level imports. CBM trace_call_path shows function call chains with direction (inbound/outbound).

### 4. Impact analysis (what breaks if I change X?)
```
QUICK:  semble_impact → which files import X? (fast import graph)
DEEP:   CBM query_graph + trace_call_path → which symbols depend on X?
        CBM detect_changes → what does my git diff affect?
```
semble_impact for initial blast radius. CBM for symbol-level call chain impact. CBM detect_changes for uncommitted change analysis.

### 5. Pattern / structure search
```
AST PATTERNS:  semble_find_pattern (ast-grep, compact output)
GRAPH PATTERNS: CBM search_graph (by name/label/degree) or query_graph (Cypher)
```
semble_find_pattern for "find all functions matching this signature". CBM for "find all classes with >10 callers" or Cypher traversal.

### 6. Find similar code
```
SEMANTIC SIMILARITY:  semble_find_related (chunk-level)
DUPLICATE DETECTION:  CBM SIMILAR_TO edges or semantic_query
```

### 7. CBM-only capabilities (no sembre equivalent)
- **get_architecture** — project-wide architecture summary with layers, clusters, entry points
- **trace_call_path** — function call chain tracing (inbound/outbound)
- **query_graph** — Cypher-like graph traversal (MATCH ... RETURN ...)
- **detect_changes** — git diff → affected symbols with risk classification
- **dead code detection** — functions with zero callers
- **manage_adr** — persist architecture decisions
- **get_code_snippet** — fetch function body by symbol name

### 8. semble-only capabilities (no CBM equivalent)
- **semble_digest** — compress build/test/CI output
- **semble_encode** — Model2Vec embedding vector computation

## Workflow: first visit to a project

```
1. semble_tree        → understand directory layout (< 1s, no index)
2. semble_deps        → check key file imports (if needed)
3. [CBM auto-indexes in background, < 1s for most repos]
4. CBM get_architecture → deep architecture summary
5. CBM search_graph   → explore symbols as needed
```

## Anti-patterns

- Do NOT use CBM query_graph for simple "what imports X" — use semble_impact (faster, zero index cost).
- Do NOT use CBM semantic_query for "find files about topic" — use semble_search first.
- Do NOT skip semble_tree in favor of get_architecture — tree is instant, architecture requires index.
- Do NOT use CBM trace_call_path before checking semble_deps — file-level imports are often enough.
