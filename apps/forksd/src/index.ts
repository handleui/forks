/**
 * forksd – local Node daemon
 * - MCP server endpoint(s)
 * - HTTP control API (Hono)
 * - WebSocket streams (task + terminal output)
 * - PTY sessions via node-pty
 * - persistence via @forks-sh/store
 */

import { CONFIG_VERSION } from "@forks-sh/config";
import { PROTOCOL_VERSION } from "@forks-sh/protocol";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { createMcpServer } from "./mcp.js";
import { spawnShell } from "./pty.js";

const app = new Hono();
const PORT = Number(process.env.FORKSD_PORT ?? 38_765);

app.get("/health", (c) =>
  c.json({ ok: true, config: CONFIG_VERSION, protocol: PROTOCOL_VERSION })
);

app.get("/mcp", (c) => {
  createMcpServer(); // ensure SDK is wired; TODO: connect to SSE/Streamable HTTP
  return c.json({ type: "mcp", server: "forksd", status: "stub" });
});

app.post("/pty/spawn", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { cwd?: string };
  const pty = spawnShell({ cwd: body.cwd });
  const id = `pty-${Date.now()}`;
  ptySessions.set(id, pty);
  pty.onExit(() => ptySessions.delete(id));
  return c.json({ ok: true, id });
});

const ptySessions = new Map<string, import("node-pty").IPty>();

const server = createAdaptorServer({
  fetch: app.fetch,
}) as import("node:http").Server;
const wss = new WebSocketServer({ server });

wss.on(
  "connection",
  (ws: import("ws").WebSocket, _req: import("http").IncomingMessage) => {
    // Stub: task + terminal output streams will be wired here
    ws.on("message", (data: import("ws").RawData) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        /* ignore */
      }
    });
  }
);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`forksd http://localhost:${PORT}`);
});
