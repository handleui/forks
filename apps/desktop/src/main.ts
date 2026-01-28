import { createRequire } from "node:module";
import type { Event, EventHint } from "@sentry/electron/main";
import {
  captureException,
  flush,
  init as initSentry,
} from "@sentry/electron/main";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const COMPONENT = "desktop";
const PRODUCT = "forks";

// HACK: @sentry/electron v7 doesn't export ErrorEvent but beforeSend expects it
// Using Event with a cast since ErrorEvent extends Event with type: undefined
type SentryBeforeSend = (
  event: Event,
  hint: EventHint
) => Event | null | Promise<Event | null>;

// Specific patterns for known sensitive formats to avoid false positives on UUIDs/base64/SHAs
const SENSITIVE_VALUES = new RegExp(
  [
    /Bearer\s+[^\s]+/.source, // Bearer tokens
    /sk-[a-zA-Z0-9]{20,}/.source, // OpenAI API keys
    /AKIA[0-9A-Z]{16}/.source, // AWS access keys
    /gh[ps]_[a-zA-Z0-9]{36}/.source, // GitHub tokens (classic)
    /github_pat_[a-zA-Z0-9_]{22,}/.source, // GitHub fine-grained PATs
    /xox[baprs]-[a-zA-Z0-9-]+/.source, // Slack tokens
    /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+/.source, // JWT tokens
  ].join("|"),
  "gi"
);

const scrubFilePath = (path: string): string =>
  path
    .replace(/\/Users\/[^/]+/g, "/Users/[user]")
    .replace(/\/home\/[^/]+/g, "/home/[user]")
    .replace(/C:\\Users\\[^\\]+/g, "C:\\Users\\[user]");

const scrubString = (str: string): string =>
  scrubFilePath(str).replace(SENSITIVE_VALUES, "[Filtered]");

const scrubExceptions = (event: Event): void => {
  if (!event.exception?.values) {
    return;
  }
  for (const exception of event.exception.values) {
    if (exception.value) {
      exception.value = scrubString(exception.value);
    }
    if (!exception.stacktrace?.frames) {
      continue;
    }
    for (const frame of exception.stacktrace.frames) {
      if (frame.filename) {
        frame.filename = scrubFilePath(frame.filename);
      }
      if (frame.abs_path) {
        frame.abs_path = scrubFilePath(frame.abs_path);
      }
    }
  }
};

const scrubBreadcrumbs = (event: Event): void => {
  if (!event.breadcrumbs) {
    return;
  }
  for (const breadcrumb of event.breadcrumbs) {
    if (breadcrumb.message) {
      breadcrumb.message = scrubString(breadcrumb.message);
    }
  }
};

const beforeSend: SentryBeforeSend = (event, _hint) => {
  scrubExceptions(event);
  scrubBreadcrumbs(event);
  return event;
};

const isProduction = process.env.NODE_ENV === "production";

initSentry({
  dsn: process.env.SENTRY_DSN,
  environment: isProduction ? "production" : "development",
  enabled: !!process.env.SENTRY_DSN && isProduction,
  release: `${COMPONENT}@${pkg.version}`,
  tracesSampleRate: 0,
  debug: !isProduction,
  beforeSend: beforeSend as unknown as Parameters<
    typeof initSentry
  >[0]["beforeSend"],
  initialScope: {
    tags: {
      component: COMPONENT,
      product: PRODUCT,
      process: "main",
    },
  },
});

process.on("uncaughtException", async (error) => {
  captureException(error);
  console.error("Uncaught exception:", error);
  await flush(2000);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  captureException(error);
  console.error("Unhandled rejection:", error);
});

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ForksdClient } from "@forks-sh/ws-client";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";

let forksdClient: ForksdClient | null = null;

const connectToForksd = async () => {
  const token = await getOrCreateAuthToken();
  const wsUrl = getForksdBaseUrl().replace("http", "ws");

  forksdClient = new ForksdClient({
    url: wsUrl,
    token,
    autoReconnect: true,
    onTokenInvalid: async () => {
      await ensureForksdRunning();
      return await getOrCreateAuthToken();
    },
  });

  forksdClient.on("error", (err) => console.error("[forksd] ws error", err));

  await forksdClient.connect();
};

const FORKSD_PORT = Number(process.env.FORKSD_PORT ?? 38_765);
const FORKSD_BIND = process.env.FORKSD_BIND ?? "127.0.0.1";
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const authFileName = "forksd.auth";

const getForksdBaseUrl = () => {
  const host = FORKSD_BIND.includes(":") ? `[${FORKSD_BIND}]` : FORKSD_BIND;
  return `http://${host}:${FORKSD_PORT}`;
};

const getAuthFilePath = () =>
  join(app.getPath("userData"), "forksd", authFileName);

const encryptToken = (token: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return token;
  }
  return safeStorage.encryptString(token).toString("base64");
};

