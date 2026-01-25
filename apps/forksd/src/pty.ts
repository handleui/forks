/**
 * PTY sessions via node-pty.
 * Spawns a shell that can be wired to WebSocket or other streams.
 */

import type { IPty, IPtyForkOptions } from "node-pty";
import { spawn } from "node-pty";

const BLOCKED_ENV_PATTERN =
  /^(API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE|AUTH|CREDENTIAL|KEY|PASSWD|PWD)/i;
const SAFE_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TZ",
  "EDITOR",
  "PAGER",
  "DISPLAY",
]);

const filterEnv = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      if (SAFE_ENV_VARS.has(key)) {
        return true;
      }
      if (key.startsWith("XDG_")) {
        return true;
      }
      return !BLOCKED_ENV_PATTERN.test(key);
    })
  ) as IPtyForkOptions["env"];

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
    env: filterEnv(process.env),
  });
}
