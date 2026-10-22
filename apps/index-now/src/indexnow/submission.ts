import { classifyError, IndexNowApiError } from "../utils/errors.ts";
import type { KeyFileResponse, SubmitRequest } from "./client.ts";
import { checkKeyFile, keyFileUrl } from "./key.ts";

/** What a completed submission Workflow outputs. */
export interface SubmissionOutput {
  host: string;
  submitted: number;
  status: number;
}

/** The parts of a Workflow step the submission uses. */
export interface SubmissionStep {
  do<T>(
    name: string,
    config: {
      retries: {
        limit: number;
        delay:
          | string
          | ((options: { ctx: { attempt: number }; error: Error }) => string);
        backoff?: "constant" | "linear" | "exponential";
      };
      timeout: string;
    },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface SubmissionDeps {
  fetchKeyFile(url: string): Promise<KeyFileResponse>;
  submit(request: SubmitRequest): Promise<number>;
}

const RETRY_AFTER = /retry after (\d+)s/;
const MAX_DELAY_SECONDS = 3600;

/** IndexNow's Retry-After, carried in the step error's message, else exponential from 30 seconds. */
export function submitRetryDelay({
  ctx,
  error,
}: {
  ctx: { attempt: number };
  error: Error;
}): string {
  const retryAfter = RETRY_AFTER.exec(error.message)?.[1];
  const seconds = retryAfter
    ? Number(retryAfter)
    : 30 * 2 ** Math.max(0, ctx.attempt - 1);
  return `${Math.min(seconds, MAX_DELAY_SECONDS)} seconds`;
}

/**
 * The submission Workflow's steps: wait for the key file to be live, then
 * POST to IndexNow. Failures that can pass (the deploy still going live,
 * outages) throw inside a step so the Workflow retries it; rate limits and
 * rejections end the run with the classified error, since retrying a throttled
 * host only prolongs the throttle.
 */
export async function runSubmission(
  request: SubmitRequest,
  step: SubmissionStep,
  deps: SubmissionDeps,
): Promise<SubmissionOutput> {
  const { host, key, keyLocation, urlList } = request;
  const location = keyFileUrl(urlList[0] as string, key, keyLocation);

  // 15s, 30s, … 8 minutes: about 16 minutes for a deploy to go live.
  await step.do(
    "check key file",
    {
      retries: { limit: 6, delay: "15 seconds", backoff: "exponential" },
      timeout: "1 minute",
    },
    async () => {
      const failure = await checkKeyFile(deps, location, key);
      if (failure) throw new Error(`[not_found] ${failure}`);
    },
  );

  const outcome = await step.do(
    "submit to IndexNow",
    {
      retries: { limit: 6, delay: submitRetryDelay },
      timeout: "1 minute",
    },
    async () => {
      try {
        return { status: await deps.submit(request) };
      } catch (error) {
        const { kind, message } = classifyError(error);
        if (kind === "unavailable" || kind === "network") {
          const retryAfter =
            error instanceof IndexNowApiError && error.retryAfter
              ? ` retry after ${error.retryAfter}s`
              : "";
          throw new Error(`[${kind}] ${message}${retryAfter}`);
        }
        // Retrying cannot help; end the run outside the step.
        return { rejected: `[${kind}] ${message}` };
      }
    },
  );

  if ("rejected" in outcome) throw new Error(outcome.rejected);
  return { host, submitted: urlList.length, status: outcome.status };
}
