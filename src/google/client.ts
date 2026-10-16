import {
  searchconsole,
  type searchconsole_v1,
} from "@googleapis/searchconsole";
import type { OAuth2Client } from "google-auth-library";

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

export function createGscClient(auth: OAuth2Client): GscClient {
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
