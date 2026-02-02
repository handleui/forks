import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

type RpcResponse<T> =
  | { id: string; ok: true; result: T }
  | { id: string; ok: false; error: string };

const RPC_TIMEOUT_MS = 30_000;

export const requestRpc = <T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown>
): Promise<T> => {
  const id = randomUUID();
  const payload: RpcRequest = { id, method, params };

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    const settle = <R>(fn: () => R): R | undefined => {
      if (settled) {
        return undefined;
      }
      settled = true;
      cleanup();
      return fn();
    };

    socket.setTimeout(RPC_TIMEOUT_MS);
    socket.setEncoding("utf8");

    socket.on("timeout", () => {
      settle(() => reject(new Error("RPC request timed out")));
    });

    socket.on("error", (error) => {
      settle(() => reject(error));
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        settle(() => reject(new Error("Empty RPC response")));
        return;
      }
      try {
        const response = JSON.parse(line) as RpcResponse<T>;
        if (response.id !== id) {
          settle(() => reject(new Error("RPC response id mismatch")));
          return;
        }
        if (!response.ok) {
          settle(() => reject(new Error(response.error)));
          return;
        }
        settle(() => resolve(response.result));
      } catch (error) {
        settle(() => reject(error));
      }
    });

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
};
