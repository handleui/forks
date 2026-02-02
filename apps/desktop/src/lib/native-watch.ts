import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";

export interface WatchAddInput {
  path: string;
  repoRoot?: string;
  attemptId?: string;
  debounceMs?: number;
  watchGit?: boolean;
}

export interface WatchAddResponse {
  watchId: string;
}

export interface WatchEventPayload {
  watchId: string;
  repoRoot: string;
  worktreePath: string;
  attemptId?: string | null;
  paths: string[];
  kinds: string[];
  timestampMs: number;
}

export const watchAdd = (input: WatchAddInput): Promise<WatchAddResponse> =>
  invoke("watch_add", { request: input });

export const watchRemove = (watchId: string): Promise<void> =>
  invoke("watch_remove", { watchId });

export const watchRemoveAll = (): Promise<void> => invoke("watch_remove_all");

export const onWatchEvent = (
  handler: (payload: WatchEventPayload) => void
): Promise<UnlistenFn> => listen("fs/watch", (event) => handler(event.payload));
