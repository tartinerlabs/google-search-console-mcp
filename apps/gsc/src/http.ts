import { requireMcpAuth } from "@better-auth/mcp";
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { getUserGscClient } from "./google/client.ts";
import { auth, resource } from "./lib/auth.ts";
import { createServer } from "./server.ts";
import { CredentialsError } from "./utils/errors.ts";
import { logger } from "./utils/logger.ts";

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

function userIdOf(authInfo: AuthInfo | undefined): string {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string") {
    throw new CredentialsError(
      "The request is not linked to a signed-in user.",
    );
  }
  return userId;
}

const handler = createMcpHandler(
  (ctx) => createServer(() => getUserGscClient(userIdOf(ctx.authInfo))),
  {
    onerror: (error) =>
      logger.error(
        { errorName: error.name, errorMessage: error.message },
        "MCP HTTP error",
      ),
  },
);

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

/**
 * The MCP endpoint: Host/Origin validation, then Better Auth's
 * `requireMcpAuth`, then the stateless MCP handler acting as the token's user.
 */
export async function handleMcp(request: Request): Promise<Response> {
  const badHost = hostHeaderValidationResponse(request, allowedHostnames);
  if (badHost) return badHost;
  const badOrigin = originValidationResponse(
    request,
    list(process.env.MCP_ALLOWED_ORIGINS),
  );
  if (badOrigin) return badOrigin;
  return authorised(request);
}
