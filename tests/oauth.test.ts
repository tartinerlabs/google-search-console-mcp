import { getAuthTables } from "@better-auth/core/db";
import { type Column, getColumns, getTableName, is, Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAuthHandler, isUserAllowed } from "../src/auth/create-auth.ts";
import * as schema from "../src/auth/schema.ts";
import { createConsentHandler, createSignInHandler } from "../src/pages.ts";
import {
  authorize,
  createTestAuth,
  registerClient,
  signIn,
} from "./auth-setup.ts";

describe("discovery metadata", () => {
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("should serve protected resource metadata at %s", async (path) => {
    const { auth, origin } = await createTestAuth();
    const response = await auth.handler(new Request(`${origin}${path}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/api/auth`],
      bearer_methods_supported: ["header"],
    });
  });

  it("should serve protected resource metadata outside /.well-known for Vercel", async () => {
    const { auth, origin } = await createTestAuth();
    const response = await createAuthHandler(auth)(
      new Request(`${origin}/api/auth/oauth-protected-resource/mcp`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/api/auth`],
    });
  });

  it.each([
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/.well-known/openid-configuration",
  ])(
    "should advertise CIMD, public clients and S256 only at %s",
    async (path) => {
      const { auth, origin } = await createTestAuth();
      const response = await auth.handler(new Request(`${origin}${path}`));
      expect(response.status).toBe(200);
      const metadata = await response.json();
      expect(metadata.issuer).toBe(`${origin}/api/auth`);
      expect(metadata.client_id_metadata_document_supported).toBe(true);
      expect(metadata.token_endpoint_auth_methods_supported).toContain("none");
      expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
      expect(metadata.authorization_endpoint).toBe(
        `${origin}/api/auth/oauth2/authorize`,
      );
      // Dynamic client registration stays off; only user-bound grants exist.
      expect(metadata.registration_endpoint).toBeUndefined();
      expect(metadata.grant_types_supported).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
    },
  );
});

describe("allow-list at sign-up", () => {
  it("should create an allow-listed user, ignoring case and spaces", async () => {
    const { auth } = await createTestAuth({
      ALLOWED_EMAILS: " other@example.com , Owner@Example.com ",
    });
    const { user } = await signIn(auth, "owner@example.COM");
    expect(user.id).toBeTruthy();
  });

  it("should refuse an email that is not listed", async () => {
    const { auth, store } = await createTestAuth();
    await expect(signIn(auth, "intruder@example.com")).rejects.toMatchObject({
      status: "FORBIDDEN",
    });
    expect(store.user).toHaveLength(0);
  });

  it("should fail closed when ALLOWED_EMAILS is empty", async () => {
    const { auth } = await createTestAuth({ ALLOWED_EMAILS: "" });
    await expect(signIn(auth, "owner@example.com")).rejects.toMatchObject({
      status: "FORBIDDEN",
    });
    expect(
      isUserAllowed({ email: "owner@example.com", emailVerified: true }, {}),
    ).toBe(false);
  });

  it("should refuse an allow-listed email that Google has not verified", async () => {
    const { auth, store } = await createTestAuth();
    const ctx = await auth.$context;
    await expect(
      ctx.internalAdapter.createUser(
        { email: "owner@example.com", name: "Test User", emailVerified: false },
        { method: "oauth", oauth: { providerId: "google" } },
      ),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(store.user).toHaveLength(0);
  });
});

describe("authorisation flow", () => {
  it("should send a signed-out user to /sign-in with a signed query", async () => {
    const { auth, origin } = await createTestAuth();
    const { cookie } = await signIn(auth, "owner@example.com");
    const client = await registerClient(auth, cookie);
    const { location } = await authorize(auth, origin, client.client_id);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("client_id")).toBe(client.client_id);
    expect(location.searchParams.get("sig")).toBeTruthy();
  });

  it("should start Google sign-in from /sign-in with the Search Console scope and offline access", async () => {
    const { auth, origin, store } = await createTestAuth();
    const { cookie } = await signIn(auth, "owner@example.com");
    const client = await registerClient(auth, cookie);
    const { location } = await authorize(auth, origin, client.client_id);

    const response = await createSignInHandler(auth)(
      new Request(`${origin}/sign-in${location.search}`),
    );
    expect(response.status).toBe(302);
    const google = new URL(response.headers.get("location") ?? "");
    expect(google.origin + google.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(google.searchParams.get("scope")?.split(" ")).toContain(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("prompt")).toBe("consent");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/google`,
    );
    expect(response.headers.getSetCookie().join(";")).toContain(
      "better-auth.state=",
    );
    // The MCP client's authorisation request is kept in the Google OAuth state
    // so Better Auth can resume it after the Google callback.
    expect(JSON.stringify(store.verification)).toContain(client.client_id);
  });

  it("should refuse a tampered query on /sign-in", async () => {
    const { auth, origin } = await createTestAuth();
    const { cookie } = await signIn(auth, "owner@example.com");
    const client = await registerClient(auth, cookie);
    const { location } = await authorize(auth, origin, client.client_id);
    location.searchParams.set("redirect_uri", "https://evil.example.net/cb");

    const response = await createSignInHandler(auth)(
      new Request(`${origin}/sign-in${location.search}`),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("should ask a signed-in user for consent, naming the client and redirect host", async () => {
    const { auth, origin } = await createTestAuth();
    const { cookie } = await signIn(auth, "owner@example.com");
    const client = await registerClient(
      auth,
      cookie,
      '<script>alert("x")</script>',
    );
    const { location } = await authorize(
      auth,
      origin,
      client.client_id,
      cookie,
    );
    expect(location.pathname).toBe("/consent");

    const response = await createConsentHandler(auth)(
      new Request(`${origin}/consent${location.search}`, {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toMatch(
      /script-src 'sha256-[^']+'/,
    );
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("<code>127.0.0.1:53682</code>");
    expect(html).toContain("owner@example.com");
  });

  it("should show the full redirect URI when it has no host (private-use scheme)", async () => {
    const { auth, origin } = await createTestAuth();
    const { cookie } = await signIn(auth, "owner@example.com");
    const redirectUri = "com.example.app:/oauth/callback";
    const client = await registerClient(
      auth,
      cookie,
      "Native App",
      redirectUri,
    );
    const { location } = await authorize(
      auth,
      origin,
      client.client_id,
      cookie,
      redirectUri,
    );
    expect(location.pathname).toBe("/consent");
    const response = await createConsentHandler(auth)(
      new Request(`${origin}/consent${location.search}`, {
        headers: { cookie },
      }),
    );
    expect(await response.text()).toContain(`<code>${redirectUri}</code>`);
  });

  it("should refuse a request without a session on /consent", async () => {
    const { auth, origin } = await createTestAuth();
    const { cookie } = await signIn(auth, "owner@example.com");
    const client = await registerClient(auth, cookie);
    const { location } = await authorize(
      auth,
      origin,
      client.client_id,
      cookie,
    );
    const response = await createConsentHandler(auth)(
      new Request(`${origin}/consent${location.search}`),
    );
    expect(response.status).toBe(401);
  });
});

describe("drizzle schema", () => {
  it("should match Better Auth's tables, nullability and uniqueness", async () => {
    const { auth } = await createTestAuth();
    const tables = new Map<string, Record<string, Column>>(
      Object.values(schema)
        .filter((value) => is(value, Table))
        .map((table) => [getTableName(table), getColumns(table)]),
    );
    for (const { modelName, fields } of Object.values(
      getAuthTables(auth.options),
    )) {
      const columns = tables.get(modelName);
      expect(columns, modelName).toBeDefined();
      for (const [key, field] of Object.entries(fields)) {
        const name = `${modelName}.${field.fieldName ?? key}`;
        const column = Object.values(columns ?? {}).find(
          (c) => c.name === (field.fieldName ?? key),
        );
        expect(column, name).toBeDefined();
        expect(column?.notNull, name).toBe(field.required !== false);
        expect(column?.isUnique, name).toBe(field.unique === true);
      }
    }
  });
});
