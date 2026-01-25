/**
 * forksd – local Node daemon
 * - MCP server endpoint(s)
 * - HTTP control API (Hono)
 * - WebSocket streams (task + terminal output)
 * - PTY sessions via node-pty
 * - persistence via @forks-sh/store
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { resolve, sep } from "node:path";
import { CONFIG_VERSION, PROTOCOL_VERSION } from "@forks-sh/protocol";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createWorkosAuth } from "./auth-workos.js";
import { createMcpServer } from "./mcp.js";
import { spawnShell } from "./pty.js";
import { rateLimit } from "./rate-limit.js";

const app = new Hono();
const PORT = Number(process.env.FORKSD_PORT ?? 38_765);
const BIND = process.env.FORKSD_BIND ?? "127.0.0.1";
const ALLOW_REMOTE = process.env.FORKSD_ALLOW_REMOTE === "1";
const AUTH_TOKEN = process.env.FORKSD_AUTH_TOKEN;
const ALLOWED_ORIGINS = new Set(
  (process.env.FORKSD_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
);
const DEFAULT_ALLOWED_ORIGINS = new Set(["http://localhost:5173", "file://"]);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

if (!ALLOW_REMOTE && (BIND === "0.0.0.0" || BIND === "::" || BIND === "::0")) {
  throw new Error(
    "Refusing to bind to a remote interface without FORKSD_ALLOW_REMOTE=1."
  );
}

const workosAuth = createWorkosAuth({ bind: BIND, port: PORT });

const isOriginAllowed = (origin?: string | null): boolean => {
  // Explicitly reject null/undefined origins
  if (!origin) {
    return false;
  }

  // Handle string "null" origin (can occur in some contexts)
  if (origin === "null") {
    return ALLOWED_ORIGINS.size > 0
      ? ALLOWED_ORIGINS.has(origin)
      : DEFAULT_ALLOWED_ORIGINS.has(origin);
  }

  // Validate origin format (must be valid URL)
  try {
    const url = new URL(origin);
    // Only allow http, https, and file protocols
    if (!["http:", "https:", "file:"].includes(url.protocol)) {
      return false;
    }
  } catch {
    // Invalid URL format - reject
    return false;
  }

  // Check explicit allowlist first
  if (ALLOWED_ORIGINS.size > 0) {
    return ALLOWED_ORIGINS.has(origin);
  }

  // Fall back to defaults
  return DEFAULT_ALLOWED_ORIGINS.has(origin);
};

const setCorsHeaders = (c: import("hono").Context, origin: string) => {
  // Only set CORS headers for valid origins
  if (!isOriginAllowed(origin)) {
    return;
  }
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
  c.header(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Forksd-Token"
  );
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // Note: Access-Control-Allow-Credentials not needed unless using cookies
};

const extractTokenFromHeaders = (headers: Headers) => {
  const authHeader = headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  const tokenHeader = headers.get("x-forksd-token");
  if (tokenHeader?.length) {
    return tokenHeader;
  }
  return null;
};

const extractTokenFromWs = (req: IncomingMessage) => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  const tokenHeader = req.headers["x-forksd-token"];
  if (typeof tokenHeader === "string" && tokenHeader.length > 0) {
    return tokenHeader;
  }
  const protocolHeader = req.headers["sec-websocket-protocol"];
  if (typeof protocolHeader === "string") {
    const protocols = protocolHeader.split(",").map((entry) => entry.trim());
    const tokenProtocol = protocols.find((entry) => entry.startsWith("token."));
    if (tokenProtocol) {
      return tokenProtocol.slice("token.".length);
    }
  }
  return null;
};

const getAuthError = (code: "auth_missing" | "auth_invalid") => ({
  ok: false,
  error: "unauthorized",
  code,
});

const requireAuth = (token?: string | null) => {
  if (!AUTH_TOKEN) {
    return { ok: false, code: "auth_not_configured" as const };
  }
  if (!token) {
    return { ok: false, code: "auth_missing" as const };
  }
  if (token.length !== AUTH_TOKEN.length) {
    return { ok: false, code: "auth_invalid" as const };
  }
  const tokenBuffer = Buffer.from(token, "utf8");
  const authTokenBuffer = Buffer.from(AUTH_TOKEN, "utf8");
  if (!timingSafeEqual(tokenBuffer, authTokenBuffer)) {
    return { ok: false, code: "auth_invalid" as const };
  }
  return { ok: true as const };
};

app.use("*", rateLimit);

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  // Check origin before setting CORS headers
  if (origin && !isOriginAllowed(origin)) {
    return c.json({ ok: false, error: "origin_not_allowed" }, 403);
  }
  // Set CORS headers only for valid origins
  if (origin && isOriginAllowed(origin)) {
    setCorsHeaders(c, origin);
  }
  // Handle preflight requests
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }
  if (c.req.path === "/auth/callback") {
    const state = c.req.query("state");
    if (state && workosAuth?.isValidState(state)) {
      await next();
      return;
    }
    return c.json(getAuthError("auth_invalid"), 401);
  }
  const authResult = requireAuth(extractTokenFromHeaders(c.req.raw.headers));
  if (!authResult.ok) {
    if (authResult.code === "auth_not_configured") {
      return c.json({ ok: false, error: "auth_not_configured" }, 500);
    }
    return c.json(getAuthError(authResult.code), 401);
  }
  await next();
});

app.get("/health", (c) =>
  c.json({ ok: true, config: CONFIG_VERSION, protocol: PROTOCOL_VERSION })
);

app.get("/mcp", (c) => {
  createMcpServer(); // ensure SDK is wired; TODO: connect to SSE/Streamable HTTP
  return c.json({ type: "mcp", server: "forksd", status: "stub" });
});

app.post("/pty/spawn", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  const body = await c.req.json().catch(() => ({}));
  const schema = z.object({ cwd: z.string().min(1).max(512).optional() });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: "invalid_request" }, 400);
  }
  const cwd = parsed.data.cwd
    ? resolve(process.cwd(), parsed.data.cwd)
    : process.cwd();
  const basePath = resolve(process.cwd());
  if (cwd !== basePath && !cwd.startsWith(`${basePath}${sep}`)) {
    return c.json({ ok: false, error: "invalid_cwd" }, 400);
  }
  try {
    // stat() throws if path doesn't exist, and provides isDirectory check
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return c.json({ ok: false, error: "invalid_cwd" }, 400);
    }
  } catch {
    return c.json({ ok: false, error: "invalid_cwd" }, 400);
  }
  const pty = spawnShell({ cwd });
  // Use UUID to avoid collisions from rapid spawns
  const id = `pty-${randomUUID()}`;
  ptySessions.set(id, pty);
  pty.onExit(() => ptySessions.delete(id));
  return c.json({ ok: true, id });
});

app.get("/auth/start", async (c) => {
  if (!workosAuth) {
    return c.json({ ok: false, error: "workos_not_configured" }, 501);
  }
  const result = await workosAuth.startAuth();
  return c.json({ ok: true, ...result });
});

app.get("/auth/callback", async (c) => {
  if (!workosAuth) {
    return c.json({ ok: false, error: "workos_not_configured" }, 501);
  }
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!(code && state)) {
    return c.json({ ok: false, error: "missing_params" }, 400);
  }
  if (!workosAuth.isValidState(state)) {
    return c.json({ ok: false, error: "invalid_state" }, 401);
  }
  try {
    await workosAuth.handleCallback({ code, state });
  } catch {
    return c.json({ ok: false, error: "auth_failed" }, 500);
  }
  return c.html(
    "<html><body><h2>Login complete.</h2><p>You can close this window.</p></body></html>"
  );
});

app.get("/auth/me", (c) => {
  if (!workosAuth) {
    return c.json({ ok: false, error: "workos_not_configured" }, 501);
  }
  const user = workosAuth.getCurrentUser();
  return c.json({ ok: true, user });
});

const ptySessions = new Map<string, import("node-pty").IPty>();

interface WebSocketSession {
  ws: import("ws").WebSocket;
  userId?: string;
  authenticatedAt: number;
}

const wsSessions = new Map<import("ws").WebSocket, WebSocketSession>();

const server = createAdaptorServer({
  fetch: app.fetch,
}) as import("node:http").Server;
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  verifyClient: (info, done) => {
    if (!isOriginAllowed(info.req.headers.origin)) {
      return done(false, 403, "Origin not allowed");
    }
    const authResult = requireAuth(extractTokenFromWs(info.req));
    if (!authResult.ok) {
      if (authResult.code === "auth_not_configured") {
        return done(false, 500, "Auth not configured");
      }
      return done(false, 401, "Unauthorized");
    }
    return done(true);
  },
  handleProtocols: (protocols: Set<string>) => {
    if (protocols.has("forksd")) {
      return "forksd";
    }
    for (const entry of protocols) {
      if (entry.startsWith("token.")) {
        return entry;
      }
    }
    return false;
  },
});

wss.on(
  "connection",
  (ws: import("ws").WebSocket, _req: import("http").IncomingMessage) => {
    // Associate WebSocket with WorkOS user session if available
    const userId = workosAuth?.getCurrentUser()?.id;
    const session: WebSocketSession = {
      ws,
      userId,
      authenticatedAt: Date.now(),
    };
    wsSessions.set(ws, session);

    // Track associated PTY sessions for cleanup
    const ptyIds = new Set<string>();

    // Handle backpressure: pause sending if buffer is full
    let isPaused = false;
    const checkBackpressure = () => {
      if (ws.bufferedAmount > MAX_WS_PAYLOAD_BYTES * 2) {
        if (!isPaused) {
          isPaused = true;
          // Pause any PTY data streams if implemented
        }
      } else if (isPaused && ws.bufferedAmount < MAX_WS_PAYLOAD_BYTES) {
        isPaused = false;
        // Resume PTY data streams if implemented
      }
    };

    // Stub: task + terminal output streams will be wired here
    const getMessageSize = (data: import("ws").RawData) => {
      if (typeof data === "string") {
        return Buffer.byteLength(data, "utf8");
      }
      if (Array.isArray(data)) {
        return data.reduce((total, entry) => total + entry.length, 0);
      }
      if (data instanceof ArrayBuffer) {
        return data.byteLength;
      }
      return data.length;
    };

    ws.on("message", (data: import("ws").RawData) => {
      if (getMessageSize(data) > MAX_WS_PAYLOAD_BYTES) {
        ws.close(1009, "Message too large");
        return;
      }
      try {
        const msg = JSON.parse(String(data)) as { type?: string };
        if (msg.type === "ping") {
          // Check backpressure before sending
          checkBackpressure();
          if (!isPaused) {
            ws.send(JSON.stringify({ type: "pong" }), (err) => {
              if (err) {
                // Connection likely closed
                ws.close();
              }
            });
          }
        }
      } catch {
        /* ignore */
      }
    });

    // Handle connection errors
    ws.on("error", () => {
      // Connection will be cleaned up on close
    });

    // Cleanup on close
    ws.on("close", () => {
      wsSessions.delete(ws);
      // Clean up associated PTY sessions
      for (const id of ptyIds) {
        const pty = ptySessions.get(id);
        if (pty) {
          try {
            pty.kill();
          } catch {
            /* ignore */
          }
          ptySessions.delete(id);
        }
      }
    });

    // Ping/pong health check with timeout
    let pingTimeout: NodeJS.Timeout | null = null;
    const PING_INTERVAL_MS = 30_000;
    const PONG_TIMEOUT_MS = 10_000;

    const resetPingTimeout = () => {
      if (pingTimeout) {
        clearTimeout(pingTimeout);
      }
      pingTimeout = setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Pong timeout");
        }
      }, PONG_TIMEOUT_MS);
    };

    ws.on("pong", () => {
      if (pingTimeout) {
        clearTimeout(pingTimeout);
        pingTimeout = null;
      }
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        checkBackpressure();
        if (!isPaused) {
          ws.ping();
          resetPingTimeout();
        }
      } else {
        clearInterval(pingInterval);
        if (pingTimeout) {
          clearTimeout(pingTimeout);
        }
      }
    }, PING_INTERVAL_MS);

    ws.on("close", () => {
      clearInterval(pingInterval);
      if (pingTimeout) {
        clearTimeout(pingTimeout);
      }
    });
  }
);

server.listen(PORT, BIND, () => {
  process.stdout.write(`forksd http://${BIND}:${PORT}\n`);
});
