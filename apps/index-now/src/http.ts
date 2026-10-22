import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import {
  createIndexNowClient,
  type SubmissionWorkflow,
} from "./indexnow/client.ts";
import { createServer } from "./server.ts";
import { logger } from "./utils/logger.ts";

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Hostnames accepted in the Host header; unset accepts any, as a public Worker is not exposed to DNS rebinding. */
const allowedHostnames = list(process.env.MCP_ALLOWED_HOSTS);

/**
 * The MCP endpoint, open without sign-in: the site's key file is what
 * authorises a submission. Origin validation blocks cross-site browser requests.
 */
export async function handleMcp(
  request: Request,
  workflow: SubmissionWorkflow,
): Promise<Response> {
  if (allowedHostnames.length > 0) {
    const badHost = hostHeaderValidationResponse(request, allowedHostnames);
    if (badHost) return badHost;
  }
  const badOrigin = originValidationResponse(
    request,
    list(process.env.MCP_ALLOWED_ORIGINS),
  );
  if (badOrigin) return badOrigin;
  // Built per request, as the Workflow binding arrives with each request's env.
  // Serves 2025-era clients too (the default `legacy: "stateless"`): without
  // sign-in, nothing ties this server to the 2026-07-28 protocol.
  const handler = createMcpHandler(
    () => createServer(() => createIndexNowClient(workflow)),
    {
      onerror: (error) =>
        logger.error(
          { errorName: error.name, errorMessage: error.message },
          "MCP HTTP error",
        ),
    },
  );
  return handler.fetch(request);
}
