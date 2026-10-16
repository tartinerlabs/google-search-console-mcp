import { requireMcpAuth } from "@better-auth/mcp";
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import {
  type Auth,
  isUserAllowed,
  mcpResourceUrl,
  resourceMetadataUrl,
} from "./auth/create-auth.ts";
import { getUserGscClient } from "./auth/google-token.ts";
import type { Env } from "./google/auth.ts";
import type { GscClient } from "./google/client.ts";
import { createServer } from "./server.ts";
import { CredentialsError } from "./utils/errors.ts";
import { logger } from "./utils/logger.ts";

/** Builds the Search Console client for a Better Auth user id. */
type UserClientFactory = (userId: string) => Promise<GscClient>;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Hostnames accepted in the Host header: BETTER_AUTH_URL's, MCP_ALLOWED_HOSTS and Vercel's system URLs. */
function allowedHostnames(env: Env): string[] {
  return [
    new URL(mcpResourceUrl(env)).hostname,
    ...list(env.MCP_ALLOWED_HOSTS),
    ...list(env.VERCEL_URL),
    ...list(env.VERCEL_BRANCH_URL),
    ...list(env.VERCEL_PROJECT_PRODUCTION_URL),
  ];
}

function forbidden(message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32003, message }, id: null },
    { status: 403 },
  );
}

/**
 * requireMcpAuth always points `resource_metadata` at `/.well-known/...`, which
 * Vercel cannot rewrite to a function; point it at the copy under /api/auth.
 */
function withResourceMetadata(response: Response, env: Env): Response {
  const challenge = response.headers.get("www-authenticate");
  if (!challenge) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "www-authenticate",
    challenge.replace(
      /resource_metadata="[^"]*"/,
      `resource_metadata="${resourceMetadataUrl(env)}"`,
    ),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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

/**
 * The remote MCP endpoint: Host/Origin validation, then Better Auth's
 * `requireMcpAuth` (JWT signature, issuer, audience and expiry, with an
 * RFC 9728 401 challenge when missing), then an allow-list check of the
 * token's user, then the stateless MCP handler acting as that user.
 */
export function createHttpHandler(
  auth: Auth,
  env: Env,
  clientForUser: UserClientFactory = (userId) => getUserGscClient(auth, userId),
) {
  const handler = createMcpHandler(
    (ctx) => createServer(() => clientForUser(userIdOf(ctx.authInfo))),
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
    async (request, claims) => {
      const userId = claims.sub;
      const user = userId
        ? await (await auth.$context).internalAdapter.findUserById(userId)
        : null;
      // Re-checked on every request so removing an email takes effect before
      // already-issued access tokens expire.
      if (!userId || !user || !isUserAllowed(user, env)) {
        logger.warn(
          "MCP request refused: user is unverified or not in ALLOWED_EMAILS",
        );
        return forbidden("This account is not allowed to use this server.");
      }
      const authInfo: AuthInfo = {
        token: presentedToken(request),
        clientId: String(claims.azp ?? claims.client_id ?? ""),
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
        expiresAt: claims.exp,
        resource: new URL(mcpResourceUrl(env)),
        extra: { userId },
      };
      return handler.fetch(request, { authInfo });
    },
    { resource: mcpResourceUrl(env) },
  );

  return async function fetch(request: Request): Promise<Response> {
    const badHost = hostHeaderValidationResponse(
      request,
      allowedHostnames(env),
    );
    if (badHost) return badHost;
    const badOrigin = originValidationResponse(
      request,
      list(env.MCP_ALLOWED_ORIGINS),
    );
    if (badOrigin) return badOrigin;
    return withResourceMetadata(await authorised(request), env);
  };
}
