/**
 * Electron main process.
 * - Spawns forksd on app start if not running (dev: connect to localhost:38765/health; if fail, spawn bun run dev in apps/forksd).
 * - Connects to forksd via localhost HTTP/WS.
 * - Renderer: Threads → Forks → Tasks + terminal panes.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, safeStorage, shell } from "electron";

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

const startWorkosAuthFlow = async () => {
  if (
    process.env.FORKSD_WORKOS_AUTO_LOGIN !== "1" ||
    !process.env.WORKOS_API_KEY ||
    !process.env.WORKOS_CLIENT_ID
  ) {
    return;
  }
  const token = await getOrCreateAuthToken();
  const response = await fetch(`${getForksdBaseUrl()}/auth/start`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    return;
  }
  const body = (await response.json()) as { authorizationUrl?: string };
  if (!body.authorizationUrl) {
    return;
  }
  await shell.openExternal(body.authorizationUrl);

  // Use exponential backoff with jitter to avoid thundering herd
  const MAX_ATTEMPTS = 30;
  const INITIAL_DELAY_MS = 500;
  const MAX_DELAY_MS = 5000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const delay = Math.min(
      INITIAL_DELAY_MS * 2 ** attempt + Math.random() * 100,
      MAX_DELAY_MS
    );
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      const me = await fetch(`${getForksdBaseUrl()}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000), // 5s timeout per request
      });
      if (!me.ok) {
        continue;
      }
      const data = (await me.json()) as { user?: unknown | null };
      if (data.user) {
        return;
      }
    } catch {
      // Ignore errors during polling - continue to next attempt
    }
  }
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    // __dirname = out/main when built
    win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  }

  // forksd is ensured before window creation
}

app.whenReady().then(async () => {
  await ensureForksdRunning();
  createWindow();
  startWorkosAuthFlow().catch(() => {
    // Ignore errors - auth flow is non-critical
  });
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
