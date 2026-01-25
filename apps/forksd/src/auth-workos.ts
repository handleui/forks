import { randomUUID } from "node:crypto";
import { WorkOS } from "@workos-inc/node";

const STATE_TTL_MS = 5 * 60 * 1000;

interface WorkosUser {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface StateEntry {
  codeVerifier: string;
  createdAt: number;
}

interface WorkosAuth {
  startAuth: () => Promise<{ authorizationUrl: string; state: string }>;
  handleCallback: (input: { code: string; state: string }) => Promise<void>;
  getCurrentUser: () => WorkosUser | null;
  isValidState: (state: string) => boolean;
}

export const createWorkosAuth = (options: {
  bind: string;
  port: number;
}): WorkosAuth | null => {
  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!(apiKey && clientId)) {
    return null;
  }

  const workos = new WorkOS(apiKey);
  const stateStore = new Map<string, StateEntry>();
  let currentUser: WorkosUser | null = null;

  const getRedirectUri = () =>
    process.env.WORKOS_REDIRECT_URI ??
    `http://${options.bind}:${options.port}/auth/callback`;

  const pruneStates = () => {
    if (stateStore.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [state, entry] of stateStore.entries()) {
      if (now - entry.createdAt > STATE_TTL_MS) {
        stateStore.delete(state);
      }
    }
  };

  const startAuth = async () => {
    pruneStates();
    const state = randomUUID();
    const { url, codeVerifier } =
      await workos.userManagement.getAuthorizationUrlWithPKCE({
        clientId,
        redirectUri: getRedirectUri(),
        provider: "authkit",
      });
    stateStore.set(state, { codeVerifier, createdAt: Date.now() });
    return { authorizationUrl: url, state };
  };

  const handleCallback = async (input: { code: string; state: string }) => {
    const entry = stateStore.get(input.state);
    if (!entry) {
      throw new Error("Invalid or expired state.");
    }
    const result = await workos.userManagement.authenticateWithCode({
      clientId,
      code: input.code,
      codeVerifier: entry.codeVerifier,
    });
    stateStore.delete(input.state);
    const user = result.user as WorkosUser | undefined;
    currentUser = user
      ? {
          id: user.id,
          email: user.email ?? null,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
        }
      : null;
  };

  const getCurrentUser = () => currentUser;

  const isValidState = (state: string) => {
    pruneStates();
    const entry = stateStore.get(state);
    if (!entry) {
      return false;
    }
    if (Date.now() - entry.createdAt > STATE_TTL_MS) {
      stateStore.delete(state);
      return false;
    }
    return true;
  };

  return { startAuth, handleCallback, getCurrentUser, isValidState };
};
