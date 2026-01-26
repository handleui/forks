// biome-ignore lint/performance/noBarrelFile: this is the package entry point
export { DEFAULT_DB_PATH } from "./db.js";
export {
  createStoreEventEmitter,
  type StoreEventEmitter,
  type StoreEvents,
} from "./events.js";
export {
  attempts,
  chats,
  plans,
  projects,
  questions,
  subagents,
  tasks,
  workspaces,
} from "./schema.js";
export { createStore, type Store, type StoreOptions } from "./store.js";

export const STORE_VERSION = "0.0.0";

export type {
  Attempt,
  Chat,
  CreateWorkspaceOpts,
  Plan,
  Project,
  Question,
  Subagent,
  Task,
  Workspace,
} from "@forks-sh/protocol";
