import { invoke } from "@tauri-apps/api/core";

interface DiffOptions {
  contextLines?: number;
}

export const computeUnifiedDiff = (
  original: string,
  modified: string,
  options: DiffOptions = {}
): Promise<string> =>
  invoke("compute_unified_diff", {
    original,
    modified,
    contextLines: options.contextLines,
  });
