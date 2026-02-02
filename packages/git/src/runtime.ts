export const isTauriRuntime = (): boolean => {
  if (typeof globalThis === "undefined") {
    return false;
  }
  const runtime = globalThis as Record<string, unknown>;
  return "__TAURI__" in runtime || "__TAURI_INTERNALS__" in runtime;
};
