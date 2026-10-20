import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { GscClientProvider } from "./google/client.ts";
import { registerAnalyticsTool } from "./tools/analytics.ts";
import { registerComparePeriodsTool } from "./tools/compare-periods.ts";
import { registerInspectionTool } from "./tools/inspection.ts";
import { registerOpportunitiesTool } from "./tools/opportunities.ts";
import { registerSitemapsTool } from "./tools/sitemaps.ts";
import { registerSitesTool } from "./tools/sites.ts";

const SERVER_NAME = "google-search-console";
const SERVER_VERSION = "0.1.0";

/** Server factory for the HTTP handler. */
export function createServer(getClient: GscClientProvider): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Check whether the Google Search Console MCP server is running.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        { type: "text", text: "Google Search Console MCP is running." },
      ],
    }),
  );

  registerSitesTool(server, getClient);
  registerAnalyticsTool(server, getClient);
  registerComparePeriodsTool(server, getClient);
  registerOpportunitiesTool(server, getClient);
  registerInspectionTool(server, getClient);
  registerSitemapsTool(server, getClient);

  return server;
}
