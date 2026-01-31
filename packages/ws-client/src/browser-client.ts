import type {
  AgentEvent,
  CodexEvent,
  PtyServerEvent,
} from "@forks-sh/protocol";
import type { ForksdClientEvents, ForksdClientState } from "./types.js";

const WS_OPEN = 1;
const WS_CONNECTING = 0;

export interface ForksdClientOptions {
  url: string;
  token: string;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  connectionTimeout?: number;
  onTokenInvalid?: () => Promise<string>;
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16_000, 30_000];
const PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_TOKEN_REFRESH_ATTEMPTS = 3;
const CONNECTION_TIMEOUT_MS = 30_000;
const WS_URL_REGEX = /^wss?:\/\/.+/;

export class WebSocketNotReadyError extends Error {
  readonly state: ForksdClientState;

  constructor(state: ForksdClientState) {
    super(`WebSocket is not ready (state: ${state})`);
    this.name = "WebSocketNotReadyError";
    this.state = state;
  }
}

export class BrowserNotSupportedError extends Error {
  constructor() {
    super("Browser WebSocket is not available in this environment.");
    this.name = "BrowserNotSupportedError";
  }
}

interface TypedEventEmitter<T> {
  on<K extends keyof T>(event: K, listener: T[K]): TypedEventEmitter<T>;
  off<K extends keyof T>(event: K, listener: T[K]): TypedEventEmitter<T>;
  emit<K extends keyof T>(
    event: K,
    ...args: T[K] extends (...args: infer A) => unknown ? A : never
  ): boolean;
  once<K extends keyof T>(event: K, listener: T[K]): TypedEventEmitter<T>;
  removeAllListeners<K extends keyof T>(event?: K): TypedEventEmitter<T>;
}

class BrowserEventEmitter<T> implements TypedEventEmitter<T> {
  private readonly listeners = new Map<
    keyof T,
    Set<(...args: unknown[]) => void>
  >();

  on = <K extends keyof T>(event: K, listener: T[K]) => {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (...args: unknown[]) => void);
    this.listeners.set(event, set);
    return this;
  };

  off = <K extends keyof T>(event: K, listener: T[K]) => {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener as (...args: unknown[]) => void);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
    return this;
  };

  emit = <K extends keyof T>(
    event: K,
    ...args: T[K] extends (...args: infer A) => unknown ? A : never
  ) => {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return false;
    }
    for (const listener of set) {
      (listener as (...eventArgs: unknown[]) => void)(...args);
    }
    return true;
  };

  once = <K extends keyof T>(event: K, listener: T[K]) => {
    const wrapped = ((...args: unknown[]) => {
      this.off(event, wrapped as T[K]);
      (listener as (...eventArgs: unknown[]) => void)(...args);
    }) as T[K];
    return this.on(event, wrapped);
  };

  removeAllListeners = <K extends keyof T>(event?: K) => {
    if (event) {
      this.listeners.delete(event);
      return this;
    }
    this.listeners.clear();
    return this;
  };
}

