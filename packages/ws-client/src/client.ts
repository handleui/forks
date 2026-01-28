import { EventEmitter } from "node:events";
import type {
  AgentEvent,
  CodexEvent,
  PtyServerEvent,
} from "@forks-sh/protocol";
import { WebSocket } from "ws";
import type { ForksdClientEvents, ForksdClientState } from "./types.js";

export interface ForksdClientOptions {
  /** WebSocket URL (ws:// or wss://) */
  url: string;
  /** Authentication token */
  token: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts before giving up (default: MAX_RECONNECT_ATTEMPTS = 10) */
  maxReconnectAttempts?: number;
  /** Callback for token refresh on auth failure during reconnect */
  onTokenInvalid?: () => Promise<string>;
}

interface TypedEventEmitter<T> {
  on<K extends keyof T>(event: K, listener: T[K]): TypedEventEmitter<T>;
  off<K extends keyof T>(event: K, listener: T[K]): TypedEventEmitter<T>;
  emit<K extends keyof T>(
    event: K,
    // biome-ignore lint/suspicious/noExplicitAny: required for type inference in conditional
    ...args: T[K] extends (...args: infer A) => any ? A : never
  ): boolean;
  once<K extends keyof T>(event: K, listener: T[K]): TypedEventEmitter<T>;
  removeAllListeners<K extends keyof T>(event?: K): TypedEventEmitter<T>;
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16_000, 30_000];
const PING_INTERVAL_MS = 30_000;
// Server sends native ping every 30s with 10s pong timeout; add latency buffer
const PING_TIMEOUT_MS = 35_000;
const MAX_RECONNECT_ATTEMPTS = 10;

// biome-ignore lint/suspicious/noExplicitAny: EventEmitter typing workaround
export class ForksdClient extends (EventEmitter as any as new () => TypedEventEmitter<ForksdClientEvents>) {
  private ws: WebSocket | null = null;
  private _state: ForksdClientState = "disconnected";
  private reconnectAttempt = 0;
  private authFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private token: string;

  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly onTokenInvalid?: () => Promise<string>;

  constructor(opts: ForksdClientOptions) {
    super();
    this.url = opts.url;
    this.token = opts.token;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.maxReconnectAttempts =
      opts.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
    this.onTokenInvalid = opts.onTokenInvalid;
  }

  get state(): ForksdClientState {
    return this._state;
  }

  private setState(newState: ForksdClientState) {
    if (this._state !== newState) {
      this._state = newState;
      this.emit("stateChange", newState);
    }
  }

  connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") {
      return Promise.resolve();
    }

    this.intentionalClose = false;
    this.setState("connecting");

    return new Promise((resolve, reject) => {
      // The "forksd" subprotocol identifies our protocol version.
      // Token is passed via Authorization header (server's primary auth method).
      // Browser clients would need to use the token.{token} subprotocol as a
      // fallback since browsers don't support custom WebSocket headers.
      this.ws = new WebSocket(this.url, ["forksd"], {
        headers: { Authorization: `Bearer ${this.token}` },
      });

      const onOpen = () => {
        cleanup();
        this.handleOpen();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        this.handleError(err);
        reject(err);
      };

      const onClose = (code: number, reason: Buffer) => {
        cleanup();
        if (code === 1008 || code === 4001) {
          reject(new Error(`Authentication failed: ${reason.toString()}`));
        } else {
          reject(new Error(`Connection closed: ${code} ${reason.toString()}`));
        }
      };

      const cleanup = () => {
        this.ws?.off("open", onOpen);
        this.ws?.off("error", onError);
        this.ws?.off("close", onClose);
      };

      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
      this.ws.once("close", onClose);
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.setState("disconnected");
    this.emit("disconnected", "intentional");
  }

  /** Reset reconnection counter to allow reconnection after max attempts reached */
  resetReconnection(): void {
    this.reconnectAttempt = 0;
    this.authFailures = 0;
  }

  ptyAttach(id: string): void {
    this.send({ type: "pty:attach", id });
  }

  ptyDetach(id: string): void {
    this.send({ type: "pty:detach", id });
  }

  // PTY session authorization is enforced server-side via ptyManager attachment checks
  ptyInput(id: string, data: string): void {
    this.send({ type: "pty:input", id, data });
  }

  ptyResize(id: string, cols: number, rows: number): void {
    this.send({ type: "pty:resize", id, cols, rows });
  }

  private send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleOpen(): void {
    this.reconnectAttempt = 0;
    this.authFailures = 0;
    this.setState("connected");
    this.emit("connected");
    this.setupListeners();
    this.startPing();
  }

  private setupListeners(): void {
    if (!this.ws) {
      return;
    }

    this.ws.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type: string;
          event?: unknown;
          id?: string;
          data?: string;
          history?: string;
          exitCode?: number;
          error?: string;
        };
        this.handleMessage(message);
      } catch {
        // Ignore parse errors
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.handleClose(code, reason.toString());
    });

    this.ws.on("error", (err: Error) => {
      this.handleError(err);
    });

    // Handle native WebSocket ping frames from server (RFC 6455 heartbeat)
    // The ws library automatically responds with pong (autoPong: true by default)
    // We use this to detect that server is alive and reset our timeout
    this.ws.on("ping", () => {
      this.resetPingTimeout();
    });
  }

  private resetPingTimeout(): void {
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer);
    }
    this.pingTimeoutTimer = setTimeout(() => {
      // Server unresponsive, use terminate() for immediate cleanup
      // per ws library best practices (vs close() which waits for close handshake)
      if (this.ws) {
        this.ws.terminate();
      }
    }, PING_TIMEOUT_MS);
  }

  private handleMessage(message: {
    type: string;
    event?: unknown;
    id?: string;
    data?: string;
    history?: string;
    exitCode?: number;
    error?: string;
  }): void {
    switch (message.type) {
      case "pong":
        this.resetPingTimeout();
        break;
      case "codex":
        this.emit("codex", message.event as CodexEvent);
        break;
      case "agent":
        this.emit("agent", message.event as AgentEvent);
        break;
      case "pty:output":
        this.emit("pty", {
          type: "pty:output",
          id: message.id ?? "",
          data: message.data ?? "",
        } as PtyServerEvent);
        break;
      case "pty:attached":
        this.emit("pty", {
          type: "pty:attached",
          id: message.id ?? "",
          history: message.history,
        } as PtyServerEvent);
        break;
      case "pty:exit":
        this.emit("pty", {
          type: "pty:exit",
          id: message.id ?? "",
          exitCode: message.exitCode ?? 0,
        } as PtyServerEvent);
        break;
      case "pty:error":
        this.emit("pty", {
          type: "pty:error",
          id: message.id ?? "",
          error: message.error ?? "unknown error",
        } as PtyServerEvent);
        break;
      default:
        break;
    }
  }

  private handleClose(code: number, reason: string): void {
    this.cleanup();

    if (this.intentionalClose) {
      return;
    }

    if (code === 1008 || code === 4001) {
      this.authFailures++;
    }

    this.emit("disconnected", `${code}: ${reason}`);

    if (this.autoReconnect) {
      this.scheduleReconnect();
    } else {
      this.setState("disconnected");
    }
  }

  private handleError(err: Error): void {
    this.emit("error", err);
  }

  private async scheduleReconnect(): Promise<void> {
    // Prevent concurrent reconnection attempts
    if (this._state === "reconnecting" && this.reconnectTimer) {
      return;
    }

    // Check max reconnection attempts
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.setState("disconnected");
      this.emit(
        "error",
        new Error(
          `Max reconnection attempts (${this.maxReconnectAttempts}) reached`
        )
      );
      return;
    }

    this.setState("reconnecting");

    if (this.authFailures >= 3 && this.onTokenInvalid) {
      try {
        this.token = await this.onTokenInvalid();
        this.authFailures = 0;
        this.reconnectAttempt = 0;
      } catch {
        this.emit("error", new Error("Token refresh failed"));
      }
    }

    const delayIndex = Math.min(
      this.reconnectAttempt,
      RECONNECT_DELAYS.length - 1
    );
    // RECONNECT_DELAYS is a const array with known values, so index access is safe
    const baseDelay = RECONNECT_DELAYS[delayIndex] as number;
    // Add jitter (0-50% of base delay) to prevent thundering herd
    const jitter = Math.random() * baseDelay * 0.5;
    const delay = Math.floor(baseDelay + jitter);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        if (this.autoReconnect && !this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private startPing(): void {
    // Clear any existing ping timer to prevent duplicates
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    // Start ping timeout on connection open
    this.resetPingTimeout();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
