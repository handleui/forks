import { scrubString } from "@forks-sh/sentry";
import type { ForksdClientState } from "@forks-sh/ws-client";
import { ForksdClient } from "@forks-sh/ws-client";
import { invoke } from "@tauri-apps/api/core";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import "./app.css";

interface ForksdConnectionInfo {
  baseUrl: string;
  token: string;
}

interface PanelItem {
  title: string;
  meta: string;
  status: "active" | "queued" | "idle";
}

const HTTP_SCHEME_PATTERN = /^http/;
const toWebSocketUrl = (baseUrl: string) =>
  baseUrl.replace(HTTP_SCHEME_PATTERN, (match) =>
    match === "https" ? "wss" : "ws"
  );

const App = () => {
  const [connectionState, setConnectionState] =
    createSignal<ForksdClientState>("disconnected");
  const [connectionDetail, setConnectionDetail] = createSignal("");
  const [forksdUrl, setForksdUrl] = createSignal("");
  const [lastError, setLastError] = createSignal<string | null>(null);

  let client: ForksdClient | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const threads: PanelItem[] = [
    { title: "Main workspace", meta: "2 active agents", status: "active" },
    { title: "Refactor queue", meta: "1 pending task", status: "queued" },
    { title: "Release notes", meta: "idle", status: "idle" },
  ];

  const forks: PanelItem[] = [
    { title: "attempt-6f2", meta: "feature branch", status: "active" },
    { title: "attempt-81b", meta: "design review", status: "queued" },
    { title: "attempt-2ab", meta: "cleanup", status: "idle" },
  ];

  const tasks: PanelItem[] = [
    { title: "Wire approvals", meta: "blocked", status: "queued" },
    { title: "Sync plans", meta: "running", status: "active" },
    { title: "Index repository", meta: "waiting", status: "idle" },
  ];

  const terminals: PanelItem[] = [
    { title: "forksd", meta: "logs streaming", status: "active" },
    { title: "plan-runner", meta: "idle", status: "idle" },
    { title: "agent-shell", meta: "queued", status: "queued" },
  ];

  const recordError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setLastError(scrubString(message));
  };

  const connectForksd = async () => {
    try {
      const info = await invoke<ForksdConnectionInfo>("forksd_connection_info");
      setForksdUrl(info.baseUrl);
      client = new ForksdClient({
        url: toWebSocketUrl(info.baseUrl),
        token: info.token,
        autoReconnect: true,
      });
      client.on("stateChange", (state) => {
        setConnectionState(state);
        setConnectionDetail("");
      });
      client.on("connected", () => {
        setConnectionDetail("connected");
      });
      client.on("disconnected", (reason) => {
        setConnectionDetail(reason);
      });
      client.on("error", (error) => {
        recordError(error);
      });
      const attemptConnect = async () => {
        if (!client) {
          return;
        }
        try {
          await client.connect();
        } catch (error) {
          recordError(error);
          if (retryTimer) {
            clearTimeout(retryTimer);
          }
          retryTimer = setTimeout(() => {
            attemptConnect().catch(recordError);
          }, 2000);
        }
      };
      await attemptConnect();
    } catch (error) {
      recordError(error);
    }
  };

  onMount(() => {
    connectForksd().catch(recordError);
  });

  onCleanup(() => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    client?.destroy();
    client = null;
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">F</div>
          <div>
            <div class="brand-title">Forks</div>
            <div class="brand-subtitle">Local AI workbench</div>
          </div>
        </div>
        <div class="status" data-state={connectionState()}>
          <div class="status-dot" data-state={connectionState()} />
          <div class="status-label">
            {connectionState()}
            <Show when={connectionDetail()}>
              <span class="status-detail">{connectionDetail()}</span>
            </Show>
          </div>
          <div class="status-url">{forksdUrl() || "forksd not configured"}</div>
        </div>
      </header>

      <div class="content">
        <aside class="sidebar">
          <div class="sidebar-section">
            <div class="sidebar-title">Workspace</div>
            <button class="sidebar-item" type="button">
              Threads
            </button>
            <button class="sidebar-item" type="button">
              Forks
            </button>
            <button class="sidebar-item" type="button">
              Tasks
            </button>
            <button class="sidebar-item" type="button">
              Terminals
            </button>
          </div>
          <div class="sidebar-section">
            <div class="sidebar-title">Approvals</div>
            <button class="sidebar-item" type="button">
              Pending
            </button>
            <button class="sidebar-item" type="button">
              History
            </button>
          </div>
        </aside>

        <main class="main">
          <section class="hero">
            <div>
              <div class="hero-eyebrow">Parallel agent control</div>
              <h1 class="hero-title">Threads, forks, tasks, and terminals.</h1>
              <p class="hero-subtitle">
                Forks orchestrates local agents through forksd while you keep
                the approvals and worktree history in view.
              </p>
            </div>
            <div class="hero-card">
              <div class="hero-card-title">Session health</div>
              <div class="hero-metric">{connectionState()}</div>
              <div class="hero-meta">Forksd bridge state</div>
            </div>
          </section>

          <Show when={lastError()}>
            <div class="error-banner">{lastError()}</div>
          </Show>

          <div class="panel-grid">
            <section aria-label="Threads" class="panel">
              <div class="panel-header">
                <div>
                  <div class="panel-title">Threads</div>
                  <div class="panel-subtitle">Active conversations</div>
                </div>
                <button class="panel-action" type="button">
                  New
                </button>
              </div>
              <div class="panel-list">
                <For each={threads}>
                  {(item) => (
                    <div class="panel-item" data-state={item.status}>
                      <div>
                        <div class="panel-item-title">{item.title}</div>
                        <div class="panel-item-meta">{item.meta}</div>
                      </div>
                      <div class="panel-item-status" data-state={item.status}>
                        {item.status}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </section>

            <section aria-label="Forks" class="panel">
              <div class="panel-header">
                <div>
                  <div class="panel-title">Forks</div>
                  <div class="panel-subtitle">Worktree snapshots</div>
                </div>
                <button class="panel-action" type="button">
                  Stack
                </button>
              </div>
              <div class="panel-list">
                <For each={forks}>
                  {(item) => (
                    <div class="panel-item" data-state={item.status}>
                      <div>
                        <div class="panel-item-title">{item.title}</div>
                        <div class="panel-item-meta">{item.meta}</div>
                      </div>
                      <div class="panel-item-status" data-state={item.status}>
                        {item.status}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </section>

            <section aria-label="Tasks" class="panel">
              <div class="panel-header">
                <div>
                  <div class="panel-title">Tasks</div>
                  <div class="panel-subtitle">Plan execution</div>
                </div>
                <button class="panel-action" type="button">
                  Queue
                </button>
              </div>
              <div class="panel-list">
                <For each={tasks}>
                  {(item) => (
                    <div class="panel-item" data-state={item.status}>
                      <div>
                        <div class="panel-item-title">{item.title}</div>
                        <div class="panel-item-meta">{item.meta}</div>
                      </div>
                      <div class="panel-item-status" data-state={item.status}>
                        {item.status}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </section>

            <section aria-label="Terminals" class="panel">
              <div class="panel-header">
                <div>
                  <div class="panel-title">Terminals</div>
                  <div class="panel-subtitle">PTY sessions</div>
                </div>
                <button class="panel-action" type="button">
                  Attach
                </button>
              </div>
              <div class="panel-list">
                <For each={terminals}>
                  {(item) => (
                    <div class="panel-item" data-state={item.status}>
                      <div>
                        <div class="panel-item-title">{item.title}</div>
                        <div class="panel-item-meta">{item.meta}</div>
                      </div>
                      <div class="panel-item-status" data-state={item.status}>
                        {item.status}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </div>
        </main>

        <aside class="rightbar">
          <div class="rightbar-card">
            <div class="rightbar-title">Approvals</div>
            <div class="rightbar-subtitle">Queued actions</div>
            <div class="approval-item">
              <div class="approval-title">Run lint fix</div>
              <div class="approval-meta">workspace: forks/davis</div>
              <button class="approval-action" type="button">
                Review
              </button>
            </div>
            <div class="approval-item">
              <div class="approval-title">Apply patch</div>
              <div class="approval-meta">3 files touched</div>
              <button class="approval-action" type="button">
                Review
              </button>
            </div>
          </div>
          <div class="rightbar-card">
            <div class="rightbar-title">Agent pulse</div>
            <div class="rightbar-subtitle">Streaming from forksd</div>
            <div class="pulse">
              <div class="pulse-bar" style={{ "--pulse": "92%" }} />
              <div class="pulse-bar" style={{ "--pulse": "64%" }} />
              <div class="pulse-bar" style={{ "--pulse": "78%" }} />
              <div class="pulse-bar" style={{ "--pulse": "55%" }} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default App;
