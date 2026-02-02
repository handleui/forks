import { requestRpc } from "./rpc-client.js";
import { isTauriRuntime } from "./runtime.js";

interface DiffOptions {
  contextLines?: number;
}

const clampContext = (value: number): number =>
  Math.min(Math.max(value, 0), 200);

export const computeUnifiedDiff = async (
  original: string,
  modified: string,
  options: DiffOptions = {}
): Promise<string> => {
  const contextLines = clampContext(options.contextLines ?? 3);
  const socketPath =
    typeof process !== "undefined"
      ? process.env.FORKS_GIT_RPC_SOCKET
      : undefined;
  if (socketPath) {
    return requestRpc(socketPath, "diff_unified", {
      original,
      modified,
      contextLines,
    });
  }
  if (isTauriRuntime()) {
    const moduleName = "@tauri-apps/api/core";
    const { invoke } = await import(moduleName);
    return invoke("compute_unified_diff", {
      original,
      modified,
      contextLines,
    });
  }
  throw new Error("No diff backend available");
};
