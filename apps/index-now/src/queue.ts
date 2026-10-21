import {
  fetchKeyFile,
  type KeyFileResponse,
  type SubmitRequest,
  submitToIndexNow,
} from "./indexnow/client.ts";
import { checkKeyFile, keyFileUrl } from "./indexnow/key.ts";
import {
  classifyError,
  IndexNowApiError,
  KeyFileError,
} from "./utils/errors.ts";
import { logger } from "./utils/logger.ts";

/** The parts of a Cloudflare Queues message the consumer uses. */
export interface QueueMessage {
  readonly body: SubmitRequest;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatch {
  readonly messages: readonly QueueMessage[];
}

// IndexNow accepts up to 10,000 URLs in one POST.
const MAX_URLS = 10_000;
const BASE_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;
// Rate limits, IndexNow outages and network failures can pass, as can a key
// file that is not live yet; rejections will not.
const RETRYABLE = new Set(["quota", "unavailable", "network"]);

/** The network calls the consumer makes; tests pass mocks. */
export interface ConsumerDeps {
  fetchKeyFile(url: string): Promise<KeyFileResponse>;
  submit(request: SubmitRequest): Promise<number>;
}

const defaultDeps: ConsumerDeps = { fetchKeyFile, submit: submitToIndexNow };

interface Group {
  request: SubmitRequest;
  urls: Set<string>;
  messages: QueueMessage[];
}

/** Merges messages for the same host, key and keyLocation into as few POSTs as fit the URL limit. */
function groupMessages(messages: readonly QueueMessage[]): Group[] {
  const open = new Map<string, Group>();
  const groups: Group[] = [];
  for (const message of messages) {
    const { host, key, keyLocation, urlList } = message.body;
    const id = JSON.stringify([host, key, keyLocation]);
    let group = open.get(id);
    const added = urlList.filter((url) => !group?.urls.has(url)).length;
    if (!group || group.urls.size + added > MAX_URLS) {
      group = { request: message.body, urls: new Set(), messages: [] };
      open.set(id, group);
      groups.push(group);
    }
    for (const url of urlList) group.urls.add(url);
    group.messages.push(message);
  }
  return groups;
}

/** How long to wait before retrying: IndexNow's Retry-After, else exponential from one minute. */
function retryDelay(error: unknown, attempts: number): number {
  if (error instanceof IndexNowApiError && error.retryAfter !== undefined) {
    return Math.min(Math.ceil(error.retryAfter), MAX_DELAY_SECONDS);
  }
  return Math.min(BASE_DELAY_SECONDS * 2 ** (attempts - 1), MAX_DELAY_SECONDS);
}

/**
 * The Queues consumer: checks each host group's key file, then sends one
 * IndexNow POST, retrying with backoff when it can succeed later.
 */
export async function handleQueue(
  batch: QueueBatch,
  deps: ConsumerDeps = defaultDeps,
): Promise<void> {
  for (const { request, urls, messages } of groupMessages(batch.messages)) {
    const { host, key, keyLocation } = request;
    try {
      const location = keyFileUrl([...urls][0] as string, key, keyLocation);
      const failure = await checkKeyFile(deps, location, key);
      if (failure) throw new KeyFileError(failure);
      const status = await deps.submit({
        host,
        key,
        ...(keyLocation && { keyLocation }),
        urlList: [...urls],
      });
      for (const message of messages) message.ack();
      logger.info({ host, urls: urls.size, status }, "submitted to IndexNow");
    } catch (error) {
      const { kind, status } = classifyError(error);
      const retryable = error instanceof KeyFileError || RETRYABLE.has(kind);
      for (const message of messages) {
        if (retryable) {
          message.retry({
            delaySeconds: retryDelay(error, message.attempts),
          });
        } else {
          message.ack();
        }
      }
      logger.warn(
        { host, urls: urls.size, kind, status, retrying: retryable },
        "IndexNow submission failed",
      );
    }
  }
}
