/**
 * OAuth authorization server for remote MCP clients.
 *
 * Emporia's public Cognito Hosted UI app only allowlists Emporia's own
 * callback URLs (e.g. https://mcp.emporiaenergy.com/oauth/callback). A
 * personal fork cannot add workers.dev callbacks, so Hosted UI always fails
 * with `redirect_mismatch`.
 *
 * This Worker therefore acts as its own authorization server:
 *  1. GET  /oauth/authorize  — login form (email + password)
 *  2. POST /oauth/login      — Cognito USER_PASSWORD_AUTH → one-time code
 *  3. POST /oauth/token      — exchange code (or refresh) for tokens
 *  4. POST /oauth/register   — dynamic client registration (public clients)
 *
 * Tokens are real Emporia Cognito tokens (IdToken is what Emporia APIs need).
 *
 * Pending OAuth / code state is in-memory (best-effort per isolate). Fine for
 * short browser flows on a single Worker; use KV/DO if you need multi-colo.
 */

import type { RuntimeConfig } from "../config.js";
import { log } from "../utils/log.js";

/** Cognito IDP endpoint used by the local stdio server (USER_PASSWORD_AUTH). */
const COGNITO_IDP_URL = "https://cognito-idp.us-east-2.amazonaws.com/";

interface PendingOAuth {
  redirect_uri: string;
  client_id: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  /** Epoch ms when this entry expires. */
  expiresAt: number;
}

interface IssuedCode {
  tokens: CognitoTokens;
  redirect_uri: string;
  client_id: string;
  code_challenge?: string;
  code_challenge_method?: string;
  expiresAt: number;
}

