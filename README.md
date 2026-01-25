# Forks

Monorepo for the Forks stack: web app, Electron desktop, and a local daemon (forksd) with MCP, HTTP, WebSocket, and PTY support.

## What's inside

### Apps

- **`web`** – [Next.js](https://nextjs.org/) app (port 3000)
- **`desktop`** – Electron app; renderer (Vite) + main process; connects to forksd
- **`forksd`** – Node daemon: MCP server, Hono HTTP API, WebSocket, PTY via node-pty; persists via `@forks-sh/store`

### Packages

- **`@forks-sh/ui`** – React component library (used by `web`)
- **`@forks-sh/typescript-config`** – Shared `tsconfig` base, Next.js, and react-library presets
- **`@forks-sh/config`** – App config (used by forksd)
- **`@forks-sh/git`** – Git operations
- **`@forks-sh/protocol`** – Shared types and wire format
- **`@forks-sh/runner`** – Task execution
- **`@forks-sh/skills`** – Skills/runtime
- **`@forks-sh/store`** – Persistence

All packages and apps are TypeScript.

### Tooling

- [TypeScript](https://www.typescriptlang.org/) for type checking
- [Ultracite](https://docs.ultracite.ai/) (Biome) for formatting and linting
- [Changesets](https://github.com/changesets/changesets) for versioning

## Setup

```sh
bun install
```

## Scripts (root)

| Script        | Command                    |
|---------------|----------------------------|
| `bun run dev` | `turbo run dev`            |
| `bun run build` | `turbo run build`        |
| `bun run typecheck` | `turbo run typecheck` |
| `bun run check-types` | `turbo run check-types` |
| `bun run check` | `ultracite check`       |
| `bun run fix`  | `ultracite fix`            |

## Build

```sh
# All
bun run build
# Or with turbo directly
turbo build

# Filter
turbo build --filter=web
turbo build --filter=desktop
turbo build --filter=forksd
```

## Develop

```sh
# All
bun run dev

# Single app
turbo dev --filter=web
turbo dev --filter=desktop   # runs renderer (Vite) + main (Electron)
turbo dev --filter=forksd    # tsx watch, http://localhost:38765
```

## forksd environment

`forksd` defaults to local-only bind and requires a local auth token. The desktop app generates and stores the token and passes it to forksd when it spawns.

Local-only security notes:
- `forksd` binds to localhost by default and rejects remote binds unless explicitly allowed.
- Every HTTP/WS request requires the local auth token.
- Origins are allowlisted; `null` origin is only allowed if you explicitly add it.
- Rate limiting is disabled unless Upstash Redis is configured.

| Variable | Default | Description |
|---|---|---|
| `FORKSD_BIND` | `127.0.0.1` | Bind host. |
| `FORKSD_PORT` | `38765` | HTTP/WS port. |
| `FORKSD_ALLOW_REMOTE` | `0` | Require explicit opt-in to bind to `0.0.0.0`/`::`. |
| `FORKSD_AUTH_TOKEN` | — | Required local auth token for HTTP/WS. |
| `FORKSD_ALLOWED_ORIGINS` | `http://localhost:5173,file://` | Comma-separated origin allowlist. |
| `UPSTASH_REDIS_REST_URL` | — | Upstash Redis REST URL for rate limiting. |
| `UPSTASH_REDIS_REST_TOKEN` | — | Upstash Redis REST token for rate limiting. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms. |
| `RATE_LIMIT_MAX` | `100` | Max requests per window. |

### WorkOS (optional)

`forksd` enables WorkOS AuthKit only when these are provided:

| Variable | Default | Description |
|---|---|---|
| `WORKOS_API_KEY` | — | WorkOS server API key (daemon-only). |
| `WORKOS_CLIENT_ID` | — | WorkOS client ID. |
| `WORKOS_REDIRECT_URI` | `http://<bind>:<port>/auth/callback` | Redirect URI registered in WorkOS. |
| `FORKSD_WORKOS_AUTO_LOGIN` | `0` | If `1`, desktop opens the AuthKit login flow on start. |

External providers (WorkOS, Upstash) are present only to future-proof cloud workflows. Local-only mode does not require them.

## Code quality

- **Lint/format**: `bun x ultracite fix`
- **Check only**: `bun x ultracite check`
- **Diagnose**: `bun x ultracite doctor`

See [AGENTS.md](./AGENTS.md) for Ultracite and project standards.

## Remote caching

Turborepo can use [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching). To enable:

```sh
turbo login
turbo link
```

## Links

- [Turborepo: Tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks)
- [Turborepo: Caching](https://turborepo.dev/docs/crafting-your-repository/caching)
- [Turborepo: Filtering](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters)