export class ForksdClient
  extends BrowserEventEmitter<ForksdClientEvents>
  implements TypedEventEmitter<ForksdClientEvents>
{
  private ws: WebSocket | null = null;
  private _state: ForksdClientState = "disconnected";
  private reconnectAttempt = 0;
  private authFailures = 0;
  private tokenRefreshAttempts = 0;
  private tokenRefreshExhausted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
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

    if (!WS_URL_REGEX.test(opts.url)) {
      throw new Error(
        `Invalid WebSocket URL: "${opts.url}". URL must start with ws:// or wss://`
      );
    }

    if (
      opts.maxReconnectAttempts !== undefined &&
      (opts.maxReconnectAttempts < 0 ||
        !Number.isInteger(opts.maxReconnectAttempts))
    ) {
      throw new Error(
        `Invalid maxReconnectAttempts: ${opts.maxReconnectAttempts}. Must be a non-negative integer.`
      );
    }

    if (
      opts.connectionTimeout !== undefined &&
      (opts.connectionTimeout <= 0 || !Number.isFinite(opts.connectionTimeout))
    ) {
      throw new Error(
        `Invalid connectionTimeout: ${opts.connectionTimeout}. Must be a positive number.`
      );
    }

    if (typeof WebSocket === "undefined") {
      throw new BrowserNotSupportedError();
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

  private readonly setState = (newState: ForksdClientState) => {
    if (this._state !== newState) {
      this._state = newState;
      this.emit("stateChange", newState);
    }
  };

  private readonly healthUrl = () => {
    try {
      const url = new URL(this.url);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = "/health";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  };

  private readonly fetchHealthStatus = async () => {
    const url = this.healthUrl();
    if (!url) {
      return null;
    }
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      return response.status;
    } catch {
      return null;
    }
  };

  private readonly ensureValidToken = async () => {
    const status = await this.fetchHealthStatus();
    if (status !== 401) {
      return;
    }

    if (!this.onTokenInvalid) {
      throw new Error("forksd auth mismatch; restart the app");
    }

    if (this.tokenRefreshAttempts >= MAX_TOKEN_REFRESH_ATTEMPTS) {
      this.tokenRefreshExhausted = true;
      throw new Error(
        `Token refresh exhausted after ${MAX_TOKEN_REFRESH_ATTEMPTS} attempts`
      );
    }

    this.tokenRefreshAttempts++;
    this.token = await this.onTokenInvalid();

    const retryStatus = await this.fetchHealthStatus();
    if (retryStatus === 401) {
      throw new Error("forksd auth mismatch; restart the app");
    }

    this.tokenRefreshAttempts = 0;
    this.tokenRefreshExhausted = false;
  };

  connect = () => {
    if (this._state === "connected") {
      return Promise.resolve();
    }
    if (this._state === "connecting" && this.pendingConnect) {
      return this.pendingConnect;
    }

    this.intentionalClose = false;
    this.setState("connecting");

    const attempt = (async () => {
      try {
        await this.ensureValidToken();
      } catch (error) {
        this.setState("disconnected");
        this.emit(
          "error",
          error instanceof Error ? error : new Error(String(error))
        );
        throw error;
      }

      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          cleanup();
          this.ws?.close();
          this.setState("disconnected");
          reject(
            new Error(`Connection timeout after ${this.connectionTimeout}ms`)
          );
        }, this.connectionTimeout);

        const protocols = ["forksd", `token.${this.token}`];
        this.ws = new WebSocket(this.url, protocols);

        const onOpen = () => {
          cleanup();
          this.handleOpen();
          resolve();
        };

        const onError = () => {
          cleanup();
          const err = new Error("WebSocket connection error");
          this.handleError(err);
          this.setState("disconnected");
          reject(err);
        };

        const onClose = (event: CloseEvent) => {
          cleanup();
          this.setState("disconnected");
          if (event.code === 1008 || event.code === 4001) {
            reject(new Error(`Authentication failed: ${event.reason}`));
          } else {
            reject(
              new Error(`Connection closed: ${event.code} ${event.reason}`)
            );
          }
        };

        const cleanup = () => {
          clearTimeout(timeoutId);
          this.ws?.removeEventListener("open", onOpen);
          this.ws?.removeEventListener("error", onError);
          this.ws?.removeEventListener("close", onClose);
        };

        this.ws.addEventListener("open", onOpen);
        this.ws.addEventListener("error", onError);
        this.ws.addEventListener("close", onClose);
      });
    })();

    this.pendingConnect = attempt.finally(() => {
      this.pendingConnect = null;
    });

    return this.pendingConnect;
  };

  disconnect = () => {
    this.intentionalClose = true;
    this.cleanup();
    this.setState("disconnected");
    this.emit("disconnected", "intentional");
  };

  resetReconnection = () => {
    this.reconnectAttempt = 0;
    this.authFailures = 0;
    this.tokenRefreshAttempts = 0;
    this.tokenRefreshExhausted = false;
  };

  updateToken = (newToken: string) => {
    this.token = newToken;
    this.authFailures = 0;
    this.tokenRefreshAttempts = 0;
    this.tokenRefreshExhausted = false;
  };

  destroy = () => {
    this.disconnect();
    this.removeAllListeners();
  };

  ptyAttach = (id: string) => {
    this.send({ type: "pty:attach", id });
  };

  ptyDetach = (id: string) => {
    this.send({ type: "pty:detach", id });
  };

  ptyInput = (id: string, data: string) => {
    this.send({ type: "pty:input", id, data });
  };

  ptyResize = (id: string, cols: number, rows: number) => {
    this.send({ type: "pty:resize", id, cols, rows });
  };

  private readonly send = (message: unknown) => {
    if (this.ws?.readyState !== WS_OPEN) {
      throw new WebSocketNotReadyError(this._state);
    }
    this.ws.send(JSON.stringify(message));
  };

  private readonly sendSilent = (message: unknown) => {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  };

  private readonly handleOpen = () => {
    this.reconnectAttempt = 0;
    this.authFailures = 0;
    this.tokenRefreshAttempts = 0;
    this.tokenRefreshExhausted = false;
    this.setState("connected");
    this.emit("connected");
    this.setupListeners();
    this.startPing();
  };

  private readonly setupListeners = () => {
    if (!this.ws) {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      try {
        const message = JSON.parse(event.data) as {
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
        return;
      }
    };

    const onClose = (event: CloseEvent) => {
      this.handleClose(event.code, event.reason);
    };

    const onError = () => {
      this.handleError(new Error("WebSocket error"));
    };

    this.ws.addEventListener("message", onMessage);
    this.ws.addEventListener("close", onClose);
    this.ws.addEventListener("error", onError);
  };

  private readonly startPing = () => {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    this.pingTimer = setInterval(() => {
      this.sendSilent({ type: "ping" });
    }, PING_INTERVAL_MS);
  };

  private readonly handleMessage = (message: {
    type: string;
    event?: unknown;
    id?: string;
    data?: string;
    history?: string;
    exitCode?: number;
    error?: string;
  }) => {
    switch (message.type) {
      case "pong":
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
  };

  private readonly handleClose = (code: number, reason: string) => {
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
  };

  private readonly handleError = (err: Error) => {
    this.emit("error", err);
  };

  private readonly scheduleReconnect = async () => {
    if (this._state === "reconnecting" || this.reconnectTimer) {
      return;
    }

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

    if (
      this.authFailures >= 3 &&
      this.onTokenInvalid &&
      !this.tokenRefreshExhausted
    ) {
      if (this.tokenRefreshAttempts >= MAX_TOKEN_REFRESH_ATTEMPTS) {
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
    const baseDelay = RECONNECT_DELAYS[delayIndex] as number;
    const jitter = Math.random() * baseDelay * 0.5;
    const delay = Math.floor(baseDelay + jitter);
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectTimer = null;
      } catch {
        this.reconnectTimer = null;
        if (this.autoReconnect && !this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  };

  private readonly cleanup = () => {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      if (
        this.ws.readyState === WS_OPEN ||
        this.ws.readyState === WS_CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  };
}
