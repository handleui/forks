# @forks-sh/git

Git operations for Forks with a pluggable driver backend.

## Why multiple drivers exist

The desktop app hosts the Rust git RPC server, which is the preferred backend.
In desktop runtime, we can also use direct Tauri invokes. Both are separate
drivers behind the same API.

## Driver selection

Selection happens in `packages/git/src/driver.ts`:

- If `FORKS_GIT_DRIVER=rpc` and `FORKS_GIT_RPC_SOCKET` is set, use RPC.
- If `FORKS_GIT_DRIVER=tauri`, use the Tauri invoke driver (desktop only).
- If `FORKS_GIT_RPC_SOCKET` is set, use RPC.
- If running in a Tauri runtime, try Tauri invoke.
- Otherwise, an error is raised (no driver available).

## Requirement

Forksd must be launched by the desktop app so the RPC socket is available.
