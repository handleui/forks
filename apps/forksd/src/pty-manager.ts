/**
 * PTY session manager.
 * Manages PTY lifecycle, WebSocket subscriptions, and output buffering.
 *
 * Performance features:
 * - Output batching: High-frequency PTY output is batched before sending
 * - Backpressure: Monitors WebSocket buffer and drops output when full
 * - Efficient fan-out: Single JSON serialization per message to all subscribers
 */

import type {
  PtyAttachedEvent,
  PtyErrorEvent,
  PtyExitEvent,
  PtyOutputEvent,
  PtyServerEvent as PtyServerEventType,
} from "@forks-sh/protocol";

export type { PtyServerEvent } from "@forks-sh/protocol";

// Local alias for internal use
type PtyServerEvent = PtyServerEventType;

import type { IPty } from "node-pty";
import type { WebSocket } from "ws";
import { createPtyHistory, type PtyHistory } from "./pty-history.js";

/** Batching interval for high-frequency output (ms) */
const OUTPUT_BATCH_INTERVAL_MS = 16; // ~60fps
/** Max batch size before forcing flush */
const OUTPUT_BATCH_MAX_SIZE = 8 * 1024; // 8KB
/** WebSocket buffer threshold for backpressure (bytes) */
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024; // 64KB
/** Inactivity timeout for background agent terminals (ms) */
const BACKGROUND_TERMINAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Terminal size limits to prevent abuse */
const MIN_TERMINAL_COLS = 1;
const MAX_TERMINAL_COLS = 500;
const MIN_TERMINAL_ROWS = 1;
const MAX_TERMINAL_ROWS = 200;
/** Maximum input data size per write (bytes) */
const MAX_WRITE_SIZE = 64 * 1024; // 64KB

/** Session metadata for tracking ownership and visibility */
export interface TerminalSession {
  id: string;
  cwd: string;
  owner: "user" | "agent";
  visible: boolean;
  createdAt: number;
  command?: string[];
}

/** Disposable interface for event handlers */
interface IDisposable {
  dispose(): void;
}

/** Output batcher for high-frequency PTY data */
interface OutputBatcher {
  chunks: string[];
  totalSize: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Internal PTY session state */
interface PtySession {
  pty: IPty;
  history: PtyHistory;
  metadata: TerminalSession;
  subscribers: Set<WebSocket>;
  exitCode: number | null;
  /** Disposables for PTY event handlers */
  disposables: IDisposable[];
  /** Output batcher for coalescing rapid output */
  batcher: OutputBatcher;
  /** Timeout ID for background agent terminal inactivity cleanup */
  inactivityTimeoutId?: ReturnType<typeof setTimeout>;
  /** Callback fired when terminal exits, before exit message is sent */
  onClose?: (session: TerminalSession, exitCode: number) => void;
}

export interface PtyManager {
  /** Register a new PTY session */
  register: (
    id: string,
    pty: IPty,
    cwd: string,
    opts?: {
      owner?: "user" | "agent";
      visible?: boolean;
      command?: string[];
      onClose?: (session: TerminalSession, exitCode: number) => void;
    }
  ) => void;

  /** Unregister a PTY session */
  unregister: (id: string) => void;

  /** Subscribe a WebSocket to PTY output */
  attach: (id: string, ws: WebSocket) => boolean;

  /** Unsubscribe a WebSocket from PTY output */
  detach: (id: string, ws: WebSocket) => void;

  /** Unsubscribe a WebSocket from all PTY sessions */
  detachAll: (ws: WebSocket) => void;

  /** Send input to a PTY */
  write: (id: string, data: string) => boolean;

  /** Resize a PTY */
  resize: (id: string, cols: number, rows: number) => boolean;

  /** Get the output history for a PTY */
  getHistory: (id: string) => string | null;

  /** Get session metadata */
  getMetadata: (id: string) => TerminalSession | null;

  /** List all session IDs */
  list: () => string[];

  /** List all sessions with metadata */
  listWithMetadata: () => TerminalSession[];

  /** Check if a session exists */
  has: (id: string) => boolean;

  /** Get exit code for a session (null if still running) */
  getExitCode: (id: string) => number | null;

  /** Update session visibility (promote background to visible) */
  setVisible: (id: string, visible: boolean) => boolean;