interface CognitoTokens {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface CognitoAuthResult {
  AuthenticationResult?: {
    AccessToken: string;
    IdToken: string;
    RefreshToken?: string;
    ExpiresIn: number;
    TokenType?: string;
  };
  message?: string;
  __type?: string;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

const pendingOAuthRequests = new Map<string, PendingOAuth>();
const issuedCodes = new Map<string, IssuedCode>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, value] of pendingOAuthRequests) {
    if (value.expiresAt <= now) pendingOAuthRequests.delete(key);
  }
  for (const [key, value] of issuedCodes) {
    if (value.expiresAt <= now) issuedCodes.delete(key);
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
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

function isOAuthPath(path: string): boolean {
  return (
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/oauth-") ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-protected-resource"
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifyPkce(
  codeVerifier: string | undefined,
  challenge: string | undefined,
  method: string | undefined,
): Promise<boolean> {
  // No challenge stored → PKCE not required for this authorization.
  if (!challenge) return true;
  if (!codeVerifier) return false;

  const m = (method || "plain").toUpperCase();
  if (m === "PLAIN") {
    return codeVerifier === challenge;
  }
  if (m === "S256") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    return bytesToBase64Url(digest) === challenge;
  }
  return false;
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
          code_challenge_methods_supported: ["S256", "plain"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["openid", "email", "profile"],
        }),
      );
    }

    if (method === "POST" && path === "/oauth/register") {
      const body = (await request.json().catch(() => ({}))) as {
        redirect_uris?: string[];
        client_name?: string;
      };
      // Public client — no secret. client_id is opaque to Cognito; we issue our own.
      const clientId = `emporia-mcp-${crypto.randomUUID()}`;
      return withCors(
        request,
        json(
          {
            client_id: clientId,
            client_name: body.client_name,
            redirect_uris: body.redirect_uris ?? [],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
          201,
        ),
      );
    }

    if (method === "GET" && path === "/oauth/authorize") {
      return withCors(request, handleAuthorizeGet(url));
    }

    if (method === "POST" && path === "/oauth/login") {
      return withCors(request, await handleLoginPost(request, config));
    }

    // Legacy no-op: Cognito Hosted UI callback is not used on personal forks.
    if (method === "GET" && path === "/oauth/callback") {
      return withCors(
        request,
        html(
          loginPage({
            error:
              "Cognito Hosted UI callback is not supported on this fork (redirect_mismatch). " +
              "Start over from your MCP client — you should see an email/password form on this Worker.",
            state: "",
            disabled: true,
          }),
          400,
        ),
      );
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

function handleAuthorizeGet(url: URL): Response {
  const redirect_uri = url.searchParams.get("redirect_uri") || "";
  const client_id = url.searchParams.get("client_id") || "";
  const code_challenge = url.searchParams.get("code_challenge") || undefined;
  const code_challenge_method = url.searchParams.get("code_challenge_method") || undefined;
  const scope = url.searchParams.get("scope") || undefined;
  const errorParam = url.searchParams.get("error_description") || url.searchParams.get("error") || undefined;

  if (!redirect_uri || !client_id) {
    return json(
      {
        error: "invalid_request",
        error_description: "Missing required parameters: redirect_uri and client_id",
      },
      400,
    );
  }

  pruneExpired();

  const internalState = crypto.randomUUID();
  pendingOAuthRequests.set(internalState, {
    redirect_uri,
    client_id,
    code_challenge,
    code_challenge_method,
    scope,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  return html(
    loginPage({
      state: internalState,
      error: errorParam,
      redirectHint: redirect_uri,
    }),
  );
}

async function handleLoginPost(request: Request, config: RuntimeConfig): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  let body: Record<string, string> = {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(await request.text()).entries());
  } else if (contentType.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as Record<string, string>;
  } else {
    body = Object.fromEntries(new URLSearchParams(await request.text()).entries());
  }

  const state = body.state || "";
  const username = (body.username || body.email || "").trim();
  const password = body.password || "";

  pruneExpired();
  const session = state ? pendingOAuthRequests.get(state) : undefined;

  if (!session) {
    return html(
      loginPage({
        state: "",
        error: "Login session expired. Close this window and reconnect from your MCP client.",
        disabled: true,
      }),
      400,
    );
  }

  if (!username || !password) {
    return html(
      loginPage({
        state,
        error: "Email and password are required.",
        redirectHint: session.redirect_uri,
      }),
      400,
    );
  }

  let tokens: CognitoTokens;
  try {
    tokens = await cognitoPasswordAuth(username, password, config.cognitoClientId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("Password auth failed", { error: message }, "info", "OAUTH");
    return html(
      loginPage({
        state,
        error: message,
        redirectHint: session.redirect_uri,
        username,
      }),
      401,
    );
  }

  // One-time authorization code bound to this session + tokens.
  const code = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  issuedCodes.set(code, {
    tokens,
    redirect_uri: session.redirect_uri,
    client_id: session.client_id,
    code_challenge: session.code_challenge,
    code_challenge_method: session.code_challenge_method,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  pendingOAuthRequests.delete(state);

  const successParams = new URLSearchParams({ code, state });
  // Some clients only look for `code`; state is included when present for CSRF.
  return Response.redirect(`${session.redirect_uri}?${successParams.toString()}`, 302);
}

async function cognitoPasswordAuth(
  username: string,
  password: string,
  clientId: string,
): Promise<CognitoTokens> {
  const response = await fetch(COGNITO_IDP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }),
  });

  const data = (await response.json()) as CognitoAuthResult;

  if (!response.ok || !data.AuthenticationResult) {
    const type = data.__type || "NotAuthorizedException";
    const msg = data.message || "Authentication failed";
    // Friendlier messages for common Cognito errors.
    if (type.includes("NotAuthorized") || response.status === 400) {
      throw new Error(
        msg.includes("Incorrect") || msg.includes("password")
          ? "Incorrect email or password."
          : `${msg} (Use a native Emporia email/password account — Google/Apple sign-in is not supported.)`,
      );
    }
    throw new Error(msg);
  }

  const result = data.AuthenticationResult;
  return {
    access_token: result.AccessToken,
    id_token: result.IdToken,
    refresh_token: result.RefreshToken,
    expires_in: result.ExpiresIn,
    token_type: result.TokenType || "Bearer",
  };
}

async function cognitoRefresh(refreshToken: string, clientId: string): Promise<CognitoTokens> {
  const response = await fetch(COGNITO_IDP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    }),
  });

  const data = (await response.json()) as CognitoAuthResult;
  if (!response.ok || !data.AuthenticationResult) {
    throw new Error(data.message || "Failed to refresh token");
  }

  const result = data.AuthenticationResult;
  return {
    access_token: result.AccessToken,
    id_token: result.IdToken,
    // Cognito often omits refresh_token on refresh; keep the old one.
    refresh_token: result.RefreshToken || refreshToken,
    expires_in: result.ExpiresIn,
    token_type: result.TokenType || "Bearer",
  };
}

