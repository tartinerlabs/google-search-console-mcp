import { requireMcpAuth } from "@better-auth/mcp";
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  type McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";
import { type Auth, resource } from "./auth.ts";

export interface McpEndpointOptions {
  auth: Auth;
  logger: Logger;
  /** Builds a fresh server per request, acting as the token's user. */
  createServer: (authInfo: AuthInfo | undefined) => McpServer;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Hostnames accepted in the Host header: the resource's, MCP_ALLOWED_HOSTS and Vercel's system URLs. */
const allowedHostnames = [
  new URL(resource).hostname,
  ...list(process.env.MCP_ALLOWED_HOSTS),
  ...list(process.env.VERCEL_URL),
  ...list(process.env.VERCEL_BRANCH_URL),
  ...list(process.env.VERCEL_PROJECT_PRODUCTION_URL),
];

/** The raw access token (Bearer or DPoP scheme) already verified by requireMcpAuth. */
function presentedToken(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(/^\S+\s+/, "");
}

/**
 * The MCP endpoint: Host/Origin validation, then Better Auth's
 * `requireMcpAuth`, then the stateless MCP handler acting as the token's user.
 */
export function createMcpEndpoint({
  auth,
  logger,
  createServer,
}: McpEndpointOptions): (request: Request) => Promise<Response> {
  const handler = createMcpHandler((ctx) => createServer(ctx.authInfo), {
    onerror: (error) =>
      logger.error(
        { errorName: error.name, errorMessage: error.message },
        "MCP HTTP error",
      ),
  });

  const authorised = requireMcpAuth(
    auth,
    (request, claims) => {
      const authInfo: AuthInfo = {
        token: presentedToken(request),
        clientId: String(claims.azp ?? claims.client_id ?? ""),
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
        expiresAt: claims.exp,
        resource: new URL(resource),
        extra: { userId: claims.sub },
      };
      return handler.fetch(request, { authInfo });
    },
    { resource },
  );

  return async (request) => {
    const badHost = hostHeaderValidationResponse(request, allowedHostnames);
    if (badHost) return badHost;
    const badOrigin = originValidationResponse(
      request,
      list(process.env.MCP_ALLOWED_ORIGINS),
    );
    if (badOrigin) return badOrigin;
    return authorised(request);
  };
}