  /** Gracefully shutdown all PTY sessions (SIGTERM, wait, SIGKILL) */
  shutdownAll: () => Promise<void>;
}

/** Message types - re-exported from @forks-sh/protocol for local naming */
export type PtyOutputMessage = PtyOutputEvent;
export type PtyExitMessage = PtyExitEvent;
export type PtyAttachedMessage = PtyAttachedEvent;
export type PtyErrorMessage = PtyErrorEvent;

/**
 * Check if WebSocket has backpressure (buffer too full).
 * Returns true if we should skip sending to this socket.
 */
const hasBackpressure = (ws: WebSocket): boolean =>
  ws.bufferedAmount > WS_BACKPRESSURE_THRESHOLD;

/**
 * Send a message to a WebSocket, skipping if backpressure is detected.
 * Returns true if message was sent, false if skipped.
 */
const sendToWs = (
  ws: WebSocket,
  message: PtyServerEvent,
  skipBackpressureCheck = false
): boolean => {
  if (ws.readyState !== ws.OPEN) {
    return false;
  }
  // Skip output messages during backpressure (data will still be in history)
  if (
    !skipBackpressureCheck &&
    message.type === "pty:output" &&
    hasBackpressure(ws)
  ) {
    return false;
  }
  ws.send(JSON.stringify(message), (err) => {
    if (err) {
      // Connection closed or errored - will be cleaned up on close event
    }
  });
  return true;
};

/**
 * Send a pre-serialized message to a WebSocket for efficient fan-out.
 * Avoids repeated JSON.stringify() when sending to multiple subscribers.
 */
const sendSerializedToWs = (
  ws: WebSocket,
  serialized: string,
  checkBackpressure: boolean
): boolean => {
  if (ws.readyState !== ws.OPEN) {
    return false;
  }
  if (checkBackpressure && hasBackpressure(ws)) {
    return false;
  }
  ws.send(serialized, (err) => {
    if (err) {
      // Connection closed or errored - will be cleaned up on close event
    }
  });
  return true;
};

/** Safely dispose all disposables, ignoring errors */
const disposeAll = (disposables: IDisposable[]): void => {
  for (const d of disposables) {
    try {
      d.dispose();
    } catch {
      // Ignore disposal errors
    }
  }
};

export const createPtyManager = (): PtyManager => {
  const sessions = new Map<string, PtySession>();
  // Track which sessions each WebSocket is subscribed to
  const wsToSessions = new Map<WebSocket, Set<string>>();

  /**
   * Schedule inactivity timeout for background agent terminals.
   * Only applies when owner="agent" and visible=false.
   * Resets on any PTY activity (input or output).
   */
  const scheduleTimeout = (id: string, session: PtySession): void => {
    if (session.inactivityTimeoutId) {
      clearTimeout(session.inactivityTimeoutId);
      session.inactivityTimeoutId = undefined;
    }
    if (session.metadata.owner === "agent" && !session.metadata.visible) {
      session.inactivityTimeoutId = setTimeout(() => {
        unregister(id);
      }, BACKGROUND_TERMINAL_TIMEOUT_MS);
    }
  };

  const register: PtyManager["register"] = (id, pty, cwd, opts = {}) => {
    const history = createPtyHistory();
    const metadata: TerminalSession = {
      id,
      cwd,
      owner: opts.owner ?? "user",
      visible: opts.visible ?? true,
      createdAt: Date.now(),
      command: opts.command,
    };

    const batcher: OutputBatcher = {
      chunks: [],
      totalSize: 0,
      timer: null,
    };

    const session: PtySession = {
      pty,
      history,
      metadata,
      subscribers: new Set(),
      exitCode: null,
      disposables: [],
      batcher,
      onClose: opts.onClose,
    };

    sessions.set(id, session);

    // Start inactivity timeout for background agent terminals
    scheduleTimeout(id, session);

    /**
     * Flush batched output to all subscribers.
     * Combines multiple small data chunks into a single message.
     * Pre-serializes once for efficient fan-out to all subscribers.
     */
    const flushBatch = () => {
      if (batcher.timer) {
        clearTimeout(batcher.timer);
        batcher.timer = null;
      }
      if (batcher.chunks.length === 0) {
        return;
      }

      // Combine all chunks into single data payload
      const data =
        batcher.chunks.length === 1
          ? (batcher.chunks[0] ?? "")
          : batcher.chunks.join("");

      // Reset batch state before sending (to allow new data during send)
      // Use length = 0 instead of new array to avoid allocation
      batcher.chunks.length = 0;
      batcher.totalSize = 0;

      // Pre-serialize once for all subscribers (fan-out optimization)
      const message: PtyOutputMessage = {
        type: "pty:output",
        id,
        data,
      };
      const serialized = JSON.stringify(message);

      for (const ws of session.subscribers) {
        sendSerializedToWs(ws, serialized, true);
      }
    };

    // Wire up PTY events and store disposables for cleanup
    const dataDisposable = pty.onData((data: string) => {
      // Always append to history immediately
      history.append(data);

      // Reset inactivity timeout on output
      scheduleTimeout(id, session);

      // Batch output for WebSocket delivery
      batcher.chunks.push(data);
      batcher.totalSize += data.length;

      // Flush immediately if batch is large enough
      if (batcher.totalSize >= OUTPUT_BATCH_MAX_SIZE) {
        flushBatch();
        return;
      }

      // Otherwise schedule a flush if not already pending
      if (!batcher.timer) {
        batcher.timer = setTimeout(flushBatch, OUTPUT_BATCH_INTERVAL_MS);
      }
    });
    session.disposables.push(dataDisposable);

    const exitDisposable = pty.onExit(({ exitCode }) => {
      // Flush any pending output before sending exit
      flushBatch();

      session.exitCode = exitCode;

      // Emit closed event callback before notifying subscribers
      if (session.onClose) {
        session.onClose({ ...session.metadata }, exitCode);
      }

      const message: PtyExitMessage = {
        type: "pty:exit",
        id,
        exitCode,
      };
      // Pre-serialize for fan-out (skip backpressure check for exit messages)
      const serialized = JSON.stringify(message);
      for (const ws of session.subscribers) {
        sendSerializedToWs(ws, serialized, false);
      }
    });
    session.disposables.push(exitDisposable);
  };

  const unregister: PtyManager["unregister"] = (id) => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }

