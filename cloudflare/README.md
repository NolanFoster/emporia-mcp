# Emporia Energy MCP — Cloudflare Workers

Cloud-hosted [Model Context Protocol](https://modelcontextprotocol.io) server for Emporia Energy device data. This package ports the remote (SSE / Streamable HTTP) Emporia MCP server to **Cloudflare Workers** using the Agents SDK `createMcpHandler` (stateless Streamable HTTP).

> **BETA** — subject to change. Requires a **native** Emporia Energy account (email/password). Google/Apple sign-in accounts are not supported yet; create a shared email/password account if needed.

## Live deployment (this fork)

| | |
|--|--|
| MCP | https://emporia-mcp.nolanfoster.workers.dev/mcp |
| Health | https://emporia-mcp.nolanfoster.workers.dev/health |
| OAuth metadata | https://emporia-mcp.nolanfoster.workers.dev/.well-known/oauth-authorization-server |

## Why username/password (not Emporia Hosted UI)?

The **root package README** documents `EMPORIA_ACCOUNT` / `EMPORIA_PASSWORD` for the **local stdio** server. Remote MCP normally uses OAuth.

Emporia’s official remote server (`https://mcp.emporiaenergy.com`) works with Cognito Hosted UI because Emporia allowlisted:

```text
https://mcp.emporiaenergy.com/oauth/callback
```

on their Cognito app client. A personal fork **cannot** add:

```text
https://emporia-mcp.nolanfoster.workers.dev/oauth/callback
```

Cognito then returns **`redirect_mismatch`** — that is the OAuth error you hit.

**This Worker solves it** by running its own authorization server:

1. MCP client discovers OAuth metadata on the Worker  
2. Browser opens **`/oauth/authorize`** → email/password form **on this Worker**  
3. Worker calls Cognito `USER_PASSWORD_AUTH` (same as local MCP)  
4. Worker issues a one-time code back to the MCP client and serves tokens at `/oauth/token`  
5. Client calls `/mcp` with `Authorization: Bearer <IdToken>`

Credentials are sent to **Emporia Cognito only**; they are not stored on the Worker.

## Endpoints

| Path | Description |
|------|-------------|
| `POST /mcp` | MCP Streamable HTTP (primary) |
| `POST /streamable` | Alias of `/mcp` |
| `GET /oauth/authorize` | Login form (email/password) |
| `POST /oauth/login` | Validate credentials → redirect with `code` |
| `POST /oauth/token` | Exchange `code` / refresh for tokens |
| `POST /oauth/register` | Dynamic client registration |
| `GET /.well-known/oauth-authorization-server` | OAuth AS metadata |
| `GET /.well-known/oauth-protected-resource` | Protected resource metadata |
| `GET /health` | Liveness |

Authentication on MCP: `Authorization: Bearer <emporia-cognito-id-token>`.

## Tools

Same tool surface as the local / Express remote server:

- `listDevices`
- `getDevicesChannels`
- `getDeviceDetails`
- `getBatteryStateOfCharge`
- `getEVChargingReport`
- `getEVChargerSessions`
- `getDevicePowerUsage`
- `getDeviceEnergyUsage`

## Connect an MCP client

### OAuth (recommended)

```json
{
  "mcpServers": {
    "emporia": {
      "url": "https://emporia-mcp.nolanfoster.workers.dev/mcp"
    }
  }
}
```

Client opens the Worker login page → enter your **native** Emporia email/password → tokens attach automatically.

### Static bearer (if the client supports custom headers)

1. Complete a login once (or use any Cognito IdToken for your account).  
2. Configure:

```json
{
  "mcpServers": {
    "emporia": {
      "url": "https://emporia-mcp.nolanfoster.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <emporia-id-token>"
      }
    }
  }
}
```

Tokens expire (~1 hour). Prefer OAuth so refresh works.

### Do **not** put EMPORIA_ACCOUNT / EMPORIA_PASSWORD on the Worker

Those env vars are for **local stdio only**. Cloud mode never reads them.

## Local development

```bash
cd cloudflare
npm install
npx wrangler dev
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMPORIA_MCP_ORIGIN` | _(required in prod)_ | Public HTTPS origin of this Worker |
| `EMPORIA_API_ORIGIN` | `https://c-api.emporiaenergy.com` | Partner API |
| `EMPORIA_LEGACY_API_ORIGIN` | `https://api.emporiaenergy.com` | Legacy customer API |
| `EMPORIA_AUTH_ORIGIN` | `https://auth.emporiaenergy.com` | (unused for login form; kept for parity) |
| `EMPORIA_COGNITO_CLIENT_ID` | Emporia public app client | Cognito `USER_PASSWORD_AUTH` client id |

```bash
npm run typecheck
npm run deploy
```

## Deploy

Native **Cloudflare Workers Builds** (dashboard Git integration) with:

- **Root directory:** `cloudflare`
- **Production branch:** `main`
- **Build command:** `npm run build` (typecheck)
- **Deploy command:** `npx wrangler deploy`

Push to `main` under `cloudflare/**` auto-deploys.

## Architecture

```
MCP Client ──Streamable HTTP──▶ Cloudflare Worker (/mcp)
                                    │
                                    ├─ Bearer IdToken ──▶ Emporia APIs
                                    │
                                    └─ /oauth/* ── login form ──▶ Cognito USER_PASSWORD_AUTH
```

- **Stateless** MCP handler (`agents` + `@modelcontextprotocol/server`).
- OAuth pending codes live in isolate memory (short TTL). Fine for interactive login; not a multi-colo durable store.

## Relationship to the root package

| Path | Role |
|------|------|
| `/` (repo root) | Local stdio MCP + Express remote server |
| `/cloudflare` | This Workers deployment |

Local stdio uses env username/password. This cloud port uses the same Cognito password API behind an MCP-compatible OAuth facade so remote clients keep working without Emporia allowlisting your callback URL.
