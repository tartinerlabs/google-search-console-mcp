import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.ts";
import { createTestClient, mcpRequest, mockClient } from "./helpers.ts";

const KEY = "test-key-not-secret";
const keyFile = (status = 200, text = KEY) =>
  vi.fn().mockResolvedValue({ status, text });

const ID = "4b3f3b52-6a0c-4f43-9a51-8b1f0e2d7c11";
const running = { status: "running" } as const;
const complete = (status = 200) =>
  ({
    status: "complete",
    output: { host: "example.com", submitted: 2, status },
  }) as const;

describe("submit_urls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Calls submit_urls with fake timers, running out the wait. */
  async function submit(
    client: Parameters<typeof mockClient>[0],
    args: Record<string, unknown> = {},
  ) {
    vi.useFakeTimers();
    const { callTool } = createTestClient(mockClient(client));
    const pending = callTool("submit_urls", {
      urls: ["https://example.com/a"],
      key: KEY,
      ...args,
    });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    return pending;
  }

  it("should start a submission for the deduplicated urls and return its outcome", async () => {
    const startSubmission = vi.fn().mockResolvedValue(ID);
    const getSubmission = vi
      .fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValue(complete());

    const result = await submit(
      { startSubmission, getSubmission },
      {
        urls: [
          "https://example.com/a",
          "https://example.com/b",
          "https://example.com/a",
        ],
      },
    );

    expect(result.isError).toBe(false);
    expect(startSubmission).toHaveBeenCalledWith({
      host: "example.com",
      key: KEY,
      urlList: ["https://example.com/a", "https://example.com/b"],
    });
    expect(getSubmission).toHaveBeenCalledWith(ID);
    expect(JSON.parse(result.text)).toEqual({
      submissionId: ID,
      host: "example.com",
      submitted: 2,
      status: 200,
      note: "Accepted.",
    });
  });

  it("should pass keyLocation through when the key file is not at the root", async () => {
    const keyLocation = `https://example.com/blog/${KEY}.txt`;
    const startSubmission = vi.fn().mockResolvedValue(ID);

    const result = await submit(
      {
        startSubmission,
        getSubmission: vi.fn().mockResolvedValue(complete(202)),
      },
      { urls: ["https://example.com/blog/post"], keyLocation },
    );

    expect(startSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ keyLocation }),
    );
    expect(JSON.parse(result.text).note).toContain("will validate the key");
  });

  it("should report a failed submission's classified error", async () => {
    const result = await submit({
      startSubmission: vi.fn().mockResolvedValue(ID),
      getSubmission: vi.fn().mockResolvedValue({
        status: "errored",
        error: {
          name: "Error",
          message: "[not_found] https://example.com/k.txt was not found",
        },
      }),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[not_found\] .*was not found/);
  });

  it("should return the submissionId when it is still retrying after 10 minutes", async () => {
    const getSubmission = vi.fn().mockResolvedValue(running);

    const result = await submit({
      startSubmission: vi.fn().mockResolvedValue(ID),
      getSubmission,
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      submissionId: ID,
      status: "running",
    });
    expect(getSubmission.mock.calls.length).toBeGreaterThan(100);
  });

  it("should stream progress while the submission runs", async () => {
    vi.useFakeTimers();
    const handler = createMcpHandler(
      () =>
        createServer(
          mockClient({
            startSubmission: vi.fn().mockResolvedValue(ID),
            getSubmission: vi
              .fn()
              .mockResolvedValueOnce(running)
              .mockResolvedValue(complete()),
          }),
        ),
      { legacy: "reject" },
    );
    const response = handler.fetch(
      mcpRequest("tools/call", {
        name: "submit_urls",
        arguments: { urls: ["https://example.com/a"], key: KEY },
        _meta: { progressToken: "submit-1" },
      }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const body = (await response).text();
    await vi.advanceTimersByTimeAsync(20_000);

    const text = await body;
    expect(text).toContain('"method":"notifications/progress"');
    expect(text).toContain("Submission running");
    expect(text).toContain(ID);
  });
});

describe("submission_status", () => {
  it("should report a running submission", async () => {
    const { callTool } = createTestClient(
      mockClient({ getSubmission: vi.fn().mockResolvedValue(running) }),
    );

    const result = await callTool("submission_status", { submissionId: ID });

    expect(JSON.parse(result.text)).toMatchObject({ status: "running" });
  });

  it("should report a completed submission's outcome", async () => {
    const { callTool } = createTestClient(
      mockClient({ getSubmission: vi.fn().mockResolvedValue(complete()) }),
    );

    const result = await callTool("submission_status", { submissionId: ID });

    expect(JSON.parse(result.text)).toMatchObject({
      submissionId: ID,
      status: 200,
    });
  });

  it("should report an unknown id as not found", async () => {
    const { callTool } = createTestClient(
      mockClient({ getSubmission: vi.fn().mockResolvedValue(undefined) }),
    );

    const result = await callTool("submission_status", { submissionId: ID });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[not_found\]/);
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
