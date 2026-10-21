import { describe, expect, it, vi } from "vitest";
import { type SubmitRequest, toMessages } from "../src/indexnow/client.ts";
import {
  type ConsumerDeps,
  handleQueue,
  type QueueMessage,
} from "../src/queue.ts";
import { IndexNowApiError } from "../src/utils/errors.ts";

const KEY = "test-key-not-secret";

/** A live root key file, and an IndexNow POST that answers with `submit`. */
function deps(
  submit: ConsumerDeps["submit"],
  keyFile = { status: 200, text: KEY },
) {
  return { fetchKeyFile: vi.fn().mockResolvedValue(keyFile), submit };
}

function message(body: Partial<SubmitRequest>, attempts = 1): QueueMessage {
  return {
    body: { host: "example.com", key: KEY, urlList: [], ...body },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("handleQueue", () => {
  it("should merge messages for one host into a single deduplicated POST", async () => {
    const messages = [
      message({ urlList: ["https://example.com/a", "https://example.com/b"] }),
      message({ urlList: ["https://example.com/b", "https://example.com/c"] }),
      message({ host: "other.com", urlList: ["https://other.com/a"] }),
    ];
    const submit = vi.fn().mockResolvedValue(200);

    await handleQueue({ messages }, deps(submit));

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith({
      host: "example.com",
      key: KEY,
      urlList: [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ],
    });
    for (const m of messages) expect(m.ack).toHaveBeenCalled();
  });

  it("should not merge messages with different key locations", async () => {
    const messages = [
      message({ urlList: ["https://example.com/a"] }),
      message({
        keyLocation: `https://example.com/blog/${KEY}.txt`,
        urlList: ["https://example.com/blog/a"],
      }),
    ];
    const submit = vi.fn().mockResolvedValue(200);

    await handleQueue({ messages }, deps(submit));

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("should keep each POST within 10,000 urls", async () => {
    const urls = (prefix: string) =>
      Array.from(
        { length: 6000 },
        (_, i) => `https://example.com/${prefix}${i}`,
      );
    const messages = [
      message({ urlList: urls("a") }),
      message({ urlList: urls("b") }),
    ];
    const submit = vi.fn().mockResolvedValue(200);

    await handleQueue({ messages }, deps(submit));

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("should retry after IndexNow's Retry-After on a rate limit", async () => {
    const m = message({ urlList: ["https://example.com/a"] });
    const submit = vi
      .fn()
      .mockRejectedValue(new IndexNowApiError(429, "", 120));

    await handleQueue({ messages: [m] }, deps(submit));

    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(m.ack).not.toHaveBeenCalled();
  });

  it("should back off exponentially without Retry-After", async () => {
    const m = message({ urlList: ["https://example.com/a"] }, 3);
    const submit = vi.fn().mockRejectedValue(new IndexNowApiError(503, ""));

    await handleQueue({ messages: [m] }, deps(submit));

    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });

  it("should drop a submission IndexNow rejects", async () => {
    const m = message({ urlList: ["https://example.com/a"] });
    const submit = vi.fn().mockRejectedValue(new IndexNowApiError(403, ""));

    await handleQueue({ messages: [m] }, deps(submit));

    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
  });
});

describe("handleQueue key file check", () => {
  it("should check the root key file before submitting", async () => {
    const m = message({ urlList: ["https://example.com/a"] });
    const consumer = deps(vi.fn().mockResolvedValue(200));

    await handleQueue({ messages: [m] }, consumer);

    expect(consumer.fetchKeyFile).toHaveBeenCalledWith(
      `https://example.com/${KEY}.txt`,
    );
    expect(m.ack).toHaveBeenCalled();
  });

  it("should check keyLocation when given", async () => {
    const keyLocation = `https://example.com/blog/${KEY}.txt`;
    const m = message({ keyLocation, urlList: ["https://example.com/blog/a"] });
    const consumer = deps(vi.fn().mockResolvedValue(202));

    await handleQueue({ messages: [m] }, consumer);

    expect(consumer.fetchKeyFile).toHaveBeenCalledWith(keyLocation);
    expect(consumer.submit).toHaveBeenCalledWith(
      expect.objectContaining({ keyLocation }),
    );
  });

  it.each([
    ["missing", { status: 404, text: "Not Found" }],
    ["redirected", { status: 308, text: "" }],
    ["holding another key", { status: 200, text: "something-else" }],
  ])(
    "should retry without submitting when the key file is %s",
    async (_label, keyFile) => {
      const m = message({ urlList: ["https://example.com/a"] });
      const submit = vi.fn();

      await handleQueue({ messages: [m] }, deps(submit, keyFile));

      expect(submit).not.toHaveBeenCalled();
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(m.ack).not.toHaveBeenCalled();
    },
  );
});

describe("toMessages", () => {
  it("should split a large submission to fit the queue message limit", () => {
    const urlList = Array.from(
      { length: 10_000 },
      (_, i) => `https://example.com/some/fairly/long/path/${i}`,
    );
    const messages = toMessages({ host: "example.com", key: KEY, urlList });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.flatMap((m) => m.urlList)).toEqual(urlList);
    for (const m of messages) {
      expect(new TextEncoder().encode(JSON.stringify(m)).length).toBeLessThan(
        128_000,
      );
    }
  });
});
