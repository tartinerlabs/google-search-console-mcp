import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { db } from "../db/index.ts";
import * as schema from "../db/schema/auth.ts";

/** Google scope for read-only Search Console access. */
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

/** The MCP endpoint: the protected resource access tokens are bound to. */
export const resource = new URL("/mcp", process.env.BETTER_AUTH_URL).href;

export const auth = betterAuth({
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
      scope: SCOPES,
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
