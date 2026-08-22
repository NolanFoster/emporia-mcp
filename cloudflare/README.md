# Emporia Energy MCP — Cloudflare Workers

Cloud-hosted [Model Context Protocol](https://modelcontextprotocol.io) server for Emporia Energy device data. This package ports the remote (SSE / Streamable HTTP) Emporia MCP server to **Cloudflare Workers** using the Agents SDK `createMcpHandler` (stateless Streamable HTTP).

> **BETA** — subject to change. Requires a native Emporia Energy account (email/password). Google/Apple sign-in accounts are not supported yet; create a shared email/password account if needed.

## Endpoints

| Path | Description |
|------|-------------|
| `POST /mcp` | MCP Streamable HTTP (primary) |
| `POST /streamable` | Alias of `/mcp` (compat with prior remote path) |
| `GET /oauth/authorize` | OAuth authorize → Cognito Hosted UI |
| `GET /oauth/callback` | Cognito → MCP client redirect |
| `POST /oauth/token` | Token proxy to Cognito |
| `POST /oauth/register` | Dynamic client registration |
| `GET /.well-known/oauth-authorization-server` | OAuth AS metadata |
| `GET /.well-known/oauth-protected-resource` | Protected resource metadata |
| `GET /health` | Liveness |

Authentication: `Authorization: Bearer <emporia-cognito-id-token>` on MCP requests. OAuth clients can complete the standard authorization-code + PKCE flow against this Worker; tokens are Emporia Cognito tokens usable against Emporia APIs.

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

## Local development

```bash
cd cloudflare
npm install
# Set the public origin used in OAuth metadata (use your workers.dev URL or a tunnel)
npx wrangler dev
```

Optional vars (see `wrangler.jsonc`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `EMPORIA_MCP_ORIGIN` | _(required in prod)_ | Public HTTPS origin of this Worker |
| `EMPORIA_API_ORIGIN` | `https://c-api.emporiaenergy.com` | Partner API |
| `EMPORIA_LEGACY_API_ORIGIN` | `https://api.emporiaenergy.com` | Legacy customer API |
| `EMPORIA_AUTH_ORIGIN` | `https://auth.emporiaenergy.com` | Cognito Hosted UI |
| `EMPORIA_COGNITO_CLIENT_ID` | Emporia public client id | Cognito app client |

```bash
# Typecheck
npm run typecheck

# Deploy manually
npm run deploy
```

## Auto-deploy on merge

GitHub Actions workflow [`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml) deploys this Worker whenever changes under `cloudflare/**` (or the workflow itself) land on `main`.

### One-time Cloudflare setup

1. Create a Cloudflare API token with **Workers Scripts:Edit** (and Account read) for the target account.
2. In the GitHub repo **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN` — the API token
   - `CLOUDFLARE_ACCOUNT_ID` — your account id
3. Optionally set repository **Variables**:
   - `EMPORIA_MCP_ORIGIN` — e.g. `https://emporia-mcp.<subdomain>.workers.dev` or a custom domain
4. After the first deploy, point a custom domain (e.g. `mcp.emporiaenergy.com`) at the Worker and set `EMPORIA_MCP_ORIGIN` to that origin. Cognito’s Hosted UI must allow `{EMPORIA_MCP_ORIGIN}/oauth/callback` as a callback URL.

### Manual deploy from CI

```bash
gh workflow run deploy-cloudflare.yml
```

## Connect an MCP client

Example Cursor / Claude desktop remote config:

```json
{
  "mcpServers": {
    "emporia": {
      "url": "https://mcp.emporiaenergy.com/mcp"
    }
  }
}
```

Clients that support MCP OAuth will discover `/.well-known/oauth-authorization-server` and complete login via Emporia Cognito. Clients that only support bearer headers can pass an Emporia ID token directly.

## Architecture

```
MCP Client ──Streamable HTTP──▶ Cloudflare Worker (/mcp)
                                    │
                                    ├─ Bearer token ──▶ Emporia APIs
                                    │
                                    └─ /oauth/* ──proxy──▶ Cognito Hosted UI
```

- **Stateless** MCP handler (`agents` + `@modelcontextprotocol/server`) — no Durable Object session affinity required for tool calls.
- Emporia API client and tool definitions are adapted from the root package `src/` for the Workers runtime (no Node filesystem logging, env via bindings).

## Relationship to the root package

| Path | Role |
|------|------|
| `/` (repo root) | Local stdio MCP + Express remote server (`src/index.ts`, `src/remote-server.ts`) |
| `/cloudflare` | This Workers deployment |

Keep tool behavior in sync when changing Emporia API usage in either tree.
