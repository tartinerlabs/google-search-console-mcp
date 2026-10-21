import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { IndexNowClientProvider } from "./indexnow/client.ts";
import { registerSubmitUrlsTool } from "./tools/submit-urls.ts";
import { registerVerifyKeyTool } from "./tools/verify-key.ts";

const SERVER_NAME = "index-now";
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Submits changed URLs to IndexNow (Bing, Yandex, Seznam, Naver and others; not Google).

Use it only in projects that contain an IndexNow key file: a .txt file served at the site root (for example public/<key>.txt or static/<key>.txt) whose name is 8 to 128 letters, digits or dashes and whose contents are exactly that name. The name without .txt is the key. If the project has no such file, do not call submit_urls and do not create a key file unless the user asks.

When to submit: after the user's changes to public pages are deployed to production, submit the production URLs that were added, updated or deleted, in one call per host. Do not submit before the deploy is live, for preview or localhost URLs, for unchanged pages, or the same URLs repeatedly. Use verify_key first when unsure whether the key file is live.`;

/** Server factory for the HTTP handler. */
export function createServer(getClient: IndexNowClientProvider): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Check whether the IndexNow MCP server is running.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [{ type: "text", text: "IndexNow MCP is running." }],
    }),
  );

  registerVerifyKeyTool(server, getClient);
  registerSubmitUrlsTool(server, getClient);

  return server;
}