    // Clear inactivity timeout
    if (session.inactivityTimeoutId) {
      clearTimeout(session.inactivityTimeoutId);
      session.inactivityTimeoutId = undefined;
    }

    // Notify subscribers and clean up mappings
    // Only send exit message for forced termination (natural exits handled by exitDisposable)
    const forcedKill = session.exitCode === null;
    // Pre-serialize once for fan-out
    const serialized = forcedKill
      ? JSON.stringify({ type: "pty:exit", id, exitCode: -1 } as PtyExitMessage)
      : null;
    for (const ws of session.subscribers) {
      if (serialized) {
        sendSerializedToWs(ws, serialized, false);
      }
      wsToSessions.get(ws)?.delete(id);
    }
    if (forcedKill) {
      try {
        session.pty.kill();
      } catch {
        // Already dead
      }
    }

    // Clear batcher timer to prevent dangling timeout
    if (session.batcher.timer) {
      clearTimeout(session.batcher.timer);
      session.batcher.timer = null;
    }
    // Clear chunks array in-place to avoid allocation
    session.batcher.chunks.length = 0;
    session.batcher.totalSize = 0;

    // Dispose event handlers to prevent memory leaks
    disposeAll(session.disposables);
    session.disposables.length = 0;

    // Clear history buffer to aid garbage collection
    session.history.clear();

