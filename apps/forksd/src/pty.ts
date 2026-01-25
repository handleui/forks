/**
 * PTY sessions via node-pty.
 * Spawns a shell that can be wired to WebSocket or other streams.
 */

import type { IPty, IPtyForkOptions } from "node-pty";
import { spawn } from "node-pty";

export function spawnShell(opts?: { cwd?: string }): IPty {
  const shell =
    process.platform === "win32"
      ? "powershell.exe"
      : process.env.SHELL || "bash";
  return spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: opts?.cwd ?? process.cwd(),
    env: process.env as IPtyForkOptions["env"],
  });
}
