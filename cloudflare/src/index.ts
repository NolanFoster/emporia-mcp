/**
 * Emporia Energy MCP Server — Cloudflare Workers entrypoint
 *
 * Exposes a remote Streamable HTTP MCP endpoint at /mcp (and /streamable for
 * compatibility with the existing Express remote server path). Authentication
 * uses Emporia Cognito bearer tokens (Authorization: Bearer <token>), the same
 * tokens returned by the OAuth proxy under /oauth/*.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { getConfig, type EmporiaEnv } from "./config.js";
import { EmporiaApiService } from "./services/api.js";
import { registerEmporiaTools } from "./tools/emporia.js";
import { handleOAuthRequest } from "./oauth/cognito.js";
import { parseAuthorizationHeader, runWithAuth } from "./auth-context.js";
import { log } from "./utils/log.js";

const SERVER_NAME = "emporia-mcp";
const SERVER_VERSION = "1.0.0";

function createServer(env: EmporiaEnv) {
  const config = getConfig(env);
  const apiService = new EmporiaApiService(config);

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerEmporiaTools(server, apiService);
  return server;
}

/** MCP paths served by createMcpHandler (stateless Streamable HTTP). */
const MCP_ROUTES = new Set(["/mcp", "/streamable"]);

function unauthorized(message = "Unauthorized: Missing or invalid Authorization header"): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": 'Bearer realm="emporia-mcp", error="invalid_token"',
      },
    },
  );
}

function homePage(mcpOrigin: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Emporia Energy MCP Server</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.55; }
    code, .ep { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .ep { display: block; background: color-mix(in srgb, CanvasText 8%, Canvas); padding: .6rem .75rem; border-radius: 6px; margin: .4rem 0; }
    h1 { font-size: 1.6rem; margin-bottom: .25rem; }
    .muted { opacity: .75; }
  </style>
</head>
<body>
  <h1>Emporia Energy MCP</h1>
  <p class="muted">Cloudflare Workers deployment of the Emporia Energy Model Context Protocol server (BETA).</p>

  <h2>Endpoints</h2>
  <span class="ep">POST ${mcpOrigin}/mcp — MCP Streamable HTTP (Bearer token required)</span>
  <span class="ep">POST ${mcpOrigin}/streamable — alias of /mcp</span>
  <span class="ep">GET  ${mcpOrigin}/oauth/authorize — OAuth authorize (Cognito proxy)</span>
  <span class="ep">POST ${mcpOrigin}/oauth/token — OAuth token (Cognito proxy)</span>
  <span class="ep">POST ${mcpOrigin}/oauth/register — Dynamic client registration</span>
  <span class="ep">GET  ${mcpOrigin}/.well-known/oauth-authorization-server</span>
  <span class="ep">GET  ${mcpOrigin}/health</span>

  <h2>Connect</h2>
  <p>Point an MCP client that supports remote Streamable HTTP + OAuth at:</p>
  <span class="ep">${mcpOrigin}/mcp</span>
  <p>The client opens a <strong>login form on this Worker</strong> (Emporia email/password).
     That is intentional — Emporia’s Cognito app does not allowlist third-party callback URLs,
     so Hosted UI OAuth cannot work on a personal fork.</p>
  <p>Or pass an Emporia Cognito ID token directly:</p>
  <span class="ep">Authorization: Bearer &lt;emporia-id-token&gt;</span>

  <p class="muted">Fork: <a href="https://github.com/NolanFoster/emporia-mcp">NolanFoster/emporia-mcp</a></p>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleRequest(
  request: Request,
  env: EmporiaEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const config = getConfig(env);

  // Health
  if (request.method === "GET" && (path === "/health" || path === "/debug/health")) {
    return Response.json({
      status: "OK",
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
    });
  }

  // Landing page
  if (request.method === "GET" && path === "/") {
    const origin = config.mcpOrigin || url.origin;
    return homePage(origin);
  }

  // OAuth + well-known
  const oauthResponse = await handleOAuthRequest(request, config);
  if (oauthResponse) return oauthResponse;

  // MCP protocol endpoints
  if (MCP_ROUTES.has(path)) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, mcp-session-id, Accept, Last-Event-ID",
          "Access-Control-Expose-Headers": "mcp-session-id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const auth = parseAuthorizationHeader(request.headers.get("Authorization"));
    if (!auth) {
      return unauthorized();
    }

    // Rewrite /streamable -> /mcp for the handler's default route matching
    let mcpRequest = request;
    if (path === "/streamable") {
      const rewritten = new URL(request.url);
      rewritten.pathname = "/mcp";
      mcpRequest = new Request(rewritten.toString(), request);
    }

    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
    });

    return runWithAuth(auth, () => handler(mcpRequest, env, ctx));
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(request: Request, env: EmporiaEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      log("Unhandled worker error", { error: String(error) }, "error", "WORKER");
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error),
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },
} satisfies ExportedHandler<EmporiaEnv>;
