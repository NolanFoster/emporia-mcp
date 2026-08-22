/**
 * Runtime configuration for the Cloudflare Workers Emporia MCP Server.
 * Values come from Worker bindings / wrangler vars (see wrangler.jsonc).
 */

export interface EmporiaEnv {
  EMPORIA_LEGACY_API_ORIGIN: string;
  EMPORIA_API_ORIGIN: string;
  EMPORIA_AUTH_ORIGIN: string;
  EMPORIA_COGNITO_CLIENT_ID: string;
  EMPORIA_MCP_ORIGIN: string;
}

export const USER_AGENT = "emporia-mcp-cloudflare/1.0";

/** Default Cognito app client ID used by Emporia Energy accounts. */
export const DEFAULT_COGNITO_CLIENT_ID = "4qte47jbstod8apnfic0bunmrq";

export function getConfig(env: EmporiaEnv) {
  return {
    legacyApiOrigin: env.EMPORIA_LEGACY_API_ORIGIN || "https://api.emporiaenergy.com",
    apiOrigin: env.EMPORIA_API_ORIGIN || "https://c-api.emporiaenergy.com",
    authOrigin: env.EMPORIA_AUTH_ORIGIN || "https://auth.emporiaenergy.com",
    cognitoClientId: env.EMPORIA_COGNITO_CLIENT_ID || DEFAULT_COGNITO_CLIENT_ID,
    mcpOrigin: (env.EMPORIA_MCP_ORIGIN || "").replace(/\/$/, ""),
    userAgent: USER_AGENT,
  };
}

export type RuntimeConfig = ReturnType<typeof getConfig>;