async function handleToken(request: Request, config: RuntimeConfig): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";

  let body: Record<string, string> = {};
  if (contentType.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(await request.text()).entries());
  } else if (contentType.includes("application/json")) {
    body = (await request.json().catch(() => ({}))) as Record<string, string>;
  } else {
    body = Object.fromEntries(new URLSearchParams(await request.text()).entries());
  }

  const grantType = body.grant_type || "authorization_code";
  pruneExpired();

  if (grantType === "authorization_code") {
    const code = body.code || "";
    const redirectUri = body.redirect_uri || "";
    const codeVerifier = body.code_verifier;
    const entry = code ? issuedCodes.get(code) : undefined;

    if (!entry) {
      return json(
        { error: "invalid_grant", error_description: "Invalid or expired authorization code" },
        400,
      );
    }

    if (redirectUri && entry.redirect_uri && redirectUri !== entry.redirect_uri) {
      return json(
        { error: "invalid_grant", error_description: "redirect_uri mismatch" },
        400,
      );
    }

    const pkceOk = await verifyPkce(codeVerifier, entry.code_challenge, entry.code_challenge_method);
    if (!pkceOk) {
      return json(
        { error: "invalid_grant", error_description: "PKCE verification failed" },
        400,
      );
    }

    issuedCodes.delete(code);

    // MCP / Emporia APIs expect the Cognito **IdToken** as the bearer credential.
    // Advertise id_token as access_token so clients that only send access_token still work.
    return json({
      access_token: entry.tokens.id_token,
      id_token: entry.tokens.id_token,
      refresh_token: entry.tokens.refresh_token,
      token_type: "Bearer",
      expires_in: entry.tokens.expires_in,
      // Also expose the Cognito access token if a client wants it.
      cognito_access_token: entry.tokens.access_token,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = body.refresh_token || "";
    if (!refreshToken) {
      return json(
        { error: "invalid_request", error_description: "refresh_token is required" },
        400,
      );
    }

    try {
      const tokens = await cognitoRefresh(refreshToken, config.cognitoClientId);
      return json({
        access_token: tokens.id_token,
        id_token: tokens.id_token,
        refresh_token: tokens.refresh_token,
        token_type: "Bearer",
        expires_in: tokens.expires_in,
        cognito_access_token: tokens.access_token,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: "invalid_grant", error_description: message }, 400);
    }
  }

  return json(
    {
      error: "unsupported_grant_type",
      error_description: `Unsupported grant_type: ${grantType}`,
    },
    400,
  );
}

function loginPage(opts: {
  state: string;
  error?: string;
  redirectHint?: string;
  username?: string;
  disabled?: boolean;
}): string {
  const err = opts.error ? `<div class="err" role="alert">${escapeHtml(opts.error)}</div>` : "";
  const hint = opts.redirectHint
    ? `<p class="muted">After login you’ll return to your MCP client<br/><code>${escapeHtml(opts.redirectHint)}</code></p>`
    : "";
  const disabled = opts.disabled ? "disabled" : "";
  const userVal = escapeHtml(opts.username || "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — Emporia MCP</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 420px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.35rem; margin-bottom: .25rem; }
    .muted { opacity: .7; font-size: .9rem; }
    label { display: block; font-size: .85rem; margin: .85rem 0 .3rem; font-weight: 600; }
    input[type=email], input[type=password], input[type=text] {
      width: 100%; box-sizing: border-box; padding: .65rem .75rem;
      border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas);
      background: Canvas; color: CanvasText; font-size: 1rem;
    }
    button {
      margin-top: 1.25rem; width: 100%; padding: .75rem 1rem; border: 0; border-radius: 8px;
      background: #0b6bcb; color: #fff; font-weight: 600; font-size: 1rem; cursor: pointer;
    }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .err {
      background: color-mix(in srgb, #c0392b 18%, Canvas); border: 1px solid #c0392b;
      color: inherit; padding: .65rem .75rem; border-radius: 8px; margin: 1rem 0; font-size: .9rem;
    }
    code { font-size: .78rem; word-break: break-all; }
    .card {
      border: 1px solid color-mix(in srgb, CanvasText 12%, Canvas);
      border-radius: 12px; padding: 1.25rem 1.35rem;
      background: color-mix(in srgb, CanvasText 3%, Canvas);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Emporia Energy MCP</h1>
    <p class="muted">Sign in with a <strong>native</strong> Emporia email/password account.
      Google/Apple accounts are not supported.</p>
    ${err}
    ${hint}
    <form method="POST" action="/oauth/login" autocomplete="on">
      <input type="hidden" name="state" value="${escapeHtml(opts.state)}" />
      <label for="username">Email</label>
      <input id="username" name="username" type="email" required autocomplete="username"
             value="${userVal}" ${disabled} />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password" ${disabled} />
      <button type="submit" ${disabled}>Sign in</button>
    </form>
  </div>
  <p class="muted" style="margin-top:1.25rem">
    This is your fork’s cloud Worker. Credentials go to Emporia Cognito
    (<code>USER_PASSWORD_AUTH</code>) and are not stored on the Worker.
  </p>
</body>
</html>`;
}