const decryptToken = (payload: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return payload;
  }
  return safeStorage.decryptString(Buffer.from(payload, "base64"));
};

const readStoredToken = async () => {
  try {
    const stored = await readFile(getAuthFilePath(), "utf8");
    if (!stored) {
      return null;
    }
    return decryptToken(stored.trim());
  } catch {
    return null;
  }
};

const storeToken = async (token: string) => {
  const tokenPath = getAuthFilePath();
  await mkdir(join(app.getPath("userData"), "forksd"), { recursive: true });
  await writeFile(tokenPath, encryptToken(token), { mode: 0o600 });
};

const generateToken = () => randomBytes(32).toString("base64url");

const ALLOWED_AUTH_HOSTS = new Set([
  "auth0.openai.com",
  "auth.openai.com",
  "platform.openai.com",
  "chat.openai.com",
]);

const isValidAuthUrl = (urlString: string): boolean => {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") {
      return false;
    }
    return ALLOWED_AUTH_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

const safeOpenExternal = async (urlString: string): Promise<boolean> => {
  if (!isValidAuthUrl(urlString)) {
    // URL validation failed - host not in allowlist
    return false;
  }
  await shell.openExternal(urlString);
  return true;
};

const getOrCreateAuthToken = async () => {
  const existing = await readStoredToken();
  if (existing) {
    return existing;
  }
  const token = generateToken();
  await storeToken(token);
  return token;
};

const rotateAuthToken = async () => {
  const token = generateToken();
  await storeToken(token);
  return token;
};

const fetchHealth = async (token: string) => {
  try {
    const response = await fetch(`${getForksdBaseUrl()}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;
      return { ok: false, status: response.status, code: body?.code };
    }
    return { ok: true as const };
  } catch {
    return { ok: false, status: 0 };
  }
};

const spawnForksd = (token: string) => {
  if (!isDev) {
    return;
  }
  const forksdDir = join(app.getAppPath(), "..", "forksd");
  const child = spawn("bun", ["run", "dev"], {
    cwd: forksdDir,
    env: {
      ...process.env,
      FORKSD_AUTH_TOKEN: token,
      FORKSD_BIND,
      FORKSD_PORT: String(FORKSD_PORT),
    },
    stdio: "inherit",
  });
  child.unref();
};

const ensureForksdRunning = async () => {
  let token = await getOrCreateAuthToken();
  let status = await fetchHealth(token);
  if (status.ok) {
    return;
  }
  if (status.status === 401 || status.code === "auth_invalid") {
    token = await rotateAuthToken();
    status = await fetchHealth(token);
  }
  if (!status.ok) {
    spawnForksd(token);
  }
};

interface CodexLoginRequest {
  type: "apiKey" | "chatgpt";
  apiKey?: string;
}

type CodexLoginResult =
  | { ok: true; type: "apiKey" }
  | { ok: true; type: "chatgpt"; loginId: string; authUrl: string }
  | { ok: false; error: string };

const startCodexLogin = async (
  request: CodexLoginRequest
): Promise<CodexLoginResult> => {
  const token = await getOrCreateAuthToken();
  const response = await fetch(`${getForksdBaseUrl()}/codex/auth/login`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    return { ok: false, error: body.error ?? "login_failed" };
  }

  const result = (await response.json()) as {
    ok: boolean;
    type?: "apiKey" | "chatgpt";
    loginId?: string;
    authUrl?: string;
    error?: string;
  };

  if (!(result.ok && result.type)) {
    return { ok: false, error: result.error ?? "login_failed" };
  }

  if (result.type === "chatgpt") {
    if (!result.authUrl) {
      return { ok: false, error: "missing_auth_url" };
    }
    const opened = await safeOpenExternal(result.authUrl);
    if (!opened) {
      return { ok: false, error: "invalid_auth_url" };
    }
    return {
      ok: true,
      type: "chatgpt",
      loginId: result.loginId ?? "",
      authUrl: result.authUrl,
    };
  }

  if (result.type === "apiKey") {
    return { ok: true, type: "apiKey" };
  }

  return { ok: false, error: "unknown_login_type" };
};

const isValidCodexLoginRequest = (
  request: unknown
): request is CodexLoginRequest => {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const req = request as Record<string, unknown>;
  return req.type === "apiKey" || req.type === "chatgpt";
};

const setupIpcHandlers = () => {
  ipcMain.handle("codex:start-login", async (_event, request: unknown) => {
    if (!isValidCodexLoginRequest(request)) {
      return { ok: false, error: "invalid_request" } satisfies CodexLoginResult;
    }
    return await startCodexLogin(request);
  });
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  }
};

app.whenReady().then(async () => {
  setupIpcHandlers();
  await ensureForksdRunning();
  try {
    await connectToForksd();
  } catch (err) {
    console.error("[forksd] initial connection failed, will retry:", err);
  }
  createWindow();
});
app.on("before-quit", () => {
  forksdClient?.disconnect();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
