import { IndexNowApiError } from "../utils/errors.ts";

/** The JSON body of an IndexNow submission. */
export interface SubmitRequest {
  host: string;
  key: string;
  keyLocation?: string;
  urlList: string[];
}

export interface KeyFileResponse {
  status: number;
  text: string;
}

/** The producer side of the Cloudflare Queue binding that buffers submissions. */
export interface SubmissionQueue {
  send(body: SubmitRequest): Promise<unknown>;
}

/** The HTTP operations the MCP tools depend on. */
export interface IndexNowClient {
  /** Fetches a key file without following redirects. */
  fetchKeyFile(url: string): Promise<KeyFileResponse>;
  /** Queues URLs for the consumer to submit; resolves the number of queue messages. */
  enqueue(request: SubmitRequest): Promise<number>;
}

/** Resolves the client lazily, inside each tool call, as the other servers do. */
export type IndexNowClientProvider = () =>
  | IndexNowClient
  | Promise<IndexNowClient>;

// Shared endpoint: every participating search engine receives the submission.
const INDEXNOW_URL = "https://api.indexnow.org/indexnow";
const TIMEOUT_MS = 30_000;
// A key file holds at most 128 characters; anything much longer is not one.
const MAX_KEY_FILE_LENGTH = 1024;
// Queue messages are capped at 128 KB; leave room for the rest of the body.
const MAX_MESSAGE_URL_BYTES = 100_000;

const encoder = new TextEncoder();

/** Splits a submission into queue messages that each fit the message size limit. */
export function toMessages(request: SubmitRequest): SubmitRequest[] {
  const messages: SubmitRequest[] = [];
  let urlList: string[] = [];
  let bytes = 0;
  for (const url of request.urlList) {
    const size = encoder.encode(url).length + 3;
    if (urlList.length > 0 && bytes + size > MAX_MESSAGE_URL_BYTES) {
      messages.push({ ...request, urlList });
      urlList = [];
      bytes = 0;
    }
    urlList.push(url);
    bytes += size;
  }
  messages.push({ ...request, urlList });
  return messages;
}

/** Fetches a key file without following redirects. */
export async function fetchKeyFile(url: string): Promise<KeyFileResponse> {
  // Redirects are not followed, so a user-supplied host cannot steer the
  // request elsewhere.
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = (await response.text()).slice(0, MAX_KEY_FILE_LENGTH);
  return { status: response.status, text };
}

/** Submits URLs and resolves the IndexNow status code (200 or 202). */
export async function submitToIndexNow(
  request: SubmitRequest,
): Promise<number> {
  const response = await fetch(INDEXNOW_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new IndexNowApiError(
      response.status,
      text,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return response.status;
}

export function createIndexNowClient(queue: SubmissionQueue): IndexNowClient {
  return {
    fetchKeyFile,
    async enqueue(request) {
      const messages = toMessages(request);
      await Promise.all(messages.map((message) => queue.send(message)));
      return messages.length;
    },
  };
}
