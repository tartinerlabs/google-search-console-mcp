import { isAPIError } from "better-auth/api";
import { OAuth2Client } from "google-auth-library";
import { SCOPES } from "../google/auth.ts";
import { createGscClient, type GscClient } from "../google/client.ts";
import { CredentialsError } from "../utils/errors.ts";
import type { Auth } from "./create-auth.ts";

/** Google stores granted scopes space-separated; Better Auth joins them with commas. */
function grantedScopes(scope: string | null | undefined): Set<string> {
  return new Set((scope ?? "").split(/[\s,]+/).filter(Boolean));
}

/**
 * Return a valid Google access token for a Better Auth user, refreshing it
 * through Better Auth when it is about to expire.
 */
export async function getGoogleAccessToken(
  auth: Auth,
  userId: string,
): Promise<string> {
  const { internalAdapter } = await auth.$context;
  const account = (await internalAdapter.findAccounts(userId)).find(
    (candidate) => candidate.providerId === "google",
  );
  if (!account) {
    throw new CredentialsError("No Google account is linked to this sign-in.");
  }

  // Google's granular consent lets the user untick the Search Console permission.
  const granted = grantedScopes(account.scope);
  if (!SCOPES.every((scope) => granted.has(scope))) {
    throw new CredentialsError(
      "Google did not grant access to Search Console data (the permission was not ticked on Google's consent screen).",
    );
  }

  let accessToken: string | undefined;
  try {
    // No headers or request: a server-side call identifies the user by
    // `userId`. Passing the MCP request would make Better Auth look for a
    // session cookie and fail with UNAUTHORIZED.
    ({ accessToken } = await auth.api.getAccessToken({
      body: { accountId: account.id, userId },
    }));
  } catch (error) {
    if (isAPIError(error)) {
      throw new CredentialsError(
        "Google refused to renew access: it has expired or been revoked. " +
          "Refresh tokens for OAuth apps in 'Testing' publishing status expire after 7 days.",
      );
    }
    throw error;
  }
  if (!accessToken) {
    throw new CredentialsError("No Google access token is stored.");
  }
  return accessToken;
}

/** A Search Console client acting as the given Better Auth user. */
export async function getUserGscClient(
  auth: Auth,
  userId: string,
): Promise<GscClient> {
  const client = new OAuth2Client();
  client.setCredentials({
    access_token: await getGoogleAccessToken(auth, userId),
  });
  return createGscClient(client);
}
