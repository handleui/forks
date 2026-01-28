/**
 * forksd – local Node daemon
 * - MCP server endpoint(s)
 * - HTTP control API (Hono)
 * - WebSocket streams (task + terminal output)
 * - PTY sessions via node-pty
 * - persistence via @forks-sh/store
 */

import { captureError, initSentry } from "./lib/sentry.js";

initSentry();

process.on("uncaughtException", (error) => {
  captureError(error, { type: "uncaughtException" });
  console.error("Uncaught exception:", error);
  setTimeout(() => process.exit(1), 2000);
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  captureError(error, { type: "unhandledRejection" });
  console.error("Unhandled rejection:", error);
});

import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { resolve, sep } from "node:path";
import type { CodexEvent } from "@forks-sh/codex";
import { createWorkspaceManager } from "@forks-sh/git/workspace-manager";
import {
  CONFIG_VERSION,
  type CodexItemEvent,
  type CodexLoginCompleteEvent,
  type CodexThreadEvent,
  type CodexTurnEvent,
  PROTOCOL_VERSION,
} from "@forks-sh/protocol";
import { getForksMcpSkill } from "@forks-sh/skills";
import { createStore, createStoreEventEmitter } from "@forks-sh/store";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { codexManager } from "./codex/manager.js";
import { createMcpRouter } from "./mcp.js";
import { spawnShell } from "./pty.js";
import { createPtyManager } from "./pty-manager.js";
import { createGraphiteRoutes } from "./routes/graphite.js";
import { createProjectRoutes } from "./routes/projects.js";
import { createWorkspaceRoutes } from "./routes/workspaces.js";

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
const MAX_WS_CONNECTIONS = 100;

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Approval tokens are 32 bytes of randomBytes encoded as base64url = exactly 43 characters
// Pattern matches base64url character set with exact length for security
const APPROVAL_TOKEN_LENGTH = 43;
const APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_ID_LENGTH = 128;

const isValidId = (id: string): boolean => {
  if (!id || id.length > MAX_ID_LENGTH) {
    return false;
  }
  return ID_PATTERN.test(id);
};

const stripControlChars = (str: string): string => {
  let result = "";
  for (const char of str) {
    const code = char.charCodeAt(0);
    if (code >= 32 && code !== 127) {
      result += char;
    }
  }
  return result;
};

const validateCwd = (
  inputCwd: string | undefined
): { ok: true; cwd: string } | { ok: false } => {
  const cwd = inputCwd ? resolve(process.cwd(), inputCwd) : process.cwd();
  const basePath = resolve(process.cwd());
  if (cwd !== basePath && !cwd.startsWith(`${basePath}${sep}`)) {
    return { ok: false };
  }
  return { ok: true, cwd };
};

/**
 * Sanitizes error messages for client responses and captures to Sentry.
 */
const sanitizeErrorMessage = (err: unknown): string => {
  if (!(err instanceof Error)) {
    captureError(new Error("unknown_error"), { originalError: String(err) });
    return "unknown_error";
  }
  captureError(err);
  const msg = err.message;
  if (msg.includes("/") || msg.includes("\\") || msg.length > 200) {
    return "internal_error";
  }
  return stripControlChars(msg);
};

if (!ALLOW_REMOTE && (BIND === "0.0.0.0" || BIND === "::" || BIND === "::0")) {
  throw new Error(
    "Refusing to bind to a remote interface without FORKSD_ALLOW_REMOTE=1."
  );
}

const storeEmitter = createStoreEventEmitter();
const store = createStore({ emitter: storeEmitter });
const workspaceManager = createWorkspaceManager(store);
const ptyManager = createPtyManager();

// Initialize runner dependencies (lazy initialization happens in runner.ts)
import { initRunnerIfNeeded, setRunnerDependencies } from "./runner.js";

setRunnerDependencies({ store });

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
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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

app.route("/mcp", createMcpRouter(store, ptyManager, storeEmitter));

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
  const cwdResult = validateCwd(parsed.data.cwd);
  if (!cwdResult.ok) {
    return c.json({ ok: false, error: "invalid_cwd" }, 400);
  }
  const { cwd } = cwdResult;
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
  ptyManager.register(id, pty, cwd, {
    owner: "user",
    visible: true,
    onClose: (session, exitCode) => {
      storeEmitter.emit("agent", {
        type: "terminal",
        event: "closed",
        terminal: {
          id: session.id,
          workspaceId: null,
          createdBy: session.owner,
          label: null,
          cwd: session.cwd,
          visibility: session.visible ? "visible" : "background",
          status: "exited",
          exitCode,
          command: session.command,
          createdAt: session.createdAt,
        },
      });
    },
  });
  pty.onExit(() => ptyManager.unregister(id));
  return c.json({ ok: true, id });
});

