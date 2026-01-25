/**
 * Electron main process.
 * - Spawns forksd on app start if not running (dev: connect to localhost:38765/health; if fail, spawn bun run dev in apps/forksd).
 * - Connects to forksd via localhost HTTP/WS.
 * - Renderer: Threads → Forks → Tasks + terminal panes.
 */

import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const _FORKSD_PORT = 38_765;
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

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

  // TODO: ensure forksd is running (fetch http://localhost:38765/health; on failure spawn forksd)
}

app.whenReady().then(createWindow);
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
