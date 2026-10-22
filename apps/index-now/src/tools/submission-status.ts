import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { IndexNowClientProvider, Submission } from "../indexnow/client.ts";
import type { SubmissionOutput } from "../indexnow/submission.ts";
import { toToolError } from "../utils/errors.ts";

const KIND_PREFIX = /^\[[a-z_]+\] /;

function text(value: unknown, isError = false): CallToolResult {
  return {
    ...(isError && { isError }),
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorText(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: KIND_PREFIX.test(message) ? message : `[unexpected] ${message}`,
      },
    ],
  };
}

/** The tool result for a finished submission, or undefined while it is still running. */
export function finishedSubmission(
  submissionId: string,
  submission: Submission | undefined,
): CallToolResult | undefined {
  if (!submission || submission.status === "unknown") {
    return errorText(
      `[not_found] No submission ${submissionId}. Finished submissions are kept for 3 days on the Workers Free plan and 30 days on Paid.`,
    );
  }
  if (submission.status === "complete") {
    const output = submission.output as SubmissionOutput;
    return text({
      submissionId,
      ...output,
      // 202: received, with IndexNow's own key check still pending.
      note:
        output.status === 202
          ? "Accepted; IndexNow will validate the key before processing."
          : "Accepted.",
    });
  }
  if (submission.status === "errored") {
    return errorText(submission.error?.message ?? "The submission failed.");
  }
  if (submission.status === "terminated") {
    return errorText("The submission was cancelled before it finished.");
  }
  return undefined;
}

export function registerSubmissionStatusTool(
  server: McpServer,
  getClient: IndexNowClientProvider,
): void {
  server.registerTool(
    "submission_status",
    {
      title: "Check an IndexNow submission",
      description:
        "Report the outcome of a submit_urls call that was still retrying when it returned, by its submissionId.",
      inputSchema: z.object({
        submissionId: z
          .string()
          .uuid()
          .describe("The submissionId returned by submit_urls."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ submissionId }) => {
      try {
        const client = await getClient();
        const submission = await client.getSubmission(submissionId);
        return (
          finishedSubmission(submissionId, submission) ??
          text({
            submissionId,
            status: "running",
            note: "Still waiting for the key file or retrying IndexNow. Check again later.",
          })
        );
      } catch (error) {
        return toToolError("submission_status", error);
      }
    },
  );
}
