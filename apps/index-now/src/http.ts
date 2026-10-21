import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createIndexNowClient } from "./indexnow/client.ts";
import { createServer } from "./server.ts";
import { logger } from "./utils/logger.ts";

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Hostnames accepted in the Host header: MCP_ALLOWED_HOSTS and Vercel's system URLs. */
const allowedHostnames = [
  ...list(process.env.MCP_ALLOWED_HOSTS),
  ...list(process.env.VERCEL_URL),
  ...list(process.env.VERCEL_BRANCH_URL),
  ...list(process.env.VERCEL_PROJECT_PRODUCTION_URL),
];

// Serves 2025-era clients too (the default `legacy: "stateless"`): without
// sign-in, nothing ties this server to the 2026-07-28 protocol.
const handler = createMcpHandler(() => createServer(createIndexNowClient), {
  onerror: (error) =>
    logger.error(
      { errorName: error.name, errorMessage: error.message },
      "MCP HTTP error",
    ),
});

/**
 * The MCP endpoint, open without sign-in: the site's key file is what
 * authorises a submission. Host/Origin validation guards against DNS rebinding.
 */
export async function handleMcp(request: Request): Promise<Response> {
  const badHost = hostHeaderValidationResponse(request, allowedHostnames);
  if (badHost) return badHost;
  const badOrigin = originValidationResponse(
    request,
    list(process.env.MCP_ALLOWED_ORIGINS),
  );
  if (badOrigin) return badOrigin;
  return handler.fetch(request);
}
