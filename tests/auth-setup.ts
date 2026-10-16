import { createHash, randomBytes } from "node:crypto";
import { getAuthTables } from "@better-auth/core/db";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { serializeSignedCookie } from "better-call";
import { vi } from "vitest";
import { type Auth, authOptions } from "../src/auth/create-auth.ts";
import type { Env } from "../src/google/auth.ts";

let instance = 0;

/**
 * A real Better Auth instance on the in-memory adapter. Each instance gets its
 * own hostname so the process-wide JWKS cache never mixes signing keys.
 */
export async function createTestAuth(overrides: Env = {}) {
  instance += 1;
  const origin = `https://gsc-${instance}.example.com`;
  const env: Env = {
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    ALLOWED_EMAILS: "Owner@Example.com",
    ...overrides,
  };
  // The memory adapter needs every table to exist before Better Auth starts.
  const store: Record<string, Record<string, unknown>[]> = {};
  const options = authOptions(env, memoryAdapter(store));
  for (const table of Object.values(getAuthTables(options))) {
    store[table.modelName] = [];
  }
  const auth = betterAuth(options);
  return { auth, env, store, origin };
}

/** Create a user the way the Google callback does (through the user hooks) and a session cookie. */
export async function signIn(auth: Auth, email: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    { email: email.toLowerCase(), name: "Test User", emailVerified: true },
    { method: "oauth", oauth: { providerId: "google" } },
  );
  const session = await ctx.internalAdapter.createSession(user.id);
  const cookie = (
    await serializeSignedCookie(
      ctx.authCookies.sessionToken.name,
      session.token,
      ctx.secret,
    )
  ).split(";")[0];
  return { user, cookie: cookie ?? "" };
}

/** Store a Google account row for a user, as the OAuth callback would. */
export async function linkGoogle(
  auth: Auth,
  userId: string,
  fields: {
    scope?: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: Date;
  } = {},
) {
  const ctx = await auth.$context;
  return ctx.internalAdapter.createAccount({
    userId,
    providerId: "google",
    accountId: "google-sub-123",
    scope:
      fields.scope ??
      "openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/webmasters.readonly",
    accessToken: fields.accessToken ?? "google-access-token",
    refreshToken: fields.refreshToken,
    accessTokenExpiresAt:
      fields.accessTokenExpiresAt ?? new Date(Date.now() + 3_600_000),
  });
}

/** Register a public native client (what CIMD resolution would create). */
export async function registerClient(
  auth: Auth,
  cookie: string,
  clientName = "Test Client",
  redirectUri = "http://127.0.0.1/callback",
) {
  return auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie }),
    body: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      application_type: "native",
      client_name: clientName,
    },
  });
}

/** Run /oauth2/authorize for a signed-in user and return where Better Auth redirects. */
export async function authorize(
  auth: Auth,
  origin: string,
  clientId: string,
  cookie?: string,
  redirectUri = "http://127.0.0.1:53682/callback",
) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${origin}/api/auth/oauth2/authorize`);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid offline_access",
    state: "client-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await auth.handler(
    new Request(url, { headers: cookie ? { cookie } : {} }),
  );
  return {
    verifier,
    redirectUri: params.redirect_uri,
    location: new URL(response.headers.get("location") ?? "", origin),
  };
}

/** The full authorisation-code + PKCE flow, ending with a Better Auth access token for the MCP resource. */
export async function issueAccessToken(
  auth: Auth,
  origin: string,
  cookie: string,
): Promise<string> {
  const client = await registerClient(auth, cookie);
  const { verifier, redirectUri, location } = await authorize(
    auth,
    origin,
    client.client_id,
    cookie,
  );
  const consent = await auth.handler(
    new Request(`${origin}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({
        accept: true,
        oauth_query: location.search.slice(1),
      }),
    }),
  );
  const consented: unknown = await consent.json();
  const url =
    typeof consented === "object" &&
    consented !== null &&
    "url" in consented &&
    typeof consented.url === "string"
      ? consented.url
      : "";
  const code = URL.canParse(url)
    ? (new URL(url).searchParams.get("code") ?? "")
    : "";
  const token = await auth.handler(
    new Request(`${origin}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      }),
    }),
  );
  const body: unknown = await token.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    typeof body.access_token !== "string"
  ) {
    throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/**
 * requireMcpAuth fetches the JWKS from `<BETTER_AUTH_URL>/api/auth/jwks`.
 * Route those fetches into the in-process handler; anything else is refused.
 */
export function routeFetchTo(
  auth: Auth,
  origin: string,
  others: (request: Request) => Promise<Response> = async (request) => {
    throw new Error(`unexpected network request to ${request.url}`);
  },
) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return request.url.startsWith(origin)
        ? auth.handler(request)
        : others(request);
    },
  );
}
