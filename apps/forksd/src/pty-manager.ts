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
      batcher.chunks = [];
      batcher.totalSize = 0;

      const message: PtyOutputMessage = {
        type: "pty:output",
        id,
        data,
      };

      for (const ws of session.subscribers) {
        sendToWs(ws, message);
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
      for (const ws of session.subscribers) {
        // Force send exit message even during backpressure
        sendToWs(ws, message, true);
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

    // Notify subscribers
    const exitCode = session.exitCode ?? -1;
    const message: PtyExitMessage = {
      type: "pty:exit",
      id,
      exitCode,
    };
    for (const ws of session.subscribers) {
      sendToWs(ws, message);
      // Remove from reverse mapping
      wsToSessions.get(ws)?.delete(id);
    }

    // Clear batcher timer to prevent dangling timeout
    if (session.batcher.timer) {
      clearTimeout(session.batcher.timer);
      session.batcher.timer = null;
    }
    session.batcher.chunks = [];
    session.batcher.totalSize = 0;

    // Dispose event handlers to prevent memory leaks
    for (const disposable of session.disposables) {
      try {
        disposable.dispose();
      } catch {
        // Ignore disposal errors
      }
    }
    session.disposables.length = 0;

    // Clear history buffer to aid garbage collection
    session.history.clear();

    // Kill the PTY if still running
    if (session.exitCode === null) {
      try {
        session.pty.kill();
      } catch {
        // Already dead
      }
    }

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
    session.pty.resize(cols, rows);
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
  };
};
