import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export interface AuthOptions {
  // biome-ignore lint/suspicious/noExplicitAny: any app's Drizzle database and generated Better Auth schema
  db: NodePgDatabase<any>;
  schema: Record<string, unknown>;
  /** Google OAuth scopes requested at sign-in. */
  scopes: string[];
}

/** The MCP endpoint: the protected resource access tokens are bound to. */
export const resource = new URL("/mcp", process.env.BETTER_AUTH_URL).href;

/**
 * Better Auth as the OAuth 2.1 authorisation server for MCP clients, with
 * Google as the only sign-in provider.
 */
export function createAuth({ db, schema, scopes }: AuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
      usePlural: true,
      transaction: true,
    }),
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID as string,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        scope: scopes,
        accessType: "offline",
        prompt: "select_account consent",
      },
    },
    account: { encryptOAuthTokens: true },
    advanced: { database: { generateId: "uuid" } },
    plugins: [
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        // An existing session and stored consent would otherwise authorise
        // silently; always go through Google's account chooser instead.
        selectAccount: { page: "/sign-in", shouldRedirect: () => true },
        resource,
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
