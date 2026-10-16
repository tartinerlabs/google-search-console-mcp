import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { db } from "../db/index.ts";
import * as schema from "../db/schema/auth.ts";

/** Google scope for read-only Search Console access. */
export const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

/** The MCP endpoint: the protected resource access tokens are bound to. */
export const resource = new URL("/mcp", process.env.BETTER_AUTH_URL).href;

/**
 * A user may sign in only with a Google-verified email on ALLOWED_EMAILS
 * (comma-separated, case-insensitive). An empty or unset list admits nobody.
 */
export function isUserAllowed(user: {
  email?: string | null;
  emailVerified?: boolean | null;
}): boolean {
  if (!user.email || user.emailVerified !== true) return false;
  const allowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase());
  return allowed.includes(user.email.trim().toLowerCase());
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: true,
    transaction: true,
  }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      scope: SCOPES,
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
          if (!isUserAllowed(user)) {
            throw new APIError("FORBIDDEN", {
              message: "This Google account is not allowed to use this server.",
            });
          }
        },
      },
    },
  },
  plugins: [
    jwt(),
    mcp({
      loginPage: "/sign-in",
      consentPage: "/consent",
      resource,
    }),
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ],
});
