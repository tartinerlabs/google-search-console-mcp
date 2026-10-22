import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
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
import { finishedSubmission } from "./submission-status.ts";

// IndexNow accepts up to 10,000 URLs in one POST.
const MAX_URLS = 10_000;
const POLL_MS = 5_000;
// How long one call waits for the Workflow. Claude Code moves a call still
// running after two minutes to the background, so this does not block the
// agent; past it, the submission carries on and submission_status reports it.
const MAX_WAIT_MS = 10 * 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Sends `notifications/progress` when the client asked for it with a progressToken. */
function progressReporter(ctx: ServerContext) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  const started = Date.now();
  return async (message: string) => {
    if (progressToken === undefined) return;
    await ctx.mcpReq
      .notify({
        method: "notifications/progress",
        params: {
          progressToken,
          // Seconds elapsed: always increasing, with no known total.
          progress: Math.round((Date.now() - started) / 1000),
          message,
        },
      })
      .catch(() => {});
  };
}

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
        "The submission runs durably on the server: it waits for the live site to serve the key file and retries when " +
        "IndexNow is unavailable, reporting progress, and returns the outcome. A rate limit fails at once; do not " +
        "resubmit soon after one. If it is still retrying after 10 minutes, " +
        "the call returns a submissionId to check later with submission_status.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ urls, key, keyLocation }, ctx) => {
      try {
        const client = await getClient();
        const urlList = [...new Set(urls)];
        const host = new URL(urlList[0] as string).hostname;
        const submissionId = await client.startSubmission({
          host,
          key,
          ...(keyLocation && { keyLocation }),
          urlList,
        });
        const report = progressReporter(ctx);
        const deadline = Date.now() + MAX_WAIT_MS;

        // A dropped connection ends only this wait; the Workflow carries on.
        while (Date.now() < deadline) {
          await sleep(POLL_MS, ctx.mcpReq.signal);
          const submission = await client.getSubmission(submissionId);
          const finished = finishedSubmission(submissionId, submission);
          if (finished) return finished;
          await report(
            `Submission ${submission?.status}: waiting for the key file or retrying IndexNow.`,
          );
        }
        const pending = {
          submissionId,
          host,
          status: "running",
          note: "Still retrying in the background. Check later with submission_status.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(pending, null, 2) }],
        };
      } catch (error) {
        return toToolError("submit_urls", error);
      }
    },
  );
}