    sessions.delete(id);
  };

  const attach: PtyManager["attach"] = (id, ws) => {
    const session = sessions.get(id);
    if (!session) {
      const message: PtyErrorMessage = {
        type: "pty:error",
        id,
        error: "Session not found",
      };
      sendToWs(ws, message);
      return false;
    }

    session.subscribers.add(ws);

    // Track reverse mapping for cleanup
    let wsSessions = wsToSessions.get(ws);
    if (!wsSessions) {
      wsSessions = new Set();
      wsToSessions.set(ws, wsSessions);
    }
    wsSessions.add(id);

    // Send current history to newly attached client
    const history = session.history.get();
    const message: PtyAttachedMessage = {
      type: "pty:attached",
      id,
      history: history.length > 0 ? history : undefined,
    };
    sendToWs(ws, message);

    return true;
  };

  const detach: PtyManager["detach"] = (id, ws) => {
    const session = sessions.get(id);
    if (session) {
      session.subscribers.delete(ws);
    }
    wsToSessions.get(ws)?.delete(id);
  };

  const detachAll: PtyManager["detachAll"] = (ws) => {
    const sessionIds = wsToSessions.get(ws);
    if (sessionIds) {
      for (const id of sessionIds) {
        const session = sessions.get(id);
        if (session) {
          session.subscribers.delete(ws);
        }
      }
      wsToSessions.delete(ws);
    }
  };

  const write: PtyManager["write"] = (id, data) => {
    const session = sessions.get(id);
    if (!session || session.exitCode !== null) {
      return false;
    }
    // Limit input size to prevent memory issues
    if (data.length > MAX_WRITE_SIZE) {
      return false;
    }
    // Reset inactivity timeout on input
    scheduleTimeout(id, session);
    session.pty.write(data);
    return true;
  };

  const resize: PtyManager["resize"] = (id, cols, rows) => {
    const session = sessions.get(id);
    if (!session || session.exitCode !== null) {
      return false;
    }
    // Validate terminal dimensions to prevent abuse
    const safeCols = Math.max(
      MIN_TERMINAL_COLS,
      Math.min(MAX_TERMINAL_COLS, Math.floor(cols))
    );
    const safeRows = Math.max(
      MIN_TERMINAL_ROWS,
      Math.min(MAX_TERMINAL_ROWS, Math.floor(rows))
    );
    session.pty.resize(safeCols, safeRows);
    return true;
  };

  const getHistory: PtyManager["getHistory"] = (id) => {
    const session = sessions.get(id);
    if (!session) {
      return null;
    }
    return session.history.get();
  };

  const getMetadata: PtyManager["getMetadata"] = (id) => {
    const session = sessions.get(id);
    if (!session) {
      return null;
    }
    return { ...session.metadata };
  };

  const list: PtyManager["list"] = () => [...sessions.keys()];

  const listWithMetadata: PtyManager["listWithMetadata"] = () =>
    [...sessions.values()].map((s) => ({ ...s.metadata }));

  const has: PtyManager["has"] = (id) => sessions.has(id);

  const getExitCode: PtyManager["getExitCode"] = (id) => {
    const session = sessions.get(id);
    return session?.exitCode ?? null;
  };

  const setVisible: PtyManager["setVisible"] = (id, visible) => {
    const session = sessions.get(id);
    if (!session) {
      return false;
    }
    session.metadata.visible = visible;

    // Transfer ownership when promoting to visible - agent loses kill authority
    if (visible && session.metadata.owner === "agent") {
      session.metadata.owner = "user";
    }

    // Clear inactivity timeout when promoted to visible
    if (visible && session.inactivityTimeoutId) {
      clearTimeout(session.inactivityTimeoutId);
      session.inactivityTimeoutId = undefined;
    }
    return true;
  };

  const shutdownAll: PtyManager["shutdownAll"] = async () => {
    const ids = [...sessions.keys()];
    if (ids.length === 0) {
      return;
    }

    const isWindows = process.platform === "win32";
    const exited = new Set<string>();

    const waitForExit = (id: string): Promise<void> =>
      new Promise((resolve) => {
        const session = sessions.get(id);
        if (!session || session.exitCode !== null) {
          exited.add(id);
          resolve();
          return;
        }
        const handler = session.pty.onExit(() => {
          exited.add(id);
          handler.dispose();
          resolve();
        });
      });

    const requestGracefulExit = (id: string) => {
      const session = sessions.get(id);
      if (!session || session.exitCode !== null) {
        return;
      }
      try {
        if (isWindows) {
          // Windows doesn't support signals; send exit command for graceful shutdown.
          // Note: This assumes a shell is running. If another program is active
          // (vim, python REPL, etc.), this won't work - the 1s timeout will
          // trigger force kill via TerminateProcess.
          session.pty.write("exit\r");
        } else {
          session.pty.kill("SIGTERM");
        }
      } catch {
        exited.add(id);
      }
    };

    const forceKill = (id: string) => {
      if (exited.has(id)) {
        return;
      }
      try {
        // On Windows, kill() without signal uses TerminateProcess (force kill)
        // On Unix, SIGKILL forces immediate termination
        if (isWindows) {
          sessions.get(id)?.pty.kill();
        } else {
          sessions.get(id)?.pty.kill("SIGKILL");
        }
      } catch {
        // Already dead
      }
    };

    const exitPromises = ids.map(waitForExit);
    for (const id of ids) {
      requestGracefulExit(id);
    }

    await Promise.race([
      Promise.all(exitPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);

    for (const id of ids) {
      forceKill(id);
    }
    for (const id of ids) {
      unregister(id);
    }
  };

  return {
    register,
    unregister,
    attach,
    detach,
    detachAll,
    write,
    resize,
    getHistory,
    getMetadata,
    list,
    listWithMetadata,
    has,
    getExitCode,
    setVisible,
    shutdownAll,
  };
};
