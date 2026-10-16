import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { GscClientProvider } from "../google/client.ts";
import { siteUrlSchema } from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

export function registerSitemapsTool(
  server: McpServer,
  getClient: GscClientProvider,
): void {
  server.registerTool(
    "list_sitemaps",
    {
      title: "List submitted sitemaps",
      description:
        "List the sitemaps submitted for a Search Console property, with submission/download dates, error and warning counts and submitted URL counts.",
      inputSchema: z.object({ siteUrl: siteUrlSchema }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ siteUrl }) => {
      try {
        const response = await (await getClient()).listSitemaps(siteUrl);
        const sitemaps = (response.sitemap ?? []).map((sitemap) => ({
          path: sitemap.path ?? null,
          type: sitemap.type ?? null,
          isPending: sitemap.isPending ?? null,
          isSitemapsIndex: sitemap.isSitemapsIndex ?? null,
          lastSubmitted: sitemap.lastSubmitted ?? null,
          lastDownloaded: sitemap.lastDownloaded ?? null,
          errors: sitemap.errors ?? null,
          warnings: sitemap.warnings ?? null,
          contents: (sitemap.contents ?? []).map((content) => ({
            type: content.type ?? null,
            submitted: content.submitted ?? null,
          })),
        }));
        const result = {
          siteUrl,
          sitemaps,
          ...(sitemaps.length === 0 && {
            note: "No sitemaps have been submitted for this property.",
          }),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("list_sitemaps", error);
      }
    },
  );
}
