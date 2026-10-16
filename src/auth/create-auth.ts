import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins/jwt";
import { type Env, SCOPES } from "../google/auth.ts";
import { logger } from "../utils/logger.ts";

/** Paths of the two pages served next to the auth API (see api/sign-in.ts and api/consent.ts). */
const SIGN_IN_PATH = "/sign-in";
const CONSENT_PATH = "/consent";

/**
 * Protected resource metadata (RFC 9728) for `/mcp`, served outside
 * `/.well-known` because Vercel does not rewrite that path. The 401 challenge
 * from /mcp points here (see src/http.ts).
 */
const RESOURCE_METADATA_PATH = "/api/auth/oauth-protected-resource/mcp";

/** Parse ALLOWED_EMAILS (comma-separated, case-insensitive). */
function parseAllowedEmails(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * A user may sign in only with a Google-verified email on ALLOWED_EMAILS.
 * Fail closed: an empty or unset allow-list admits nobody.
 */
export function isUserAllowed(
  user: { email?: string | null; emailVerified?: boolean | null },
  env: Env,
): boolean {
  if (!user.email || user.emailVerified !== true) return false;
  return parseAllowedEmails(env.ALLOWED_EMAILS).has(
    user.email.trim().toLowerCase(),
  );
}

/** The canonical MCP resource URL: `<origin of BETTER_AUTH_URL>/mcp`. */
export function mcpResourceUrl(env: Env): string {
  return new URL("/mcp", env.BETTER_AUTH_URL).toString();
}

/** Absolute URL of the protected resource metadata advertised in the 401 challenge. */
export function resourceMetadataUrl(env: Env): string {
  return new URL(RESOURCE_METADATA_PATH, env.BETTER_AUTH_URL).toString();
}

/**
 * Better Auth options: an OAuth 2.1 authorisation server for MCP clients
 * (CIMD only, no dynamic client registration) with Google as the only way to
 * sign in. The caller supplies the database (the Drizzle adapter in production, the
 * memory adapter in tests).
 */
export function authOptions(
  env: Env,
  database: NonNullable<BetterAuthOptions["database"]>,
) {
  return {
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database,
    logger: {
      // Route Better Auth's logs to Pino on stderr. Extra arguments are dropped:
      // they can carry request data, and only the message is needed.
      log: (level, message, ...args) => {
        const error = args.find((arg) => arg instanceof Error);
        const fields = {
          source: "better-auth",
          ...(error && { errorName: error.name }),
        };
        if (level === "error") logger.error(fields, message);
        else if (level === "warn") logger.warn(fields, message);
        else if (level === "info") logger.info(fields, message);
        else logger.debug(fields, message);
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID as string,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: SCOPES,
        // A refresh token is needed so tools keep working after the first hour.
        accessType: "offline",
        prompt: "select_account consent",
      },
    },
    account: { encryptOAuthTokens: true },
    advanced: { database: { generateId: "uuid" } },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isUserAllowed(user, env)) {
              logger.warn(
                "sign-up refused: email is unverified or not in ALLOWED_EMAILS",
              );
              throw new APIError("FORBIDDEN", {
                message:
                  "This Google account is not allowed to use this server.",
              });
            }
          },
        },
      },
    },
    plugins: [
      jwt(),
      mcp({
        resource: mcpResourceUrl(env),
        loginPage: SIGN_IN_PATH,
        consentPage: CONSENT_PATH,
        // Tokens must always belong to a signed-in user: no client_credentials.
        grantTypes: ["authorization_code", "refresh_token"],
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(
  env: Env,
  database: NonNullable<BetterAuthOptions["database"]>,
) {
  return betterAuth(authOptions(env, database));
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The `api/auth.ts` handler: Better Auth, plus the protected resource metadata
 * at RESOURCE_METADATA_PATH (mapped onto the `/.well-known` path Better Auth
 * serves it at).
 */
export function createAuthHandler(auth: Auth) {
  return (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== RESOURCE_METADATA_PATH) return auth.handler(request);
    url.pathname = "/.well-known/oauth-protected-resource/mcp";
    return auth.handler(new Request(url, request));
  };
}
