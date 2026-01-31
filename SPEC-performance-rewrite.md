# Performance Rewrite Spec

## Goal
Blazing fast desktop app where the only latency is the Codex AI layer.

## Stack

| Layer | Current | Target |
|-------|---------|--------|
| Shell | Tauri | **Tauri** (10x smaller, 2-3x less memory) |
| Frontend | React + Vite | **Solid.js + Vite** (no VDOM, surgical updates) |
| Daemon | Bun + Hono | **Bun + Hono** (keep as sidecar) |
| Hot paths | TypeScript | **Rust** (via Tauri commands) |

## Architecture

```
┌─────────────────────────────────────────────┐
│  Tauri Shell (Rust)                         │
│  - Window management, native menus          │
│  - IPC bridge to frontend                   │
│  - Rust commands for hot paths              │
├─────────────────────────────────────────────┤
│  Solid.js Frontend (Webview)                │
│  - Virtualized thread rendering             │
│  - Fine-grained reactivity (no diffing)     │
│  - Token streaming to single DOM nodes      │
├─────────────────────────────────────────────┤
│  Bun Daemon (forksd) — sidecar process      │
│  - MCP orchestration                        │
│  - WebSocket/HTTP APIs                      │
│  - PTY management                           │
│  - Codex integration                        │
├─────────────────────────────────────────────┤
│  Rust Native Modules (Tauri commands)       │
│  - Git ops (git2 crate)                     │
│  - Diff computation (similar crate)         │
│  - File watching (notify crate)             │
│  - Syntax highlighting (tree-sitter)        │
└─────────────────────────────────────────────┘
```

## Why This Stack

### Why Tauri
- ~10MB base binary size
- Uses the system webview (WKWebView on macOS)
- Lower memory footprint
- Rust backend for free

### Solid.js over React
- No virtual DOM = no diffing overhead
- Fine-grained reactivity: update exactly what changed
- Streaming AI tokens → update single text node, not re-render tree
- Same JSX mental model, easy transition

### Virtualized Threads
- 1000 messages → only ~20 DOM nodes exist
- Scroll swaps content, no mount/unmount
- Libraries: `@tanstack/virtual` or `solid-virtual`

### Rust for Hot Paths
- Git operations: `git2` (libgit2 bindings) vs shelling out
- Diff computation: `similar` crate, native speed for O(n²) algo
- File watching: `notify` crate, efficient
- Called directly from frontend via `invoke()`

## Migration Path

### Phase 1: New Frontend Shell
- Tauri + Solid.js app
- Keep forksd unchanged, spawn as sidecar
- **Win**: Fast thread rendering, smaller binary

### Phase 2: Rust Hot Paths
- Move git, diff, file watching to Tauri commands
- Frontend calls Rust directly
- **Win**: Native speed for heavy operations

### Phase 3: Evaluate Daemon
- Profile forksd for bottlenecks
- Migrate to Rust only if Bun is limiting
- **Likely unnecessary** — orchestration isn't CPU-bound

## Thread Performance Target

```
Thread open: < 50ms to interactive (virtualized)
Token stream: < 1ms per token render (single node update)
Scroll: 60fps (content swap, no re-render)
Memory: < 200MB for large threads
```

## Key Dependencies

```toml
# Rust (Cargo.toml)
tauri = "2"
git2 = "0.18"
similar = "2"
notify = "6"
tree-sitter = "0.22"
```

```json
// package.json (frontend)
"solid-js": "^1.8",
"@tanstack/solid-virtual": "^3",
"@tauri-apps/api": "^2"
```

## Open Questions

- [ ] Daemon IPC: Unix socket vs localhost HTTP? (socket slightly faster)
- [ ] State management: Solid stores vs separate state lib?
- [ ] Syntax highlighting: client-side tree-sitter vs pre-highlighted from daemon?

## Platform

macOS only (for now). Simplifies webview testing, can use native APIs.
