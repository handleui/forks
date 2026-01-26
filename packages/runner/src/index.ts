/** @forks-sh/runner – task execution */

// biome-ignore lint/performance/noBarrelFile: this is the package entry point
export { createRegistry, ExecutionRegistry } from "./registry.js";
export { createRunner, Runner } from "./runner.js";
export type { ExecutionContext, RunnerConfig } from "./types.js";

export const RUNNER_VERSION = "0.0.0";
