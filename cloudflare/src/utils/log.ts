/**
 * Cloudflare Workers-safe logger (console only — no filesystem).
 */
export function log(
  message: string,
  data: unknown = null,
  level: "debug" | "info" | "error" = "info",
  prefix: string = "MCP",
): void {
  const timestamp = new Date().toISOString();
  const logMsg = data != null ? `${message}: ${safeStringify(data)}` : message;
  const formatted = `[${prefix} ${timestamp}] [${level.toUpperCase()}] ${logMsg}`;

  if (level === "error") {
    console.error(formatted);
  } else if (level === "debug") {
    console.debug(formatted);
  } else {
    console.log(formatted);
  }
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
