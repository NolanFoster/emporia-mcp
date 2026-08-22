/**
 * Request-scoped auth context for Emporia bearer tokens.
 * Populated by the Worker fetch handler before MCP tools run.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestAuth {
  /** Raw Authorization header value, typically "Bearer <token>" or just the token. */
  authorization: string;
  /** Token without the Bearer prefix, ready for Emporia API headers. */
  token: string;
}

const authStorage = new AsyncLocalStorage<RequestAuth>();

export function runWithAuth<T>(auth: RequestAuth, fn: () => T): T {
  return authStorage.run(auth, fn);
}

export function getRequestAuth(): RequestAuth | undefined {
  return authStorage.getStore();
}

/** Returns the Emporia API token or throws if missing. */
export function getAccessToken(): string {
  const auth = authStorage.getStore();
  if (!auth?.token) {
    throw new Error("Unauthorized: missing Emporia access token");
  }
  return auth.token;
}

/**
 * Parse an Authorization header into token form.
 * Accepts "Bearer <jwt>" or a bare token string.
 */
export function parseAuthorizationHeader(header: string | null): RequestAuth | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith("bearer ")) {
    const token = trimmed.slice(7).trim();
    if (!token) return null;
    return { authorization: trimmed, token };
  }

  // Bare token
  return { authorization: `Bearer ${trimmed}`, token: trimmed };
}
