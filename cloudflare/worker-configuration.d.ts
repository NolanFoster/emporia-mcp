interface Env {
  EMPORIA_LEGACY_API_ORIGIN: string;
  EMPORIA_API_ORIGIN: string;
  EMPORIA_AUTH_ORIGIN: string;
  EMPORIA_COGNITO_CLIENT_ID: string;
  /**
   * Public origin of this MCP Worker, e.g. https://mcp.emporiaenergy.com
   * Used for OAuth metadata and Cognito callback redirects.
   */
  EMPORIA_MCP_ORIGIN: string;
}
