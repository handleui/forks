import { EventEmitter } from "node:events";
import type {
  AgentEvent,
  CodexEvent,
  PtyServerEvent,
} from "@forks-sh/protocol";
import { WebSocket } from "ws";
import type { ForksdClientEvents, ForksdClientState } from "./types.js";

// Detect browser environment - this client is designed for Node.js only.
// Browser WebSocket API doesn't support custom headers for authentication, and alternative
// approaches (subprotocols, URL params) have security implications (token exposure).
const isBrowser =
  typeof window !== "undefined" && typeof window.WebSocket !== "undefined";

// WebSocket readyState constants
const WS_OPEN = 1;
const WS_CONNECTING = 0;

export interface ForksdClientOptions {
  /** WebSocket URL (ws:// or wss://) */
  url: string;
  /** Authentication token */
  token: string;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts before giving up (default: MAX_RECONNECT_ATTEMPTS = 10) */
  maxReconnectAttempts?: number;
  /** Connection timeout in milliseconds (default: CONNECTION_TIMEOUT_MS = 30000) */
  connectionTimeout?: number;
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
const MAX_TOKEN_REFRESH_ATTEMPTS = 3;
const CONNECTION_TIMEOUT_MS = 30_000;

const WS_URL_REGEX = /^wss?:\/\/.+/;

/** Error thrown when attempting to send a message while WebSocket is not connected */
export class WebSocketNotReadyError extends Error {
  readonly state: ForksdClientState;

  constructor(state: ForksdClientState) {
    super(`WebSocket is not ready (state: ${state})`);
    this.name = "WebSocketNotReadyError";
    this.state = state;
  }
}

/** Error thrown when attempting to use this client in a browser environment */
export class BrowserNotSupportedError extends Error {
  constructor() {
    super(
      "ForksdClient is not supported in browser environments. " +
        "This client is designed for Node.js only. " +
        "Browser WebSocket API does not support custom headers for secure authentication."
    );
    this.name = "BrowserNotSupportedError";
  }
}

// biome-ignore lint/suspicious/noExplicitAny: EventEmitter typing workaround
export class ForksdClient extends (EventEmitter as any as new () => TypedEventEmitter<ForksdClientEvents>) {
  private ws: WebSocket | null = null;
  private _state: ForksdClientState = "disconnected";
  private reconnectAttempt = 0;
  private authFailures = 0;
  private tokenRefreshAttempts = 0;
  private tokenRefreshExhausted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingConnect: Promise<void> | null = null;
  private intentionalClose = false;
  private token: string;

  private readonly url: string;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly connectionTimeout: number;
  private readonly onTokenInvalid?: () => Promise<string>;

  constructor(opts: ForksdClientOptions) {
    super();

    // Validate WebSocket URL format
    if (!WS_URL_REGEX.test(opts.url)) {
      throw new Error(
        `Invalid WebSocket URL: "${opts.url}". URL must start with ws:// or wss://`
      );
    }

    // Validate maxReconnectAttempts if provided
    if (
      opts.maxReconnectAttempts !== undefined &&
      (opts.maxReconnectAttempts < 0 ||
        !Number.isInteger(opts.maxReconnectAttempts))
    ) {
      throw new Error(
        `Invalid maxReconnectAttempts: ${opts.maxReconnectAttempts}. Must be a non-negative integer.`
      );
    }

    // Validate connectionTimeout if provided
    if (
      opts.connectionTimeout !== undefined &&
      (opts.connectionTimeout <= 0 || !Number.isFinite(opts.connectionTimeout))
    ) {
      throw new Error(
        `Invalid connectionTimeout: ${opts.connectionTimeout}. Must be a positive number.`
      );
    }

    this.url = opts.url;
    this.token = opts.token;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.maxReconnectAttempts =
      opts.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
    this.connectionTimeout = opts.connectionTimeout ?? CONNECTION_TIMEOUT_MS;
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
    // This client requires Node.js WebSocket (ws library) for secure authentication via headers.
    // Browser WebSocket API doesn't support custom headers, and workarounds like subprotocols
    // or URL parameters expose the token to client-side code and browser extensions.
    if (isBrowser) {
      return Promise.reject(new BrowserNotSupportedError());
    }

    if (this._state === "connected") {
      return Promise.resolve();
    }
    if (this._state === "connecting" && this.pendingConnect) {
      return this.pendingConnect;
    }

    this.intentionalClose = false;
    this.setState("connecting");

    this.pendingConnect = new Promise<void>((resolve, reject) => {
      // Connection timeout to prevent hanging indefinitely
      const timeoutId = setTimeout(() => {
        cleanup();
        if (this.ws) {
          this.ws.terminate();
          this.ws = null;
        }
        this.setState("disconnected");
        reject(
          new Error(`Connection timeout after ${this.connectionTimeout}ms`)
        );
      }, this.connectionTimeout);

      // The "forksd" subprotocol identifies our protocol version.
      // Token is passed via Authorization header (secure, not exposed to client-side code).
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
        const reasonStr = reason.toString();
        if (code === 1008 || code === 4001) {
          reject(new Error(`Authentication failed: ${reasonStr}`));
        } else {
          reject(new Error(`Connection closed: ${code} ${reasonStr}`));
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.ws?.off("open", onOpen);
        this.ws?.off("error", onError);
        this.ws?.off("close", onClose);
      };

      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
      this.ws.once("close", onClose);
    }).finally(() => {
      this.pendingConnect = null;
    });

    return this.pendingConnect;
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
    this.tokenRefreshAttempts = 0;
    this.tokenRefreshExhausted = false;
  }

