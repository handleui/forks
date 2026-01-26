import { randomUUID } from "node:crypto";
import type { Store } from "@forks-sh/store";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { registerTools } from "./mcp/tools.js";

const transports: Record<string, StreamableHTTPServerTransport> = {};
const sessionCreatedAt: Record<string, number> = {};

const MAX_MCP_SESSIONS = 50;
const MAX_JSON_BYTES = 64 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate session ID format (UUID v4) */
const isValidSessionId = (id: string): boolean => {
  if (!id || id.length > 36) {
    return false;
  }
  return SESSION_ID_PATTERN.test(id);
};

// TODO: Consider using a min-heap or sorted structure if MAX_MCP_SESSIONS grows significantly
// Current O(n) iteration is acceptable for n=50 sessions
const cleanupExpiredSessions = () => {
  const now = Date.now();
  for (const sessionId of Object.keys(sessionCreatedAt)) {
    const createdAt = sessionCreatedAt[sessionId];
    if (createdAt !== undefined && now - createdAt > SESSION_TTL_MS) {
      const transport = transports[sessionId];
      if (transport) {
        try {
          transport.close();
        } catch (err) {
          console.warn(
            `[MCP] Failed to close transport for expired session ${sessionId}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
      delete transports[sessionId];
      delete sessionCreatedAt[sessionId];
    }
  }
};

const cleanupInterval = setInterval(
  cleanupExpiredSessions,
  CLEANUP_INTERVAL_MS
);
cleanupInterval.unref();

const createMcpServer = (store: Store): Server => {
  const server = new Server(
    { name: "forksd", version: "0.0.0" },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
    }
  );

  registerTools(server, store);

  return server;
};

/** JSON-RPC error response helper */
const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

/** Check if we can create a new session (under limit) */
const canCreateNewSession = (): boolean => {
  if (Object.keys(transports).length < MAX_MCP_SESSIONS) {
    return true;
  }
  cleanupExpiredSessions();
  return Object.keys(transports).length < MAX_MCP_SESSIONS;
};

/** Create Hono router for MCP endpoints */
export const createMcpRouter = (store: Store) => {
  /** Create a new session transport and connect it to a server */
  const createNewSession = async (): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        sessionCreatedAt[id] = Date.now();
      },
      onsessionclosed: (id) => {
        delete transports[id];
        delete sessionCreatedAt[id];
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        delete sessionCreatedAt[transport.sessionId];
      }
    };

    const server = createMcpServer(store);
    await server.connect(transport);

    return transport;
  };

  const app = new Hono<{ Bindings: HttpBindings }>();

  // POST / - Handle MCP requests
  app.post("/", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json(jsonRpcError(-32_000, "Payload too large"), 413);
    }

    const { incoming, outgoing } = c.env;
    const sessionId = c.req.header("mcp-session-id");

    if (sessionId && !isValidSessionId(sessionId)) {
      return c.json(jsonRpcError(-32_000, "Invalid session ID"), 400);
    }

    const body = await c.req.json().catch(() => ({}));
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      sessionCreatedAt[sessionId] = Date.now();
    } else if (sessionId) {
      return c.json(jsonRpcError(-32_000, "Session not found"), 400);
    } else if (isInitializeRequest(body)) {
      if (!canCreateNewSession()) {
        return c.json(
          jsonRpcError(-32_000, "Server busy: Too many active sessions"),
          503
        );
      }
      transport = await createNewSession();
    } else {
      return c.json(
        jsonRpcError(-32_000, "Bad Request: No valid session"),
        400
      );
    }

    try {
      await transport.handleRequest(incoming, outgoing, body);
    } catch {
      return c.json(jsonRpcError(-32_603, "Internal error"), 500);
    }
    return RESPONSE_ALREADY_SENT;
  });

  // GET / - Handle SSE stream for notifications
  app.get("/", async (c) => {
    const { incoming, outgoing } = c.env;
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId) {
      return c.json(jsonRpcError(-32_000, "Missing session ID"), 400);
    }
    if (!isValidSessionId(sessionId)) {
      return c.json(jsonRpcError(-32_000, "Invalid session ID"), 400);
    }

    const transport = transports[sessionId];
    if (!transport) {
      return c.json(jsonRpcError(-32_000, "Session not found"), 400);
    }

    sessionCreatedAt[sessionId] = Date.now();

    try {
      await transport.handleRequest(incoming, outgoing);
    } catch {
      return c.json(jsonRpcError(-32_603, "Internal error"), 500);
    }
    return RESPONSE_ALREADY_SENT;
  });

  // DELETE / - Handle session termination
  app.delete("/", async (c) => {
    const { incoming, outgoing } = c.env;
    const sessionId = c.req.header("mcp-session-id");

    if (!sessionId) {
      return c.json(jsonRpcError(-32_000, "Missing session ID"), 400);
    }
    if (!isValidSessionId(sessionId)) {
      return c.json(jsonRpcError(-32_000, "Invalid session ID"), 400);
    }

    const transport = transports[sessionId];
    if (!transport) {
      return c.json(jsonRpcError(-32_000, "Session not found"), 400);
    }

    try {
      await transport.handleRequest(incoming, outgoing);
    } catch {
      delete transports[sessionId];
      delete sessionCreatedAt[sessionId];
      return c.json(jsonRpcError(-32_603, "Internal error"), 500);
    }
    return RESPONSE_ALREADY_SENT;
  });

  return app;
};