app.get("/codex/status", async (c) => {
  try {
    const status = await codexManager.getStatus();
    return c.json({ ok: true, ...status });
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.post("/codex/auth/check", async (c) => {
  try {
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    const result = await adapter.checkAuth();
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.post("/codex/auth/login", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      type: z.enum(["apiKey", "chatgpt"]),
      apiKey: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    const result = await adapter.startLogin(
      parsed.data.type,
      parsed.data.apiKey
    );
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.post("/codex/thread/start", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      cwd: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }
    const cwdResult = validateCwd(parsed.data.cwd);
    if (!cwdResult.ok) {
      return c.json({ ok: false, error: "invalid_cwd" }, 400);
    }
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    if (parsed.data.cwd) {
      adapter.setWorkingDirectory(cwdResult.cwd);
    }
    const thread = adapter.startThread({
      baseInstructions: getForksMcpSkill(),
    });
    return c.json({ ok: true, threadId: thread.id });
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.post("/codex/thread/:id/turn", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  const threadId = c.req.param("id");
  if (!isValidId(threadId)) {
    return c.json({ ok: false, error: "invalid_thread_id" }, 400);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      input: z.string().min(1),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    const runId = await adapter.sendTurn(threadId, parsed.data.input);
    return c.json({ ok: true, runId });
  } catch (err) {
    return c.json({ ok: false, error: sanitizeErrorMessage(err) }, 500);
  }
});

app.post("/codex/thread/:id/fork", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  const threadId = c.req.param("id");
  if (!isValidId(threadId)) {
    return c.json({ ok: false, error: "invalid_thread_id" }, 400);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      cwd: z.string().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }
    const cwdResult = validateCwd(parsed.data.cwd);
    if (!cwdResult.ok) {
      return c.json({ ok: false, error: "invalid_cwd" }, 400);
    }
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    const result = await adapter.forkThread(threadId, {
      cwd: parsed.data.cwd ? cwdResult.cwd : null,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ ok: false, error: sanitizeErrorMessage(err) }, 500);
  }
});

app.post("/codex/turn/:id/cancel", async (c) => {
  const runId = c.req.param("id");
  if (!isValidId(runId)) {
    return c.json({ ok: false, error: "invalid_run_id" }, 400);
  }
  try {
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    await adapter.cancel(runId);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: sanitizeErrorMessage(err) }, 500);
  }
});

// Legacy endpoint for direct Codex responses (bypasses store)
app.post("/codex/approval/:token/respond", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  const approvalToken = c.req.param("token");
  // Validate token format and exact length (43 chars for base64url of 32 bytes)
  if (
    !(
      approvalToken &&
      approvalToken.length === APPROVAL_TOKEN_LENGTH &&
      APPROVAL_TOKEN_PATTERN.test(approvalToken)
    )
  ) {
    return c.json({ ok: false, error: "invalid_approval_token" }, 400);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    const response: import("@forks-sh/codex").ApprovalResponse = {
      decision: parsed.data.decision,
    };
    const found = adapter.respondToApproval(approvalToken, response);
    if (!found) {
      return c.json({ ok: false, error: "approval_not_found" }, 404);
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: sanitizeErrorMessage(err) }, 500);
  }
});

// New approval endpoint that integrates with store and runner
app.post("/approval/:token/respond", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  const approvalToken = c.req.param("token");
  // Validate token format and exact length (43 chars for base64url of 32 bytes)
  if (
    !(
      approvalToken &&
      approvalToken.length === APPROVAL_TOKEN_LENGTH &&
      APPROVAL_TOKEN_PATTERN.test(approvalToken)
    )
  ) {
    return c.json({ ok: false, error: "invalid_approval_token" }, 400);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      decision: z.enum(["accept", "acceptForSession", "decline"]),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    // Get approval from store - token is already validated for length
    const approval = store.getApprovalByToken(approvalToken);
    if (!approval) {
      return c.json({ ok: false, error: "approval_not_found" }, 404);
    }

    // Atomically update store - respondToApproval only updates if status is "pending"
    // This prevents race conditions where two responses arrive simultaneously
    const accepted = parsed.data.decision !== "decline";
    const updated = store.respondToApproval(approval.id, accepted);
    if (!updated) {
      // Approval was already responded to by another request
      return c.json({ ok: false, error: "approval_not_pending" }, 400);
    }

    // Notify runner to unblock the pending approval
    const runner = await initRunnerIfNeeded();
    const notified = runner.notifyApprovalResponse(
      approvalToken,
      parsed.data.decision
    );

    // Note: If notified is false, the approval was stored but the runner couldn't be notified
    // (e.g., thread was cancelled, runner restarted). The store was already updated atomically.
    return c.json({ ok: true, approval: updated, runnerNotified: notified });
  } catch (err) {
    return c.json({ ok: false, error: sanitizeErrorMessage(err) }, 500);
  }
});

