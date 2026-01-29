# Forks

Local desktop app for AI-powered development. Electron app → forksd daemon → Codex AI.

**See [ARCHITECTURE.md](../ARCHITECTURE.md)** for system design, data flows, and directory structure.

## Commands

```bash
bun run dev          # all apps
bun run build        # build everything
bun run fix          # lint/format (run before committing)
bun run check        # lint check only
bun run check-types  # typecheck

# Single app
turbo dev --filter=forksd
turbo dev --filter=desktop
```

## Boundaries

### Always Do
- Run `bun run fix` before committing
- Use Nia MCP tools to verify external docs/APIs before answering

### Ask First
- Changes to MCP tools/resources in forksd
- Changes to `@forks-sh/protocol` or forksd HTTP/PTY contracts
- Changes to `@forks-sh/store` persistence

### Never Do
- Commit without running `bun run fix`

## Project-Specific Style

Biome handles standard linting. Project deviations only:

- **Files**: kebab-case (`user-profile.tsx`)
- **Types**: Prefer interfaces; use `type` keyword for type-only imports
- **Functions**: Arrow functions only
- **Comments**: None unless critical; prefix hacks with `// HACK: reason`

## Environment Files

- `.env` — Template with placeholders (committed, serves as docs)
- `.env.development`, `.env.production` — Real values (gitignored)

Copy `.env` to `.env.development` and fill in values.

## Git

Conventional commits required (validated by commitlint):

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `chore`, `ci`, `revert`

Breaking changes: add `!` after type (e.g., `feat!: remove deprecated API`)

Rules: header only, lowercase, no period, max 72 chars

## Security Model

**Local app, not a public API server.**

- forksd runs on localhost only
- Single-user model, OS provides process isolation
- No auth layer needed for local HTTP/WebSocket
- Input validation prevents footguns, not attacks

External connections (only trust boundaries):
- **OpenAI** — via Codex
- **Graphite** — git stacking (gt CLI)

## Plan Mode

- Extremely concise. Sacrifice grammar for brevity.
- End with unresolved questions if any.
