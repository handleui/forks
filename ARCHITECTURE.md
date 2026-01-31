# Forks Architecture

## Overview

A local desktop application for AI-powered code development with parallel agent execution, git worktree isolation, and approval workflows. The system runs entirely on localhost - the Tauri app communicates with a Node daemon (forksd) that orchestrates AI agents via Codex (OpenAI CLI).

**Core Value:** Multi-agent orchestration + Git worktree isolation + Human-in-the-loop approvals

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           USER'S MACHINE (localhost)                             │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                     DESKTOP APP (apps/desktop)                            │   │
│  │                         Tauri + Vite                                     │   │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐       │   │
│  │  │    Rust Core    │    │    Webview      │    │   WebSocket     │       │   │
│  │  │  - spawn forksd │    │  (Vite/Solid)   │    │     Client      │       │   │
│  │  │  - auth tokens  │    │   - UI shell    │    │ (@forks-sh/     │       │   │
│  │  │  - commands     │    │   - PTY views   │    │   ws-client)    │       │   │
│  │  └────────┬────────┘    └─────────────────┘    └────────┬────────┘       │   │
│  └───────────┼────────────────────────────────────────────┼─────────────────┘   │
│              │ spawns                                      │                     │
│              ▼                                             │                     │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                       FORKSD DAEMON (apps/forksd)                         │   │
│  │               Node.js + Hono + WebSocket + MCP + node-pty                 │   │
│  │                                                                           │   │
│  │  ┌─────────────────────────────────────────────────────────────────────┐ │   │
│  │  │                         HTTP API (Hono)                              │ │   │
│  │  │  /health          /codex/*           /pty/*          /approval/*    │ │   │
│  │  │  /projects/*      /workspaces/*      /chats/*        /plans/*       │ │   │
│  │  └─────────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                           │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │  MCP Server  │  │  WebSocket   │  │ PTY Manager  │  │   Runner     │  │   │
│  │  │  - attempts  │  │  - events    │  │  - shells    │◄─│ - subagents  │  │   │
│  │  │  - subagents │  │  - PTY I/O   │  │  - history   │  │ - attempts   │  │   │
│  │  │  - plans     │  │  - approvals │  │  - resize    │  │ - approvals  │  │   │
│  │  │  - tasks     │  │  - Codex evt │  │  - node-pty  │  │ - concurrency│  │   │
│  │  │  - graphite  │  └──────────────┘  └──────────────┘  └──────┬───────┘  │   │
│  │  │  - terminals │                                             │          │   │
│  │  └──────────────┘         ┌───────────────────────────────────┘          │   │
│  │                           ▼                                              │   │
│  │  ┌──────────────────────────────────────────────────────────────────┐    │   │
│  │  │                    Codex Manager                                  │    │   │
│  │  │  ┌────────────────────────────────────────────────────────────┐  │    │   │
│  │  │  │              CodexAdapter (@forks-sh/codex)                 │  │    │   │
│  │  │  │  - thread management      - approval callbacks              │  │    │   │
│  │  │  │  - turn execution         - event streaming                 │  │    │   │
│  │  │  └───────────────────────────────┬────────────────────────────┘  │    │   │
│  │  │                                  │ JSON-RPC (stdin/stdout)       │    │   │
│  │  │                                  ▼                               │    │   │
│  │  │  ┌────────────────────────────────────────────────────────────┐  │    │   │
│  │  │  │              Codex Binary (@openai/codex)                   │  │    │   │
│  │  │  └────────────────────────────────────────────────────────────┘  │    │   │
│  │  └──────────────────────────────────────────────────────────────────┘    │   │
│  │                                                                           │   │
│  │  ┌──────────────────────────────────────────────────────────────────┐    │   │
│  │  │                    Store (@forks-sh/store)                        │    │   │
│  │  │                     SQLite + better-sqlite3                       │    │   │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │    │   │
│  │  │  │ projects │ │workspaces│ │  chats   │ │ attempts │             │    │   │
│  │  │  ├──────────┤ ├──────────┤ ├──────────┤ ├──────────┤             │    │   │
│  │  │  │subagents │ │  tasks   │ │  plans   │ │questions │             │    │   │
│  │  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘             │    │   │
│  │  └──────────────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ~/.forksd/                                                                      │
│  ├── forksd.db               # SQLite database                                   │
│  └── forksd.auth             # Encrypted auth token (OS keychain)                │
│                                                                                  │
│  <project>/.forks/           # Git worktrees for parallel attempts               │
│  └── attempt-<uuid>/         # Isolated worktree per attempt                     │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ Codex uses OpenAI API
                                       ▼
                    ┌──────────────────────────────────────┐
                    │           EXTERNAL SERVICES           │
                    │  ┌─────────────┐  ┌────────────────┐ │
                    │  │   OpenAI    │  │    Graphite    │ │
                    │  │     API     │  │  (gt CLI)      │ │
                    │  └─────────────┘  └────────────────┘ │
                    └──────────────────────────────────────┘
```

---

## Data Flow: Agent Execution

```
  User sends prompt
        │
        ▼
┌───────────────┐    MCP tool call     ┌──────────────────┐
│   Desktop UI  │ ──────────────────►  │   forksd MCP     │
│               │    subagent_spawn    │     Server       │
└───────────────┘                      └────────┬─────────┘
                                                │
                                                ▼
                                       ┌──────────────────┐
                                       │      Store       │
                                       │ createSubagent() │
                                       └────────┬─────────┘
                                                │
                                                ▼
                                       ┌──────────────────┐
                                       │     Runner       │
                                       │ executeSubagent()│
                                       └────────┬─────────┘
                                                │
                       ┌────────────────────────┼────────────────────────┐
                       ▼                        ▼                        ▼
              ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
              │ Reserve slot   │      │ adapter.start  │      │ adapter.send   │
              │ (concurrency)  │      │   Thread()     │      │    Turn()      │
              └────────────────┘      └────────────────┘      └────────┬───────┘
                                                                       │
                                                                       ▼
                                                              ┌────────────────┐
                                                              │ Codex process  │
                                                              │ (AI reasoning) │
                                                              └────────┬───────┘
                                                                       │
                            ┌──────────────────────────────────────────┤
                            ▼                                          ▼
                   ┌────────────────┐                        ┌────────────────┐
                   │ Approval       │                        │ Message delta  │
                   │ Request Event  │                        │ events stream  │
                   └────────┬───────┘                        └────────────────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ User approves/ │
                   │ declines via UI│
                   └────────┬───────┘
                            │
                            ▼
                   ┌────────────────┐
                   │ Runner resumes │
                   │ Codex continues│
                   └────────────────┘
```

---

## Data Flow: Parallel Attempts

```
  User triggers attempt_spawn(count=3)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                             FORKSD DAEMON                                  │
│                                                                            │
│   ┌──────────────────────────────────────────────────────────────────┐    │
│   │                    Runner.executeAttemptBatch()                   │    │
│   │                                                                   │    │
│   │   1. Reserve slots (MAX_CONCURRENT_PER_CHAT = 10)                │    │
│   │   2. For each attempt in parallel:                               │    │
│   │      a. Create git worktree: .forks/attempt-<uuid>/              │    │
│   │      b. Fork parent Codex thread                                 │    │
│   │      c. Execute turn with task prompt                            │    │
│   └──────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│   ┌────────────┐    ┌────────────┐    ┌────────────┐                     │
│   │ Attempt 1  │    │ Attempt 2  │    │ Attempt 3  │                     │
│   │ worktree/  │    │ worktree/  │    │ worktree/  │                     │
│   │ branch-1   │    │ branch-2   │    │ branch-3   │                     │
│   │  ┌──────┐  │    │  ┌──────┐  │    │  ┌──────┐  │                     │
│   │  │Codex │  │    │  │Codex │  │    │  │Codex │  │                     │
│   │  │thread│  │    │  │thread│  │    │  │thread│  │                     │
│   │  └──────┘  │    │  └──────┘  │    │  └──────┘  │                     │
│   └────────────┘    └────────────┘    └────────────┘                     │
│         │                 │                 │                             │
│         ▼                 ▼                 ▼                             │
│   Each attempt completes independently with result + unifiedDiff         │
│                                                                            │
│   User picks winner via attempt_pick(attemptId)                           │
│   → git reset --hard <winner-branch>, mark siblings discarded             │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
forks/
├── apps/
│   ├── desktop/                        # Tauri desktop app
│   │   ├── src/main.ts                 # Entry: spawns forksd, manages auth
│   │   └── vite.config.ts              # Vite config (renderer)
│   │
│   ├── forksd/                         # Node daemon (heart of the system)
│   │   └── src/
│   │       ├── index.ts                # Entry: Hono, WebSocket, all routes
│   │       ├── mcp.ts                  # MCP server router
│   │       ├── mcp/tools.ts            # Core MCP tool handlers (1500+ lines)
│   │       ├── codex/manager.ts        # Codex lifecycle singleton
│   │       ├── runner.ts               # Runner initialization
│   │       ├── pty-manager.ts          # PTY session management
│   │       └── routes/*.ts             # HTTP route handlers
│   │
│   └── web/                            # Next.js (placeholder)
│
├── packages/
│   ├── codex/                          # Codex adapter (@forks-sh/codex)
│   │   └── src/index.ts                # Thread/turn management, approvals
│   │
│   ├── runner/                         # Task execution (@forks-sh/runner)
│   │   └── src/runner.ts               # executeSubagent, executeAttemptBatch
│   │
│   ├── store/                          # Persistence (@forks-sh/store)
│   │   └── src/
│   │       ├── store.ts                # CRUD operations
│   │       └── schema.ts               # Drizzle schema
│   │
│   ├── protocol/                       # Shared types (@forks-sh/protocol)
│   │   └── src/index.ts                # All type definitions
│   │
│   ├── git/                            # Git operations (@forks-sh/git)
│   │   └── src/
│   │       ├── workspace-manager.ts    # Workspace lifecycle
│   │       └── attempt-worktree-manager.ts  # Attempt isolation
│   │
│   ├── ws-client/                      # WebSocket client
│   ├── skills/                         # Agent skills
│   ├── ui/                             # Shared React components
│   └── typescript-config/              # Shared tsconfig presets
│
├── turbo.json                          # Turborepo pipeline
└── biome.json                          # Biome lint/format
```

---

## MCP Tools Reference

| Category | Tools |
|----------|-------|
| **Attempts** | `attempt_spawn`, `attempt_pick`, `attempt_status` |
| **Subagents** | `subagent_spawn`, `subagent_status`, `subagent_cancel`, `subagent_await`, `subagent_list` |
| **Plans** | `plan_propose`, `plan_respond`, `plan_status`, `plan_list`, `plan_cancel` |
| **Questions** | `ask_question`, `ask_respond`, `question_status`, `question_list`, `question_cancel` |
| **Tasks** | `task_create`, `task_claim`, `task_unclaim`, `task_complete`, `task_fail`, `task_update`, `task_delete`, `task_list` |
| **Terminals** | `terminal_spawn`, `terminal_execute`, `terminal_read`, `terminal_promote`, `terminal_list` |
| **Graphite** | `graphite_stack_info`, `graphite_submit` |

---

## Security Model

**Local desktop application, not a public API server.**

- forksd runs on localhost only (127.0.0.1:38765)
- Single-user model, OS provides process isolation
- Auth token stored encrypted via OS keychain (safeStorage)

**Trust Boundaries:**
1. Desktop ↔ forksd: Token-based auth
2. forksd ↔ Codex: Child process, same trust domain
3. Codex ↔ OpenAI: External API
4. forksd ↔ Graphite: External CLI

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop | Tauri, Vite, Solid |
| Daemon | Node.js, Hono, WebSocket, node-pty |
| MCP | @modelcontextprotocol/sdk |
| AI Engine | Codex CLI (@openai/codex) |
| Database | SQLite via better-sqlite3 |
| Monorepo | Turborepo, Bun |
| Lint/Format | Ultracite (Biome) |
