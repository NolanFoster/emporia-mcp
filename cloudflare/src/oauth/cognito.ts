/**
 * Cognito OAuth proxy for remote MCP clients.
 *
 * Mirrors the Express remote-server OAuth flow:
 *  - Dynamic client registration returns the Emporia Cognito app client id
 *  - /oauth/authorize redirects to Cognito hosted UI
 *  - /oauth/callback maps Cognito codes back to the MCP client redirect_uri
 *  - /oauth/token proxies token exchange to Cognito (rewriting redirect_uri)
 *  - Well-known metadata documents this Worker as the authorization server
 *
 * OAuth pending-state is stored in-memory. On Cloudflare Workers this is
 * best-effort within a single isolate; for multi-colocation production use,
 * replace with KV/DO if authorization codes are exchanged on a different
 * isolate than the authorize step (rare for short-lived browser flows).
 */

import type { RuntimeConfig } from "../config.js";
import { log } from "../utils/log.js";

interface PendingOAuth {
  redirect_uri: string;
  client_id: string;
  code_challenge?: string;
  code_challenge_method?: string;
  /** Epoch ms when this entry expires. */
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingOAuthRequests = new Map<string, PendingOAuth>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, value] of pendingOAuthRequests) {
    if (value.expiresAt <= now) pendingOAuthRequests.delete(key);
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, Accept",
    "Access-Control-Expose-Headers": "mcp-session-id",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function requireMcpOrigin(config: RuntimeConfig): string {
  if (!config.mcpOrigin) {
    throw new Error(
      "EMPORIA_MCP_ORIGIN is not configured. Set it to the public HTTPS origin of this Worker.",
    );
  }
  return config.mcpOrigin;
}

/**
 * Handle OAuth + well-known routes. Returns null if the path is not an OAuth route.
 */
export async function handleOAuthRequest(
  request: Request,
  config: RuntimeConfig,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS" && isOAuthPath(path)) {
    return withCors(request, new Response(null, { status: 204 }));
  }

  try {
    if (method === "GET" && path === "/.well-known/oauth-protected-resource") {
      const mcpOrigin = requireMcpOrigin(config);
      return withCors(
        request,
        json({
          resource: `${mcpOrigin}/mcp`,
          authorization_servers: [mcpOrigin],
          bearer_methods_supported: ["header"],
        }),
      );
    }

    if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource/")) {
      const transport = path.split("/").pop();
      if (transport !== "mcp" && transport !== "streamable" && transport !== "sse") {
        return withCors(request, new Response("Not Found", { status: 404 }));
      }
      const mcpOrigin = requireMcpOrigin(config);
      const resourcePath = transport === "mcp" ? "/mcp" : `/${transport}`;
      return withCors(
        request,
        json({
          resource: `${mcpOrigin}${resourcePath}`,
          authorization_servers: [mcpOrigin],
          bearer_methods_supported: ["header"],
        }),
      );
    }

    if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
      const mcpOrigin = requireMcpOrigin(config);
      return withCors(
        request,
        json({
          issuer: mcpOrigin,
          authorization_endpoint: `${mcpOrigin}/oauth/authorize`,
          token_endpoint: `${mcpOrigin}/oauth/token`,
          registration_endpoint: `${mcpOrigin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      );
    }

    if (method === "POST" && path === "/oauth/register") {
      const body = (await request.json().catch(() => ({}))) as {
        redirect_uris?: string[];
      };
      return withCors(
        request,
        json({
          client_id: config.cognitoClientId,
          redirect_uris: body.redirect_uris ?? [],
        }),
      );
    }

    if (method === "GET" && path === "/oauth/authorize") {
      return withCors(request, await handleAuthorize(url, config));
    }

    if (method === "GET" && path === "/oauth/callback") {
      return withCors(request, handleCallback(url));
    }

    if (method === "POST" && path === "/oauth/token") {
      return withCors(request, await handleToken(request, config));
    }
  } catch (error) {
    log("OAuth handler error", { error: String(error), path }, "error", "OAUTH");
    return withCors(
      request,
      json(
        {
          error: "server_error",
          error_description: error instanceof Error ? error.message : String(error),
        },
        500,
      ),
    );
  }

  return null;
}

function isOAuthPath(path: string): boolean {
  return (
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/oauth-") ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-protected-resource"
  );
}

async function handleAuthorize(url: URL, config: RuntimeConfig): Promise<Response> {
  const redirect_uri = url.searchParams.get("redirect_uri") || "";
  const client_id = url.searchParams.get("client_id") || "";
  const code_challenge = url.searchParams.get("code_challenge") || undefined;
  const code_challenge_method = url.searchParams.get("code_challenge_method") || undefined;

  if (!redirect_uri || !client_id) {
    return json(
      {
        error: "invalid_request",
        error_description: "Missing required parameters: redirect_uri and client_id",
      },
      400,
    );
  }

  const mcpOrigin = requireMcpOrigin(config);
  pruneExpired();

  const internalState = crypto.randomUUID();
  pendingOAuthRequests.set(internalState, {
    redirect_uri,
    client_id,
    code_challenge,
    code_challenge_method,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  const cognitoParams = new URLSearchParams({
    response_type: "code",
    client_id: config.cognitoClientId,
    redirect_uri: `${mcpOrigin}/oauth/callback`,
    state: internalState,
  });
  if (code_challenge) cognitoParams.set("code_challenge", code_challenge);
  if (code_challenge_method) cognitoParams.set("code_challenge_method", code_challenge_method);

  return Response.redirect(`${config.authOrigin}/oauth2/authorize?${cognitoParams.toString()}`, 302);
}

function handleCallback(url: URL): Response {
  const code = url.searchParams.get("code") || undefined;
  const state = url.searchParams.get("state") || undefined;
  const error = url.searchParams.get("error") || undefined;
  const error_description = url.searchParams.get("error_description") || undefined;

  pruneExpired();
  const session = state ? pendingOAuthRequests.get(state) : undefined;

  if (!session) {
    return json(
      {
        error: "invalid_request",
        error_description: "Invalid or expired session",
      },
      400,
    );
  }

  pendingOAuthRequests.delete(state!);

  if (error) {
    const errorParams = new URLSearchParams({ error });
    if (error_description) errorParams.set("error_description", error_description);
    return Response.redirect(`${session.redirect_uri}?${errorParams.toString()}`, 302);
  }

  if (code) {
    const successParams = new URLSearchParams({ code });
    return Response.redirect(`${session.redirect_uri}?${successParams.toString()}`, 302);
  }

  return json(
    {
      error: "invalid_request",
      error_description: "No authorization code received",
    },
    400,
  );
}

async function handleToken(request: Request, config: RuntimeConfig): Promise<Response> {
  const mcpOrigin = requireMcpOrigin(config);
  const contentType = request.headers.get("content-type") || "";

  let body: Record<string, string> = {};
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    body = Object.fromEntries(new URLSearchParams(text).entries());
  } else if (contentType.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as Record<string, string>;
  } else {
    const text = await request.text();
    body = Object.fromEntries(new URLSearchParams(text).entries());
  }

  // Cognito must see our registered callback, not the MCP client's redirect_uri
  body.redirect_uri = `${mcpOrigin}/oauth/callback`;
  if (!body.client_id) {
    body.client_id = config.cognitoClientId;
  }

  const params = new URLSearchParams(body);

  try {
    const response = await fetch(`${config.authOrigin}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    log("OAuth token request failed", { error: String(error) }, "error", "OAUTH");
    return json({ error: "Failed to fetch OAuth token" }, 500);
  }
}
