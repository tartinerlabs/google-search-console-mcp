import { describe, expect, it, vi } from "vitest";
import { IndexNowApiError } from "../src/utils/errors.ts";
import { createTestClient, mockClient } from "./helpers.ts";

const KEY = "test-key-not-secret";
const keyFile = (status = 200, text = KEY) =>
  vi.fn().mockResolvedValue({ status, text });

describe("submit_urls", () => {
  it("should check the root key file, then submit the deduplicated urls", async () => {
    const fetchKeyFile = keyFile(200, `${KEY}\n`);
    const submit = vi.fn().mockResolvedValue(200);
    const { callTool } = createTestClient(mockClient({ fetchKeyFile, submit }));

    const result = await callTool("submit_urls", {
      urls: [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/a",
      ],
      key: KEY,
    });

    expect(result.isError).toBe(false);
    expect(fetchKeyFile).toHaveBeenCalledWith(`https://example.com/${KEY}.txt`);
    expect(submit).toHaveBeenCalledWith({
      host: "example.com",
      key: KEY,
      urlList: ["https://example.com/a", "https://example.com/b"],
    });
    expect(JSON.parse(result.text)).toMatchObject({
      host: "example.com",
      submitted: 2,
      status: 200,
    });
  });

  it("should pass keyLocation through when the key file is not at the root", async () => {
    const keyLocation = `https://example.com/blog/${KEY}.txt`;
    const fetchKeyFile = keyFile();
    const submit = vi.fn().mockResolvedValue(202);
    const { callTool } = createTestClient(mockClient({ fetchKeyFile, submit }));

    const result = await callTool("submit_urls", {
      urls: ["https://example.com/blog/post"],
      key: KEY,
      keyLocation,
    });

    expect(fetchKeyFile).toHaveBeenCalledWith(keyLocation);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ keyLocation }),
    );
    expect(JSON.parse(result.text).note).toContain("will validate the key");
  });

  it.each([
    ["missing", keyFile(404, "Not Found"), "not found"],
    ["redirected", keyFile(308, ""), "redirects"],
    [
      "holding another key",
      keyFile(200, "something-else"),
      "does not contain the key",
    ],
  ])(
    "should submit nothing when the key file is %s",
    async (_label, fetchKeyFile, expected) => {
      const submit = vi.fn();
      const { callTool } = createTestClient(
        mockClient({ fetchKeyFile, submit }),
      );

      const result = await callTool("submit_urls", {
        urls: ["https://example.com/a"],
        key: KEY,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^\[not_found\]/);
      expect(result.text).toContain(expected);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("should report IndexNow's rate limit as a quota error", async () => {
    const submit = vi.fn().mockRejectedValue(new IndexNowApiError(429, ""));
    const { callTool } = createTestClient(
      mockClient({ fetchKeyFile: keyFile(), submit }),
    );

    const result = await callTool("submit_urls", {
      urls: ["https://example.com/a"],
      key: KEY,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[quota\]/);
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
