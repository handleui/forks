# Forks Desktop

Local desktop UI for Forks. The Tauri shell owns forksd lifecycle and token
management, while the Solid webview renders the workspace surface.

## Development

- Run `bun run dev` at the repo root to start everything.
- Or run `turbo dev --filter=forksd` and `turbo dev --filter=desktop`.

## Runtime Model

- Rust core ensures forksd is running and provides auth tokens to the UI.
- The webview connects to forksd over WebSocket for events and PTY streams.
- Auth tokens are stored under the app data directory at `forksd/forksd.auth`.

## Configuration

- `FORKSD_BIND` and `FORKSD_PORT` override the daemon address.
- `FORKSD_ALLOWED_ORIGINS` controls WebSocket and HTTP origin allowlists.
