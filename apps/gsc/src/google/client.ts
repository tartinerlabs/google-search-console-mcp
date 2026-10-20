import {
  searchconsole,
  type searchconsole_v1,
} from "@googleapis/searchconsole";
import { isAPIError } from "better-auth/api";
import { OAuth2Client } from "google-auth-library";
import { auth, SCOPES } from "../lib/auth.ts";
import { CredentialsError } from "../utils/errors.ts";

type SearchAnalyticsRequest =
  searchconsole_v1.Schema$SearchAnalyticsQueryRequest;
export type SearchAnalyticsResponse =
  searchconsole_v1.Schema$SearchAnalyticsQueryResponse;
type InspectUrlRequest = searchconsole_v1.Schema$InspectUrlIndexRequest;
type InspectUrlResponse = searchconsole_v1.Schema$InspectUrlIndexResponse;
type SitesListResponse = searchconsole_v1.Schema$SitesListResponse;
type SitemapsListResponse = searchconsole_v1.Schema$SitemapsListResponse;

/** The Search Console operations the MCP tools depend on. */
export interface GscClient {
  listSites(): Promise<SitesListResponse>;
  listSitemaps(siteUrl: string): Promise<SitemapsListResponse>;
  querySearchAnalytics(
    siteUrl: string,
    body: SearchAnalyticsRequest,
  ): Promise<SearchAnalyticsResponse>;
  inspectUrl(body: InspectUrlRequest): Promise<InspectUrlResponse>;
}

/**
 * Resolves the client lazily, inside each tool call, so the server starts
 * without credentials and auth failures surface as tool errors.
 */
export type GscClientProvider = () => GscClient | Promise<GscClient>;

function createGscClient(auth: OAuth2Client): GscClient {
  const api = searchconsole({ version: "v1", auth });
  return {
    async listSites() {
      return (await api.sites.list()).data;
    },
    async listSitemaps(siteUrl) {
      return (await api.sitemaps.list({ siteUrl })).data;
    },
    async querySearchAnalytics(siteUrl, body) {
      return (await api.searchanalytics.query({ siteUrl, requestBody: body }))
        .data;
    },
    async inspectUrl(body) {
      return (await api.urlInspection.index.inspect({ requestBody: body }))
        .data;
    },
  };
}

/** A Search Console client acting as the given Better Auth user. */
export async function getUserGscClient(userId: string): Promise<GscClient> {
  const { internalAdapter } = await auth.$context;
  const account = (await internalAdapter.findAccounts(userId)).find(
    (candidate) => candidate.providerId === "google",
  );
  if (!account) {
    throw new CredentialsError("No Google account is linked to this sign-in.");
  }

  // Google's granular consent lets the user untick the Search Console permission.
  const granted = new Set((account.scope ?? "").split(/[\s,]+/));
  if (!SCOPES.every((scope) => granted.has(scope))) {
    throw new CredentialsError(
      "Google did not grant access to Search Console data (the permission was not ticked on Google's consent screen).",
    );
  }

  let accessToken: string | undefined;
  try {
    // Refreshes the token first when it has expired.
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

  const client = new OAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return createGscClient(client);
}