// Get approval status by token
app.get("/approval/:token", (c) => {
  const approvalToken = c.req.param("token");
  // Validate token format and exact length (43 chars for base64url of 32 bytes)
  if (
    !(
      approvalToken &&
      approvalToken.length === APPROVAL_TOKEN_LENGTH &&
      APPROVAL_TOKEN_PATTERN.test(approvalToken)
    )
  ) {
    return c.json({ ok: false, error: "invalid_approval_token" }, 400);
  }
  const approval = store.getApprovalByToken(approvalToken);
  if (!approval) {
    return c.json({ ok: false, error: "approval_not_found" }, 404);
  }
  return c.json({ ok: true, approval });
});

// List pending approvals for a chat
app.get("/chat/:chatId/approvals", (c) => {
  const chatId = c.req.param("chatId");
  if (!isValidId(chatId)) {
    return c.json({ ok: false, error: "invalid_chat_id" }, 400);
  }
  const approvals = store.getPendingApprovals(chatId);
  return c.json({ ok: true, approvals });
});

app.post("/codex/exec", async (c) => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return c.json({ ok: false, error: "payload_too_large" }, 413);
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return c.json({ ok: false, error: "invalid_content_type" }, 415);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      command: z.array(z.string()).min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }
    const cwdResult = validateCwd(parsed.data.cwd);
    if (!cwdResult.ok) {
      return c.json({ ok: false, error: "invalid_cwd" }, 400);
    }
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    const result = await adapter.execCommand(parsed.data.command, {
      cwd: parsed.data.cwd ? cwdResult.cwd : null,
      timeoutMs: parsed.data.timeoutMs ?? null,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = sanitizeErrorMessage(err);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.route("/projects", createProjectRoutes(workspaceManager));
app.route("/projects", createGraphiteRoutes(workspaceManager, storeEmitter));
app.route("/workspaces", createWorkspaceRoutes(workspaceManager));

interface WebSocketSession {
  ws: import("ws").WebSocket;
  userId?: string;
  authenticatedAt: number;
  codexUnsubscribe?: () => void;
  codexApprovalUnsubscribe?: () => void;
  agentUnsubscribe?: () => void;
}

const wsSessions = new Map<import("ws").WebSocket, WebSocketSession>();

type CodexProtocolEvent =
  | CodexThreadEvent
  | CodexTurnEvent
  | CodexItemEvent
  | CodexLoginCompleteEvent;

const mapCodexEventToProtocol = (
  event: CodexEvent
): CodexProtocolEvent | null => {
  const { type } = event;
  const threadId =
    typeof event.conversationId === "string" ? event.conversationId : "";
  const turnId = typeof event.turnId === "string" ? event.turnId : "";
  const itemId = typeof event.itemId === "string" ? event.itemId : "";

  if (type === "account/login/completed") {
    return {
      type: "codex:loginComplete",
      loginId: typeof event.loginId === "string" ? event.loginId : "",
      success: typeof event.success === "boolean" ? event.success : false,
      error: typeof event.error === "string" ? event.error : null,
    };
  }

  if (type === "thread/started") {
    return {
      type: "codex:thread",
      threadId,
      event: "started",
      data: event,
    };
  }

  if (type === "turn/completed") {
    return {
      type: "codex:turn",
      threadId,
      turnId,
      event: "completed",
      data: event,
    };
  }

  if (type === "item/started") {
    return {
      type: "codex:item",
      threadId,
      turnId,
      itemId,
      event: "started",
      itemType: "message",
      data: event,
    };
  }

  if (type === "item/completed") {
    return {
      type: "codex:item",
      threadId,
      turnId,
      itemId,
      event: "completed",
      itemType: "message",
      data: event,
    };
  }

  if (type === "item/agentMessage/delta") {
    return {
      type: "codex:item",
      threadId,
      turnId,
      itemId,
      event: "delta",
      itemType: "message",
      content: typeof event.delta === "string" ? event.delta : "",
      data: event,
    };
  }

  return null;
};

const server = createAdaptorServer({
  fetch: app.fetch,
}) as import("node:http").Server;
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  verifyClient: (info, done) => {
    // Check connection limit
    if (wsSessions.size >= MAX_WS_CONNECTIONS) {
      return done(false, 503, "Too many connections");
    }
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
    const session: WebSocketSession = {
      ws,
      authenticatedAt: Date.now(),
    };
    wsSessions.set(ws, session);

    // Handle backpressure: pause sending if buffer is full
    let isPaused = false;
    let droppedEventsCount = 0;
    const checkBackpressure = () => {
      if (ws.bufferedAmount > MAX_WS_PAYLOAD_BYTES * 2) {
        if (!isPaused) {
          isPaused = true;
        }
      } else if (isPaused && ws.bufferedAmount < MAX_WS_PAYLOAD_BYTES) {
        isPaused = false;
        if (droppedEventsCount > 0) {
          console.warn(
            `[ws] Resumed after dropping ${droppedEventsCount} events due to backpressure`
          );
          droppedEventsCount = 0;
        }
      }
    };

    // Helper to check if event can be dropped during backpressure
    const isDroppableDuringBackpressure = (eventType: string): boolean =>
      eventType === "item/agentMessage/delta" ||
      eventType === "item/toolCall/delta";

    // Subscribe to Codex events if adapter is available
    try {
      const adapter = codexManager.getAdapter();
      const unsubscribe = adapter.onEvent((event: CodexEvent) => {
        checkBackpressure();
        // Drop delta events during backpressure; keep important lifecycle events
        if (isPaused && isDroppableDuringBackpressure(event.type)) {
          droppedEventsCount++;
          return;
        }
        const mapped = mapCodexEventToProtocol(event);
        if (mapped && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "codex", event: mapped }), (err) => {
            if (err) {
              ws.close();
            }
          });
        }
      });
      session.codexUnsubscribe = unsubscribe;

      // Subscribe to approval requests - always forward, never drop
      const unsubApproval = adapter.onApprovalRequest(
        (req: import("@forks-sh/codex").ApprovalRequest) => {
          if (ws.readyState !== ws.OPEN) {
            return;
          }
          const approvalEvent: import("@forks-sh/protocol").CodexApprovalRequestEvent =
            {
              type: "codex:approval",
              token: req.token,
              approvalType: req.type,
              threadId: (req.params as { threadId?: string }).threadId ?? "",
              turnId: (req.params as { turnId?: string }).turnId ?? "",
              itemId: (req.params as { itemId?: string }).itemId ?? "",
              command: (req.params as { command?: string }).command,
              cwd: (req.params as { cwd?: string }).cwd,
              reason: (req.params as { reason?: string }).reason ?? null,
              data: req.params,
            };
          ws.send(
            JSON.stringify({ type: "codex", event: approvalEvent }),
            (err) => {
              if (err) {
                ws.close();
              }
            }
          );
        }
      );
      session.codexApprovalUnsubscribe = unsubApproval;
    } catch {
      // Codex adapter not yet initialized - client can still use other features
    }

    // Subscribe to agent orchestration events (tasks, chats, attempts, subagents)
    const agentListener = (event: import("@forks-sh/protocol").AgentEvent) => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      ws.send(JSON.stringify({ type: "agent", event }), (err) => {
        if (err) {
          ws.close();
        }
      });
    };
    storeEmitter.on("agent", agentListener);
    session.agentUnsubscribe = () => storeEmitter.off("agent", agentListener);

    // Handle PTY messages from client
    const handlePtyMessage = (msg: {
      type?: string;
      id?: string;
      data?: string;
      cols?: number;
      rows?: number;
    }) => {
      const { type, id } = msg;
      if (!id || typeof id !== "string") {
        return;
      }

      switch (type) {
        case "pty:attach":
          ptyManager.attach(id, ws);
          break;
        case "pty:detach":
          ptyManager.detach(id, ws);
          break;
        case "pty:input":
          if (typeof msg.data === "string") {
            ptyManager.write(id, msg.data);
          }
          break;
        case "pty:resize":
          if (typeof msg.cols === "number" && typeof msg.rows === "number") {
            ptyManager.resize(id, msg.cols, msg.rows);
          }
          break;
        default:
          // Unknown pty: message type - ignore
          break;
      }
    };

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
        const msg = JSON.parse(String(data)) as {
          type?: string;
          id?: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
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
        } else if (msg.type?.startsWith("pty:")) {
          handlePtyMessage(msg);
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
      try {
        session.codexUnsubscribe?.();
      } catch {
        /* ignore */
      }
      try {
        session.codexApprovalUnsubscribe?.();
      } catch {
        /* ignore */
      }
      try {
        session.agentUnsubscribe?.();
      } catch {
        /* ignore */
      }
      wsSessions.delete(ws);
      // Clean up WebSocket's PTY subscriptions (sessions stay alive for reconnect)
      ptyManager.detachAll(ws);
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

const shutdown = async () => {
  process.stdout.write("forksd shutting down...\n");
  const { getRunner } = await import("./runner.js");
  const runner = getRunner();
  if (runner) {
    await runner.stop();
  }
  workspaceManager.close();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
