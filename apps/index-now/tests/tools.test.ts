import { describe, expect, it, vi } from "vitest";
import { createTestClient, mockClient } from "./helpers.ts";

const KEY = "test-key-not-secret";
const keyFile = (status = 200, text = KEY) =>
  vi.fn().mockResolvedValue({ status, text });

describe("submit_urls", () => {
  it("should queue the deduplicated urls without fetching the key file", async () => {
    const fetchKeyFile = vi.fn();
    const enqueue = vi.fn().mockResolvedValue(1);
    const { callTool } = createTestClient(
      mockClient({ fetchKeyFile, enqueue }),
    );

    const result = await callTool("submit_urls", {
      urls: [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/a",
      ],
      key: KEY,
    });

    expect(result.isError).toBe(false);
    expect(fetchKeyFile).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith({
      host: "example.com",
      key: KEY,
      urlList: ["https://example.com/a", "https://example.com/b"],
    });
    expect(JSON.parse(result.text)).toMatchObject({
      host: "example.com",
      queued: 2,
    });
  });

  it("should pass keyLocation through when the key file is not at the root", async () => {
    const keyLocation = `https://example.com/blog/${KEY}.txt`;
    const enqueue = vi.fn().mockResolvedValue(1);
    const { callTool } = createTestClient(mockClient({ enqueue }));

    const result = await callTool("submit_urls", {
      urls: ["https://example.com/blog/post"],
      key: KEY,
      keyLocation,
    });

    expect(result.isError).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ keyLocation }),
    );
  });
});

describe("verify_key", () => {
  it("should report a live key file as valid", async () => {
    const { callTool } = createTestClient(
      mockClient({ fetchKeyFile: keyFile() }),
    );

    const result = await callTool("verify_key", {
      url: "https://example.com/some/page",
      key: KEY,
    });

    expect(JSON.parse(result.text)).toEqual({
      valid: true,
      keyLocation: `https://example.com/${KEY}.txt`,
    });
  });

  it("should explain why a key file fails, without erroring", async () => {
    const { callTool } = createTestClient(
      mockClient({ fetchKeyFile: keyFile(404, "") }),
    );

    const result = await callTool("verify_key", {
      url: "https://example.com",
      key: KEY,
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ valid: false });
  });
});
