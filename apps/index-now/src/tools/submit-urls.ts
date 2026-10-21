import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { IndexNowClientProvider } from "../indexnow/client.ts";
import { isCoveredBy } from "../indexnow/key.ts";
import {
  keyLocationSchema,
  keySchema,
  parsePublicUrl,
  publicUrlSchema,
} from "../schemas/common.ts";
import { toToolError } from "../utils/errors.ts";

// IndexNow accepts up to 10,000 URLs in one POST.
const MAX_URLS = 10_000;

const inputSchema = z
  .object({
    urls: z
      .array(publicUrlSchema)
      .min(1)
      .max(MAX_URLS)
      .describe(
        "Production URLs that were added, updated or deleted, all on one host. Call once per host.",
      ),
    key: keySchema,
    keyLocation: keyLocationSchema,
  })
  .superRefine((input, ctx) => {
    // Field checks already reported unparsable URLs.
    const urls = input.urls.map(parsePublicUrl);
    const keyLocation =
      input.keyLocation === undefined
        ? undefined
        : parsePublicUrl(input.keyLocation);
    if (
      urls.length === 0 ||
      urls.includes(undefined) ||
      (input.keyLocation !== undefined && keyLocation === undefined)
    ) {
      return;
    }
    const host = urls[0]?.host;
    if (urls.some((url) => url?.host !== host)) {
      ctx.addIssue({
        code: "custom",
        path: ["urls"],
        message: "All urls must be on one host. Call once per host.",
      });
      return;
    }
    if (
      keyLocation !== undefined &&
      input.urls.some((url) => !isCoveredBy(url, keyLocation.href))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["keyLocation"],
        message:
          "keyLocation must be on the same host as the urls, in their directory or above.",
      });
    }
  });

export function registerSubmitUrlsTool(
  server: McpServer,
  getClient: IndexNowClientProvider,
): void {
  server.registerTool(
    "submit_urls",
    {
      title: "Submit URLs to IndexNow",
      description:
        "Notify IndexNow search engines (Bing, Yandex, Seznam, Naver and others; not Google) that URLs on one host were " +
        "added, updated or deleted. Only for projects that contain an IndexNow key file. Up to 10,000 URLs per call. " +
        "Returns as soon as the URLs are queued: in the background the server checks that the live site serves the " +
        "key file, then submits them, batched per host and retried when IndexNow rate-limits. Use verify_key to check " +
        "the key file now.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ urls, key, keyLocation }) => {
      try {
        const client = await getClient();
        const urlList = [...new Set(urls)];
        const first = urlList[0] as string;
        const host = new URL(first).hostname;
        await client.enqueue({
          host,
          key,
          ...(keyLocation && { keyLocation }),
          urlList,
        });
        const result = {
          host,
          queued: urlList.length,
          note:
            "Queued. The server checks the key file and submits in the background, retrying if the key file is " +
            "not live yet or IndexNow rate-limits; nothing more to do.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toToolError("submit_urls", error);
      }
    },
  );
}
