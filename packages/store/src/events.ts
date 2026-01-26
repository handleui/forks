import { EventEmitter } from "node:events";
import type { AgentEvent } from "@forks-sh/protocol";

export interface StoreEvents {
  agent: [AgentEvent];
}

export type StoreEventEmitter = EventEmitter<StoreEvents>;

export const createStoreEventEmitter = (): StoreEventEmitter =>
  new EventEmitter();