  /**
   * Update the authentication token. Use this for proactive token refresh
   * (e.g., after user re-authentication) without waiting for auth failure.
   * The new token will be used for the next connection attempt.
   */
  updateToken(newToken: string): void {
    this.token = newToken;
    this.authFailures = 0;
    this.tokenRefreshAttempts = 0;
    this.tokenRefreshExhausted = false;
  }

  /**
   * Fully destroy the client, releasing all resources for garbage collection.
   * After calling destroy(), the client instance should not be reused.
   * Unlike disconnect(), this removes all event listeners.
   */
  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
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

  /**
   * Send a message to the server. Throws if WebSocket is not connected.
   * Use this for user-facing operations where the caller needs feedback on failure.
   */
  private send(message: unknown): void {
    if (this.ws?.readyState !== WS_OPEN) {
      throw new WebSocketNotReadyError(this._state);
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send a message silently, dropping it if WebSocket is not connected.
   * Use this for internal operations like ping where silent failure is acceptable.
   */
  private sendSilent(message: unknown): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleOpen(): void {
    this.reconnectAttempt = 0;
    this.authFailures = 0;
    this.tokenRefreshAttempts = 0;
    this.tokenRefreshExhausted = false;
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
      // Server unresponsive - use terminate() for immediate cleanup
      // per ws library best practices (vs close() which waits for close handshake)
      this.ws?.terminate();
    }, PING_TIMEOUT_MS);
    // Allow process to exit even with active ping timeout
    this.pingTimeoutTimer.unref?.();
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
    // Use OR to guard against both: (1) already in reconnecting state, or (2) timer already scheduled
    // This prevents race condition between setState("reconnecting") and setTimeout assignment
    if (this._state === "reconnecting" || this.reconnectTimer) {
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

    // Attempt token refresh if auth failures threshold reached and refresh not exhausted
    if (
      this.authFailures >= 3 &&
      this.onTokenInvalid &&
      !this.tokenRefreshExhausted
    ) {
      if (this.tokenRefreshAttempts >= MAX_TOKEN_REFRESH_ATTEMPTS) {
        // Max token refresh attempts reached - stop trying to refresh
        this.tokenRefreshExhausted = true;
        this.setState("disconnected");
        this.emit(
          "error",
          new Error(
            `Token refresh exhausted after ${MAX_TOKEN_REFRESH_ATTEMPTS} attempts. Manual intervention required.`
          )
        );
        return;
      }

      this.tokenRefreshAttempts++;
      try {
        this.token = await this.onTokenInvalid();
        // Token refresh succeeded - reset auth failures to try with new token
        // Keep tokenRefreshAttempts to track consecutive refresh cycles
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
      // Keep reconnectTimer non-null during the entire reconnection attempt to prevent
      // race conditions where a concurrent scheduleReconnect() call could pass the guard
      // before connect() completes. Clear it only after connect succeeds/fails.
      try {
        await this.connect();
        // Connect succeeded - clear timer reference
        this.reconnectTimer = null;
      } catch {
        // Connect failed - clear timer reference before potentially scheduling another
        this.reconnectTimer = null;
        if (this.autoReconnect && !this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
    // Allow process to exit even with active reconnect timer
    this.reconnectTimer.unref?.();
  }

  private startPing(): void {
    // Clear any existing ping timer to prevent duplicates
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    // Start ping timeout on connection open
    this.resetPingTimeout();
    this.pingTimer = setInterval(() => {
      // Use sendSilent for internal ping - if connection is lost, the timeout will handle it
      this.sendSilent({ type: "ping" });
    }, PING_INTERVAL_MS);
    // Allow process to exit even with active ping timer
    this.pingTimer.unref?.();
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
        this.ws.readyState === WS_OPEN ||
        this.ws.readyState === WS_CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }
}
